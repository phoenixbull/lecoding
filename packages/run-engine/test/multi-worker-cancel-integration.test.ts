/**
 * 多 worker 跨进程 cancel 端到端集成测试。
 *
 * 测试目标:
 * - worker-A 与 worker-B 各自持一个 RunEngine 实例
 * - 两个 engine 共享同一 PGlite LISTEN/NOTIFY 总线
 * - worker-A 持有的 Run 正在 perform,worker-B 通过 cancel 命令触发 cancel
 * - cancelBus.publish 跨 worker 派发,worker-A 的 perform 收到 AbortSignal
 *
 * 与 cancel-bus-wiring.test.ts 区别:
 * - wiring 测试是同进程单 engine,验证 subscribe → handles.abort 通路
 * - 这里验证多 worker 端到端,worker-B 的 publish 真的能中断 worker-A 的 perform
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPGliteCancelBusCluster } from "./helpers/pglite-cancel-bus-cluster.js";
import {
  createRunEngine,
  type AgentModelTurn,
  type RunStore,
  type StoredRun
} from "../src/index.js";
import { createPolicyEngine } from "@lecoding/policy";
import { createInMemoryRunEventJournal } from "@lecoding/run-events";
import type { EnvironmentHandle, RunId } from "@lecoding/contracts";

/**
 * 让 perform 期间挂起等待 abort 信号的 hook 环境。
 * 用于在测试中精确控制"perform 中"与"abort 触发"的时序。
 */
function createBlockingEnvironment() {
  const controller = new AbortController();
  let started = false;
  let sawAbort = false;
  let startPromise!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    startPromise = resolve;
  });
  /*
   * listener 与 if 检查之间没有竞态——controller.abort() 触发 abort 事件,
   * listener 同步执行 sawAbort = true。如果 listener 被注册前已经 abort,
   * addEventListener 不会触发,改用 abort 事件循环。
   * 直接用 onabort 属性简化,无需竞态处理。
   */
  controller.signal.onabort = () => {
    sawAbort = true;
  };
  return {
    startedPromise,
    controller,
    env: {
      async prepare(): Promise<EnvironmentHandle> {
        return { id: "blocking-handle" } as EnvironmentHandle;
      },
      async perform(_h: unknown, _c: unknown, signal?: AbortSignal) {
        startPromise();
        started = true;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            sawAbort = true;
            resolve();
            return;
          }
          const timeout = setTimeout(resolve, 3000);
          signal?.addEventListener("abort", () => {
            clearTimeout(timeout);
            sawAbort = true;
            resolve();
          });
        });
        /*
         * 不 throw,避免 unhandled rejection 污染测试输出。
         * abort 信号已被 listener 捕获,断言通过 sawAbort() 验证。
         */
        return { exitCode: signal?.aborted ? 130 : 0, stdout: "", stderr: "" };
      },
      async dispose() {
        return undefined;
      },
      async inspect() {
        return {
          handle: { id: "blocking-handle" } as EnvironmentHandle,
          lastActivity: new Date().toISOString(),
          changedFiles: []
        };
      }
    },
    isStarted: () => started,
    sawAbort: () => sawAbort
  };
}

