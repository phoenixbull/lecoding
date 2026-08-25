/**
 * 多 PGlite 实例 cancel bus 测试骨架(跨进程 NOTIFY 隔离语义)。
 *
 * 背景(已实测 PGlite 0.5.5):
 * - PGlite 实例是独立的 WASM Postgres 内核,无 server/TCP 模式;
 *   两个实例间的 LISTEN/NOTIFY 不互通,共享 dataDir 并发运行期也不互通。
 * - 因此"多 PGlite 实例"无法模拟"多 worker 共享同一 PG server"(那是
 *   单实例多 session fixture 的职责);它恰好模拟真实世界里 service 隔离、
 *   cancelBus 跨 server 不可达的边界场景。
 *
 * 骨架断言:
 * 1. 隔离:worker-A publish 后 worker-B 的独立实例 listen 收不到(负向)。
 * 2. 心跳兜底:worker-B 的 cancel 命令把 run 写成 cancelled 终态
 *    (经共享 store 模拟"命令已落库、广播已丢"),worker-A 心跳
 *     tickCancellationFallback 兜底检测 → abort → perform reject。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPGliteMultiInstanceCluster } from "./helpers/pglite-multi-instance-cluster.js";
import {
  createRunEngine,
  createInMemoryRunHandleRegistry,
  createIntervalLeaseHeartbeat,
  createInMemoryRunLease,
  type RunStore,
  type AgentModelTurn,
  type AgentModelInput
} from "@lecoding/run-engine";
import type {
  EnvironmentAction,
  EnvironmentHandle,
  EnvironmentReport,
  EnvironmentResult,
  EnvironmentSpec,
  RunEventV1,
  RunId,
  VerificationReport
} from "@lecoding/contracts";
import type { RunEnvironment } from "@lecoding/run-environment";
import { createPolicyEngine } from "@lecoding/policy";
import { createInMemoryRunEventJournal } from "@lecoding/run-events";

type StoredRun = Parameters<RunStore["save"]>[0];

class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<RunId, StoredRun>();

  async save(run: StoredRun): Promise<number> {
    const existing = this.runs.get(run.id);
    this.runs.set(run.id, structuredClone({ ...run }));
    return run.version + 1;
  }

  async get(runId: RunId): Promise<StoredRun | undefined> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }
}

describe("PGlite multi-instance cancel bus (cross-server isolation)", () => {
  let cluster: Awaited<ReturnType<typeof createPGliteMultiInstanceCluster>>;

  beforeEach(async () => {
    cluster = await createPGliteMultiInstanceCluster();
  });

  afterEach(async () => {
    await cluster.close();
  });

  it("does NOT deliver NOTIFY across independent PGlite instances", async () => {
    /*
     * 负向隔离断言:两个 worker 各自持有独立 PGlite 实例,
     * worker-A publish 的 runId 绝不应出现在 worker-B 的 listen 里。
     * 这验证骨架的隔离边界——真实场景对应"cancelBus 跨 server 不可达"。
     */
    const busA = cluster.createBus("worker-A");
    const busB = cluster.createBus("worker-B");

    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const stopA = await busA.subscribe((runId) => receivedA.push(runId));
    const stopB = await busB.subscribe((runId) => receivedB.push(runId));

    await busA.publish("run-1");

    // NOTIFY 派发异步——给足够窗口;跨实例隔离下 A 应收、B 不应收
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(receivedA).toEqual(["run-1"]);
    expect(receivedB).toEqual([]);

    await stopA();
    await stopB();
  });

  it("cancel lands in shared store and worker-A heartbeat fallback aborts perform", async () => {
    /*
     * 端到端断连兜底:worker-A 与 worker-B 各自独立 PGlite 实例,
     * worker-B 的 cancel 命令的 NOTIFY 广播到不了 worker-A(cross-server
     * 隔离),但 cancel 命令同时把 run 写成终态 cancelled 并落到**共享
     * store**(等价于真实环境里所有 worker 共用同一 PG 库)。
     *
     * worker-A 的 perform 挂起,心跳 tickCancellationFallback 每次 tick
     * 读共享 store,发现终态后 handles.abort → perform reject →
     * RunCancelledByAbortError → markRunCancelled。
     *
     * 断点条件:worker-A 的 cancelBus 是它自己的 PGlite 实例——worker-B
     * 的 publish 永远到不了这里,除非心跳兜底接管。
     */
    const busA = cluster.createBus("worker-A");
    const busB = cluster.createBus("worker-B");

    /*
     * 跨进程隔离:多个 engine 只共享 store/lease/events(cancel 命令落库
     * 的共享数据面),而每个 engine 持有**独立**的 handles registry 与
     * environment——worker-B 的 cancel 命令无法直接 abort worker-A 的
     * perform,只能通过共享 store 写终态 + 自己的 PGlite publish(到不了
     * worker-A)。这与真实多进程部署的进程边界一致。
     */
    const store = new InMemoryRunStore();

    const makeWorker = (workerId: string, hangPerform: boolean) => {
      const handleRegistry = createInMemoryRunHandleRegistry();
      const abortCalls: RunId[] = [];
      let disposeCount = 0;
      const registry = {
        register: handleRegistry.register.bind(handleRegistry),
        borrow: handleRegistry.borrow.bind(handleRegistry),
        restore: handleRegistry.restore.bind(handleRegistry),
        abort: (runId: RunId) => {
          abortCalls.push(runId);
          return handleRegistry.abort(runId);
        },
        release: handleRegistry.release.bind(handleRegistry)
      };
      const environment: RunEnvironment = {
        async prepare(spec: EnvironmentSpec): Promise<EnvironmentHandle> {
          return {
            id: `${workerId}-handle-${spec.runId}`,
            environmentId: spec.environmentId
          };
        },
        async perform(
          _handle: EnvironmentHandle,
          _action: EnvironmentAction,
          signal?: AbortSignal
        ): Promise<EnvironmentResult> {
          if (!hangPerform) {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          // worker-A 的 perform 挂起到 abort:NOTIFY 隔离下只有心跳兜底能打断
          return new Promise<EnvironmentResult>((_resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error("aborted before perform started"));
              return;
            }
            signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted (heartbeat fallback)")),
              { once: true }
            );
          });
        },
        async inspect(_handle: EnvironmentHandle): Promise<EnvironmentReport> {
          return { changedFiles: [] };
        },
        async dispose(
          _handle: EnvironmentHandle,
          _outcome: "keep" | "discard"
        ): Promise<void> {
          disposeCount += 1;
        }
      };
      return {
        registry,
        environment,
        abortCalls,
        // getter 使外部断言能看到闭包内的增量,而不是构造时的快照
        get disposeCount(): number {
          return disposeCount;
        }
      };
    };

    const workerA = makeWorker("worker-A", true);
    const workerB = makeWorker("worker-B", false);
    const stubLease = {
      async acquire(_input?: { runId: string; ownerId: string }) {
        return {
          runId: "run-fallback" as RunId,
          ownerId: "test-worker",
          generation: 1
        };
      },
      async renew() {
        return true;
      },
      async release() {},
      async invalidate() {}
    };
    const model = {
      async next(_input: AgentModelInput): Promise<AgentModelTurn> {
        return {
          type: "tool_call",
          callId: "call-1",
          tool: "execute_command",
          arguments: { argv: ["sleep", "60"] }
        };
      }
    };
    const stubEvents = createInMemoryRunEventJournal({
      now: () => new Date().toISOString()
    }) as unknown as {
      publish(event: RunEventV1): Promise<RunEventV1>;
    };

    const engineA = await createRunEngine({
      store,
      model,
      environment: workerA.environment,
      policy: createPolicyEngine(),
      events: stubEvents,
      verifier: {
        async verify(): Promise<VerificationReport> {
          return {
            outcome: "passed",
            checks: [{ name: "trivial", outcome: "passed", detail: "ok" }]
          };
        }
      },
      handles: workerA.registry,
      lease: stubLease,
      heartbeat: createIntervalLeaseHeartbeat(stubLease as Parameters<typeof createIntervalLeaseHeartbeat>[0]),
      now: () => new Date().toISOString(),
      leaseMilliseconds: 40, // → heartbeatIntervalMs=20ms,worker-A 心跳快速触发兜底检测
      createId: () => "run-fallback" as RunId,
      cancelBus: busA,
      workerId: "worker-A"
    });
    const engineB = await createRunEngine({
      store,
      model,
      environment: workerB.environment,
      policy: createPolicyEngine(),
      events: stubEvents,
      verifier: {
        async verify(): Promise<VerificationReport> {
          return {
            outcome: "passed",
            checks: [{ name: "trivial", outcome: "passed", detail: "ok" }]
          };
        }
      },
      handles: workerB.registry,
      lease: stubLease,
      heartbeat: createIntervalLeaseHeartbeat(stubLease as Parameters<typeof createIntervalLeaseHeartbeat>[0]),
      now: () => new Date().toISOString(),
      leaseMilliseconds: 40,
      createId: () => "run-fallback" as RunId,
      cancelBus: busB,
      workerId: "worker-B"
    });

    const runId = await engineA.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Isolated fallback",
      acceptanceCriteria: ["Pass"],
      approvalMode: "full_access",
      fileAccessScope: "workspace_only"
    });

    const resumePromise = engineA.resume(runId);
    // 等 drive 进入 perform(挂起)
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // worker-B 触发 cancel:cancel 命令先 publish(到不了 worker-A),
    // 再把 store 写成终态 cancelled。
    await engineB.command(runId, { type: "cancel" }).catch(() => undefined);

    // 心跳兜底接管:store 终态 → tickCancellationFallback → abort
    await resumePromise;

    const finalRun = await store.get(runId);
    expect(finalRun?.status).toBe("cancelled");
    expect(workerA.abortCalls).toContain(runId);
    expect(workerA.disposeCount).toBeGreaterThanOrEqual(1);

    await engineA.dispose();
    await engineB.dispose();
  });
});