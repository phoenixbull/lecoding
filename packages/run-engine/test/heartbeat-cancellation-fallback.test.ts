/**
 * Phase-0 risk 1 收尾:心跳兜底取消检测的端到端验证。
 *
 * 场景:PG LISTEN/NOTIFY 广播不可用时(cancelBus 断线/消息丢失),
 * cancel 命令已通过 store 把 run 写成 "cancelled" 终态,但 perform 仍在跑。
 * worker 的心跳守护在每次 renewLease tick 时调 tickCancellationFallback,
 * 发现终态后拉起 AbortSignal → perform reject → RunCancelledByAbortError
 * → markRunCancelled(run 转 cancelled + dispose + release)。
 *
 * 本测试**不经过 cancelBus 广播路径**(它验证兜底,而非广播):
 * 直接对 store 写终态,模拟"NOTIFY 丢失但命令已落库"的最终一致性窗口。
 */
import { describe, it, expect } from "vitest";
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

function createStubEventJournal() {
  return {
    publish: async (event: RunEventV1): Promise<RunEventV1> => event
  };
}

describe("heartbeat cancellation fallback (NOTIFY-independent)", () => {
  it("aborts perform when store reaches 'cancelled' during a blocked perform", async () => {
    /*
     * 核心断言链:
     * 1. perform 挂起(blocked forever)
     * 2. 不发 cancel 命令、不发 cancelBus 广播——直接模拟"NOTIFY 丢失后,
     *    命令已落库":手动把 store 的 run 状态写成 "cancelled"
     * 3. heartbeat tick(interval=20ms)调 tickCancellationFallback → handles.abort
     * 4. perform 收到 AbortSignal reject → markRunCancelled
     * 5. 可观察:store.get(runId).status === "cancelled" + abortCalls 非空
     */
    const handleRegistry = createInMemoryRunHandleRegistry();
    const store = new InMemoryRunStore();
    const abortCalls: RunId[] = [];
    const wrappedRegistry = {
      register: handleRegistry.register.bind(handleRegistry),
      borrow: handleRegistry.borrow.bind(handleRegistry),
      restore: handleRegistry.restore.bind(handleRegistry),
      abort: (runId: RunId) => {
        abortCalls.push(runId);
        return handleRegistry.abort(runId);
      },
      release: handleRegistry.release.bind(handleRegistry)
    };
    let disposeCount = 0;
    const spyEnv: RunEnvironment = {
      async prepare(spec: EnvironmentSpec): Promise<EnvironmentHandle> {
        return {
          id: `handle-${spec.runId}`,
          environmentId: spec.environmentId
        };
      },
      async perform(
        _handle: EnvironmentHandle,
        _action: EnvironmentAction,
        signal?: AbortSignal
      ): Promise<EnvironmentResult> {
        return new Promise<EnvironmentResult>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error("aborted before perform started"));
            return;
          }
          signal?.addEventListener("abort", () => {
            reject(new Error("aborted (heartbeat fallback)"));
          }, { once: true });
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
    const lease = createInMemoryRunLease();
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
    const engine = await createRunEngine({
      store,
      model,
      environment: spyEnv,
      policy: createPolicyEngine(),
      events: createStubEventJournal(),
      verifier: {
        async verify(): Promise<VerificationReport> {
          return {
            outcome: "passed",
            checks: [{ name: "trivial", outcome: "passed", detail: "ok" }]
          };
        }
      },
      handles: wrappedRegistry,
      lease,
      heartbeat: createIntervalLeaseHeartbeat(lease),
      workerId: "worker-A",
      now: () => new Date().toISOString(),
      leaseMilliseconds: 40, // 40ms lease → heartbeatIntervalMs=20ms,tick 快速触发候选检测
      createId: () => "run-1" as RunId
    });

    const runId = await engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Fallback test",
      acceptanceCriteria: ["Pass"],
      approvalMode: "full_access",
      fileAccessScope: "workspace_only"
    });

    const resumePromise = engine.resume(runId);

    // 等 drive 进入 perform(挂起)
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    /*
     * 模拟 NOTIFY 丢失:cancel 命令已落库但订阅未收到。
     * 人工把 store 状态置为终态 cancelled——等价于命令路径的 transition。
     */
    const currentRun = await store.get(runId);
    if (!currentRun) {
      throw new Error("run not found in store");
    }
    // 直接覆盖已持久化的 run 状态(绕开 engine 内部 token 校验,模拟外部命令)
    await store.save({
      ...currentRun,
      status: "cancelled"
    });

    /*
     * 心跳 interval=20ms,store 已写终态后至多 20ms 内
     * tickCancellationFallback 观察到并 abort perform。
     */
    await resumePromise;

    const finalRun = await store.get(runId);
    expect(finalRun?.status).toBe("cancelled");
    expect(abortCalls).toContain(runId);
    expect(disposeCount).toBeGreaterThanOrEqual(1);
    await engine.dispose();
  });

  it("does not abort when run is in a non-terminal status", async () => {
    /*
     * 守卫:perform 期间 run 状态为 running(正常)或 preparing,
     * tickCancellationFallback 不应 abort——避免误杀正常执行的 run。
     */
    const handleRegistry = createInMemoryRunHandleRegistry();
    const store = new InMemoryRunStore();
    const abortCalls: RunId[] = [];
    const wrappedRegistry = {
      register: handleRegistry.register.bind(handleRegistry),
      borrow: handleRegistry.borrow.bind(handleRegistry),
      restore: handleRegistry.restore.bind(handleRegistry),
      abort: (runId: RunId) => {
        abortCalls.push(runId);
        return handleRegistry.abort(runId);
      },
      release: handleRegistry.release.bind(handleRegistry)
    };
    let disposeCount = 0;
    const spyEnv: RunEnvironment = {
      async prepare(spec: EnvironmentSpec): Promise<EnvironmentHandle> {
        return {
          id: `handle-${spec.runId}`,
          environmentId: spec.environmentId
        };
      },
      async perform(
        _handle: EnvironmentHandle,
        _action: EnvironmentAction,
        signal?: AbortSignal
      ): Promise<EnvironmentResult> {
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        return { exitCode: 0, stdout: "", stderr: "" };
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
    const lease = createInMemoryRunLease();
    let modelCalls = 0;
    const model = {
      async next(_input: AgentModelInput): Promise<AgentModelTurn> {
        modelCalls += 1;
        if (modelCalls > 1) {
          return { type: "completed", summary: "done" };
        }
        return {
          type: "tool_call",
          callId: "call-1",
          tool: "execute_command",
          arguments: { argv: ["echo", "hi"] }
        };
      }
    };
    const engine = await createRunEngine({
      store,
      model,
      environment: spyEnv,
      policy: createPolicyEngine(),
      events: createStubEventJournal(),
      verifier: {
        async verify(): Promise<VerificationReport> {
          return {
            outcome: "passed",
            checks: [{ name: "trivial", outcome: "passed", detail: "ok" }]
          };
        }
      },
      handles: wrappedRegistry,
      lease,
      heartbeat: createIntervalLeaseHeartbeat(lease),
      workerId: "worker-A",
      now: () => new Date().toISOString(),
      leaseMilliseconds: 40, // 40ms lease → heartbeatIntervalMs=20ms,tick 快速触发候选检测
      createId: () => "run-2" as RunId
    });

    const runId = await engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "No false abort",
      acceptanceCriteria: ["Pass"],
      approvalMode: "full_access",
      fileAccessScope: "workspace_only"
    });

    await engine.resume(runId);

    const finalRun = await store.get(runId);
    expect(abortCalls).not.toContain(runId);
    expect(finalRun?.status).toBe("succeeded");
    await engine.dispose();
  });
});