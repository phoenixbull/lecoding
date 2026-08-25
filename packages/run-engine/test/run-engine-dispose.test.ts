import { describe, it, expect } from "vitest";
import {
  createRunEngine,
  InMemoryRunCancelBus,
  createInMemoryRunHandleRegistry,
  createInMemoryRunLease,
  createIntervalLeaseHeartbeat,
  type AgentModelTurn,
  type RunStore
} from "../src/index.js";
import type { EnvironmentHandle, RunId } from "@lecoding/contracts";
import { createPolicyEngine } from "@lecoding/policy";
import { createInMemoryRunEventJournal } from "@lecoding/run-events";

/**
 * Phase-0 risk 1 收尾:dispose 真正停止 cancelBus 订阅。
 *
 * 旧实现缺陷:createRunEngine 同步返回,但 cancelBus.subscribe 是异步 Promise;
 * worker 关闭时调 stop() 可能拿到一个空闭包,导致 LISTEN 连接泄漏——
 * 长时间运行 worker 池会累积 zombie PG listen 客户端。
 *
 * 红测试目标:
 * 1. createRunEngine 是异步工厂——返回 Promise,resolve 后订阅才生效。
 * 2. engine.dispose() 后 publish 不再触发本地 handles.abort。
 * 3. dispose() 幂等——多次调用不抛错。
 */
describe("createRunEngine async factory + dispose lifecycle", () => {
  const stubEnvironment = {
    async prepare(): Promise<EnvironmentHandle> {
      return { id: "stub-handle" } as EnvironmentHandle;
    },
    async perform() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async dispose() {
      return undefined;
    },
    inspect: async () => ({
      handle: { id: "stub-handle" } as EnvironmentHandle,
      lastActivity: new Date().toISOString(),
      changedFiles: []
    })
  };

  const stubModel = {
    async *generate(): AsyncGenerator<AgentModelTurn> {
      yield { type: "completed", summary: "no-op" };
    },
    next: async () => ({ type: "completed" as const, summary: "no-op" })
  };

  const stubStore: RunStore = {
    async get() {
      return undefined;
    },
    async save() {
      return 1;
    }
  };

  function makeDeps(cancelBus: InMemoryRunCancelBus | undefined) {
    const innerRegistry = createInMemoryRunHandleRegistry();
    const abortCalls: RunId[] = [];
    const wrappedRegistry = {
      register: innerRegistry.register.bind(innerRegistry),
      borrow: innerRegistry.borrow.bind(innerRegistry),
      restore: innerRegistry.restore.bind(innerRegistry),
      abort: (runId: RunId) => {
        abortCalls.push(runId);
        return innerRegistry.abort(runId);
      },
      release: innerRegistry.release.bind(innerRegistry)
    };
    const baseDeps = {
      store: stubStore,
      environment: stubEnvironment,
      model: stubModel,
      policy: createPolicyEngine(),
      events: createInMemoryRunEventJournal({
        now: () => new Date().toISOString()
      }),
      verifier: {
        async verify() {
          return { outcome: "passed" as const, checks: [] };
        }
      },
      handles: wrappedRegistry,
      lease: createInMemoryRunLease(),
      heartbeat: createIntervalLeaseHeartbeat(createInMemoryRunLease()),
      workerId: "worker-A",
      now: () => new Date().toISOString(),
      leaseMilliseconds: 60_000,
      createId: () => "run-stub"
    };
    return {
      abortCalls,
      deps: cancelBus === undefined ? baseDeps : { ...baseDeps, cancelBus }
    };
  }

  it("createRunEngine is async: await resolves after subscribe completes", async () => {
    /*
     * 工厂 await 完成时,publish 立即被 handler 接收——不再依赖外部 setTimeout 让出。
     * 这是 race 修复的关键:同步工厂无法保证订阅就绪。
     */
    const bus = new InMemoryRunCancelBus();
    const { abortCalls, deps } = makeDeps(bus);

    const result = createRunEngine(deps);
    expect(result).toBeInstanceOf(Promise);

    const engine = await result;
    await bus.publish("run-1");
    /*
     * await 后立即断言:不再需要 setTimeout 让出。
     */
    expect(abortCalls).toContain("run-1");

    await engine.dispose();
  });

  it("engine.dispose() stops delivering cancel notifications to handles.abort", async () => {
    /*
     * 关键可观察面:dispose() 后,publish(runId) 不再触发 wrappedRegistry.abort。
     * 旧实现:dispose 调用一个空闭包,订阅仍生效,publish 继续触发 abort。
     */
    const bus = new InMemoryRunCancelBus();
    const { abortCalls, deps } = makeDeps(bus);

    const engine = await createRunEngine(deps);

    await bus.publish("run-before-dispose");
    expect(abortCalls).toEqual(["run-before-dispose"]);

    await engine.dispose();

    await bus.publish("run-after-dispose");
    expect(abortCalls).toEqual(["run-before-dispose"]);

    void abortCalls;
  });

  it("engine.dispose() is idempotent", async () => {
    /*
     * 多次调用 dispose 不抛错——worker 关闭路径可能在 SIGTERM 与 graceful shutdown
     * 双重触发 dispose,必须幂等。
     */
    const bus = new InMemoryRunCancelBus();
    const { deps } = makeDeps(bus);

    const engine = await createRunEngine(deps);
    await engine.dispose();
    await engine.dispose();
    await engine.dispose();
  });

  it("engine without cancelBus has no-op dispose", async () => {
    /*
     * legacy 兼容:未注入 cancelBus 时 dispose 应是无副作用的空操作,
     * 不抛错、不要求任何资源。
     */
    const { deps } = makeDeps(undefined);

    const engine = await createRunEngine(deps);
    await expect(engine.dispose()).resolves.toBeUndefined();
  });
});