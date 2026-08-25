import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryRunCancelBus } from "../src/run-cancel-bus.js";

describe("InMemoryRunCancelBus", () => {
  let bus: InMemoryRunCancelBus;
  beforeEach(() => {
    bus = new InMemoryRunCancelBus();
  });

  it("delivers published runId to all subscribers", async () => {
    /*
     * 跨进程 cancel 的本地最小验证:
     * 发布者调 publish(runId) → 所有订阅者 handler 收到同一 runId。
     * 多个订阅者可并存(每个 worker 进程一个)。
     */
    const received1: string[] = [];
    const received2: string[] = [];
    await bus.subscribe((runId) => {
      received1.push(runId);
    });
    await bus.subscribe((runId) => {
      received2.push(runId);
    });

    await bus.publish("run-1");
    await bus.publish("run-2");

    expect(received1).toEqual(["run-1", "run-2"]);
    expect(received2).toEqual(["run-1", "run-2"]);
  });

  it("stops delivering after stop() is called", async () => {
    /*
     * 订阅生命周期:worker 进程关闭时调 stop(),不再接收通知。
     * 可观察面:stop 后 publish,handler 不再被调。
     */
    const received: string[] = [];
    const stop = await bus.subscribe((runId) => {
      received.push(runId);
    });
    await bus.publish("run-1");
    expect(received).toEqual(["run-1"]);

    stop();
    await bus.publish("run-2");
    expect(received).toEqual(["run-1"]);
  });

  it("serializes subscribed handler errors without affecting other subscribers", async () => {
    /*
     * 隔离错误:一个 handler 抛错不影响其他 handler 的派发——
     * 与 PG LISTEN 行为一致(每个 listener 独立处理)。
     */
    const received: string[] = [];
    await bus.subscribe(() => {
      throw new Error("handler-1 failure");
    });
    await bus.subscribe((runId) => {
      received.push(runId);
    });

    await bus.publish("run-1");
    expect(received).toEqual(["run-1"]);
  });
});