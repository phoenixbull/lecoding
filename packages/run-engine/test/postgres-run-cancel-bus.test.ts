import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createPostgresRunCancelBus, wrapPglite } from "../src/postgres-run-cancel-bus.js";

describe("postgres run cancel bus", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
  });

  it("delivers published runId to the listener", async () => {
    /*
     * LISTEN/NOTIFY 通路验证:publish 走 pg_notify,订阅者 handler
     * 同步收到 runId payload。
     * 注:这里用单 PGlite 实例模拟同一 PG server 内的两个连接
     * (PGlite listen 会注册一个独立 session 监听 channel)。
     * 跨进程场景下两个 worker 各持 PGlite instance 各自 listen 同一 channel
     * 会走相同的 NOTIFY 派发逻辑——本测试足以证明代码路径正确。
     */
    const bus = createPostgresRunCancelBus(wrapPglite(pg));
    const received: string[] = [];
    await bus.subscribe((runId) => {
      received.push(runId);
    });

    await bus.publish("run-1");
    await bus.publish("run-2");

    /*
     * PGlite 的 listen 是异步派发,publish 后需微让出事件循环
     * 让 NOTIFY 消息到达 handler。用 setTimeout 0 让出。
     */
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual(["run-1", "run-2"]);
  });

  it("stops delivering after stop()", async () => {
    /*
     * stop 后 publish 不再触发 handler——worker 进程关闭语义。
     */
    const bus = createPostgresRunCancelBus(wrapPglite(pg));
    const received: string[] = [];
    const stop = await bus.subscribe((runId) => {
      received.push(runId);
    });

    await bus.publish("run-1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual(["run-1"]);

    await stop();
    await bus.publish("run-2");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual(["run-1"]);
  });

  it("isolates handler errors across subscribers", async () => {
    /*
     * 与 InMemoryRunCancelBus 对齐:handler 抛错不影响其他订阅者派发。
     * 在 PG 场景下:每个 listener 独立处理消息,一个抛错不会让
     * NOTIFY 系统停止对其他 listener 的派发。
     */
    const bus = createPostgresRunCancelBus(wrapPglite(pg));
    const received: string[] = [];
    await bus.subscribe(() => {
      throw new Error("handler-1 failure");
    });
    await bus.subscribe((runId) => {
      received.push(runId);
    });

    await bus.publish("run-1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual(["run-1"]);
  });
});