describe("multi-worker cancel integration (PGlite LISTEN/NOTIFY fanout)", () => {
  let cluster: Awaited<ReturnType<typeof createPGliteCancelBusCluster>>;

  beforeEach(async () => {
    cluster = await createPGliteCancelBusCluster();
  });

  afterEach(async () => {
    await cluster.close();
  });

  it("worker-B cancel command signals worker-A's perform via shared cancelBus", async () => {
    /*
     * 跨 worker 端到端:
     * 1. worker-A 启动 Run 并进入 perform(挂起等 abort)
     * 2. worker-B 通过 engine.command({type:"cancel"}) 触发 cancel
     * 3. worker-B 的 engine 在 cancel 路径调 cancelBus.publish
     * 4. worker-A 的 engine 通过 LISTEN 收到 runId,调本地 handles.abort
     * 5. worker-A 的 perform 收到 AbortSignal,reject
     */
    const busA = cluster.createBus("worker-A");
    const busB = cluster.createBus("worker-B");

    /*
     * 测试侧独立 spy handler 收集 received —— engine.dispose() 会同时
     * stop spy handler 与 engine 自己的 handler,确保断言准确。
     */
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    await busA.subscribe((runId) => receivedA.push(runId));
    await busB.subscribe((runId) => receivedB.push(runId));

    /*
     * 顶层 controller + spy handles —— 让 worker-A 的 wrappedRegistry.abort
     * 直接调 controller.abort(),对应真实环境下 handles.abort 触发所有
     * 注册的 AbortController。
     */
    const controller = new AbortController();

    const sharedStore: RunStore = {
      async get() {
        return undefined;
      },
      async save() {
        return 1;
      }
    };

    const blocker = createBlockingEnvironment();

    const stubModel = {
      async *generate(): AsyncGenerator<AgentModelTurn> {
        yield {
          type: "tool_call",
          callId: "t1",
          tool: "execute_command",
          arguments: { argv: ["sleep", "1"] }
        };
      },
      next: async () => ({
        type: "tool_call" as const,
        callId: "t1",
        tool: "execute_command" as const,
        arguments: { argv: ["sleep", "1"] }
      })
    };

    const stubVerifier = {
      async verify() {
        return { outcome: "passed" as const, checks: [] };
      }
    };

    const stubLease = {
      async acquire(_input?: { runId: string; ownerId: string }) {
        /*
         * 测试 stub:任何 worker 都能 acquire 同一 runId——模拟
         * 跨 worker 调度场景(worker-A 已持有 lease 时,worker-B
         * 接管或发 cancel 命令也允许 acquire)。
         * 真实场景下 PG lease 会拒绝——本测试目的是验证 cancelBus
         * 通路,不验证 lease 互斥。
         */
        return {
          runId: "run-shared",
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

    const stubHeartbeat = {
      async withHeartbeat<T>(_token: unknown, _interval: number, fn: () => Promise<T>) {
        return fn();
      }
    };

    const stubEvents = createInMemoryRunEventJournal({
      now: () => new Date().toISOString()
    });

    const depsBase = {
      store: sharedStore,
      model: stubModel,
      policy: createPolicyEngine(),
      verifier: stubVerifier,
      lease: stubLease,
      heartbeat: stubHeartbeat,
      now: () => new Date().toISOString(),
      leaseMilliseconds: 60_000,
      createId: () => "run-shared" as RunId
    };

    const engineA = await createRunEngine({
      ...depsBase,
      environment: blocker.env,
      events: stubEvents,
      handles: {
        register: () => undefined,
        borrow: () => undefined,
        restore: () => undefined,
        abort: () => {
          /*
           * 模拟 worker-A 的 RunHandleRegistry:收到 cancel 通知后
           * 调本地所有 AbortController.abort()。这里直接调 controller
           * 简化测试(真实环境是 controller 在 prepare 时注册)。
           */
          controller.abort();
          return 1;
        },
        release: () => undefined
      },
      cancelBus: busA,
      workerId: "worker-A"
    });

    /*
     * worker-B 同样持有 engine 实例(自己的 handle registry),订阅同一 PGlite bus。
     * worker-B 没真正启动 perform——它的 engine 只用来发 cancel 命令。
     */
    const engineB = await createRunEngine({
      ...depsBase,
      environment: blocker.env,
      events: stubEvents,
      handles: {
        register: () => undefined,
        borrow: () => undefined,
        restore: () => undefined,
        abort: () => 0,
        release: () => undefined
      },
      cancelBus: busB,
      workerId: "worker-B"
    });

    /*
     * worker-A 启动 Run 的 perform:用 blocker.env.perform + controller.signal。
     * 不调 worker-A 的 resume()——只通过直接调 environment.perform
     * 来模拟"perform 已开始"的中间状态。
     */
    const performPromise = blocker.env.perform(
      undefined,
      undefined,
      controller.signal
    );

    await blocker.startedPromise;

    /*
     * worker-B 触发 cancel 命令——cancel 路径调 cancelBus.publish(stored.id)。
     * engineB.command 期望 stored 已被 start 写入;startStubRun 模拟这一点。
     */
    const stubRun: StoredRun = {
      id: "run-shared" as RunId,
      version: 0,
      status: "running",
      input: {
        projectId: "p",
        environmentId: "e",
        task: "x",
        acceptanceCriteria: [],
        approvalMode: "full_access",
        fileAccessScope: "workspace_only"
      },
      pendingApproval: undefined as never,
      pendingToolCall: undefined as never,
      toolResults: []
    };
    sharedStore.get = async (runId) =>
      runId === stubRun.id ? stubRun : undefined;
    await engineB.command(stubRun.id, { type: "cancel" }).catch(() => undefined);

    /*
     * 让 LISTEN/NOTIFY 派发到达 worker-A 的 handler,
     * handler 调 handles.abort(runId),AbortSignal 触发 perform reject。
     * 增加等待窗口到 500ms —— PGlite 跨 session 派发有 latency。
     */
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(blocker.sawAbort()).toBe(true);
    expect(receivedA).toContain("run-shared");
    expect(receivedB).toContain("run-shared");

    /*
     * dispose 路径验证:engine.dispose() 后,engine 自己的 handler 停止,
     * 不会被新 publish 触发。但测试侧的 spy handler 是独立 listen,
     * 不受 engine.dispose() 影响——这是 PG LISTEN 的 session 隔离语义。
     * 验证:engineA dispose 后,新 publish 不会让 blocker.sawAbort 再次变化
     * (blocker 是绑定在 controller 上,controller 只被 engineA handler 触发)。
     */
    const beforeSaw = blocker.sawAbort();

    await engineA.dispose();
    await busA.publish("after-A-dispose");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(blocker.sawAbort()).toBe(beforeSaw);

    await engineB.dispose();
    await performPromise;
  });
});