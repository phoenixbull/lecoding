import { describe, it, expect } from "vitest";
import {
  createRunEngine,
  InMemoryRunCancelBus,
  createInMemoryRunHandleRegistry,
  createInMemoryRunLease,
  createIntervalLeaseHeartbeat,
  type AgentModelTurn,
  type RunEngineDependencies
} from "../src/index.js";
import type { EnvironmentHandle, RunId } from "@lecoding/contracts";
import { createPolicyEngine } from "@lecoding/policy";
import { createInMemoryRunEventJournal } from "@lecoding/run-events";

/**
 * Phase-0 risk 1 集成验证:
 * RunEngine 构造时订阅 cancelBus,publish 时调本地 handles.abort。
 *
 * 这是跨进程 cancel 的核心 wiring——远端 worker 的 cancel 命令路径
 * publish 后,本进程 engine 收到通知并 abort 持有的 perform。
 *
 * 可观察面:构造 engine 时传入 wrapped handle registry(abort 被 spy),
 * cancelBus.publish(runId) 后 wrappedRegistry.abort(runId) 必须被调一次。
 */
describe("RunEngine wires cancelBus.subscribe at construction", () => {
  it("calls handles.abort when cancelBus publishes a runId", async () => {
    const bus = new InMemoryRunCancelBus();

    /*
     * 直接构造 engine + spy wrapped handle registry。
     * 用 createInMemoryRunHandleRegistry 作为 inner,通过 spy wrapper 转发,
     * 保持类型对齐——bind 转发会让 abort 仍然返回 number。
     */
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

    const stubPolicy = createPolicyEngine();
    const stubEvents = createInMemoryRunEventJournal({
      now: () => new Date().toISOString()
    });

    const stubVerifier = {
      async verify() {
        return { outcome: "passed" as const, checks: [] };
      }
    };

    const stubLease = createInMemoryRunLease();
    const stubHeartbeat = createIntervalLeaseHeartbeat(stubLease);

    const deps: RunEngineDependencies = {
      store: {
        async get() {
          return undefined;
        },
        async save() {
          return 1;
        }
      },
      environment: stubEnvironment,
      model: stubModel,
      policy: stubPolicy,
      events: stubEvents,
      verifier: stubVerifier,
      handles: wrappedRegistry,
      lease: stubLease,
      heartbeat: stubHeartbeat,
      cancelBus: bus,
      workerId: "worker-A",
      now: () => new Date().toISOString(),
      leaseMilliseconds: 60_000,
      createId: () => "run-stub"
    };

    const engine = await createRunEngine(deps);

    /*
     * engine 构造完成,内部 subscribe 已注册(await 完成保证订阅就绪)。
     * publish 验证 wiring 路径——不再需要 setTimeout 让出。
     */
    await bus.publish("run-stub");

    expect(abortCalls).toContain("run-stub");
  });
});