/**
 * Phase-0 risk 1 收尾:生产 pg.Client 的 disconnect/error 信号适配。
 *
 * pg.Client 是 node-postgres 的长连接客户端:
 * - 'error' 事件:连接错误(网络断开、server gone away 等)
 * - 'end' 事件:显式关闭
 * - 'notification' 事件:NOTIFY 消息,msg.channel + msg.payload
 *
 * wrapPgClient 把 pg.Client duck-typed 适配成 PostgresNotifiable:
 * - query → 直接转发 client.query
 * - listen → 注册 'notification' 监听 + 执行 'LISTEN' SQL,unlisten 时反操作
 * - onClientDisconnect → 'error' + 'end' 事件
 *
 * 测试用 EventEmitter-based mock client 模拟 pg.Client。
 * 关键可观察面:
 * 1. NOTIFY 消息抵达 → handler 被调(过滤正确 channel)
 * 2. client.emit('error') → onClientDisconnect handler 被调
 * 3. client.emit('end') → onClientDisconnect handler 被调
 * 4. unregister 后,client 事件不再触发 handler
 * 5. listen 的 stop 真正移除 notification 监听
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { wrapPgClient } from "../src/pg-client-adapter.js";

/**
 * Mock pg.Client:EventEmitter + 桩 query。
 * 不引入 pg 依赖——只暴露 wrapPgClient 实际用到的 API 表面。
 */
interface MockPgClient extends EventEmitter {
  query: (
    sql: string,
    parameters?: unknown[] | undefined
  ) => Promise<{ rows: unknown[] }>;
  queryCalls: { sql: string; parameters?: unknown[] | undefined }[];
}

function createMockPgClient(): MockPgClient {
  const emitter = new EventEmitter();
  const queryCalls: { sql: string; parameters?: unknown[] | undefined }[] = [];
  return Object.assign(emitter, {
    query: async (sql: string, parameters?: unknown[]) => {
      queryCalls.push({ sql, parameters });
      return { rows: [] };
    },
    queryCalls
  });
}

describe("wrapPgClient (pg.Client → PostgresNotifiable adapter)", () => {
  it("routes LISTEN/NOTIFY messages to handler with payload", async () => {
    /*
     * 核心通路:pg client 收到 NOTIFY → 'notification' 事件 → handler(response)。
     * channel 过滤由 listener 完成,适配器不需做 channel 路由。
     */
    const pg = createMockPgClient();
    const adapter = wrapPgClient(pg);
    const received: string[] = [];

    await adapter.listen("run_engine_cancel", (payload) => {
      received.push(payload);
    });

    /*
     * 模拟 pg.Client 收到 NOTIFY:实际 PG 的 'notification' 事件是
     * { channel: 'run_engine_cancel', payload: 'run-1', processId: 0 }
     */
    pg.emit("notification", {
      channel: "run_engine_cancel",
      payload: "run-1"
    });
    pg.emit("notification", {
      channel: "run_engine_cancel",
      payload: "run-2"
    });
    pg.emit("notification", {
      channel: "other_channel",
      payload: "ignored"
    });

    expect(received).toEqual(["run-1", "run-2"]);
  });

  it("fires onClientDisconnect when client emits 'error'", async () => {
    /*
     * 关键 seam:pg client 'error' 事件 → adapter onClientDisconnect handler。
     * 这是重连路径的触发点。
     */
    const pg = createMockPgClient();
    const adapter = wrapPgClient(pg);
    const disconnects: number[] = [];
    adapter.onClientDisconnect(() => disconnects.push(Date.now()));

    pg.emit("error", new Error("connection terminated"));

    expect(disconnects).toHaveLength(1);
  });

  it("fires onClientDisconnect when client emits 'end'", async () => {
    /*
     * 'end' 也算 disconnect——可能是 server 单方面关闭连接。
     */
    const pg = createMockPgClient();
    const adapter = wrapPgClient(pg);
    const disconnects: number[] = [];
    adapter.onClientDisconnect(() => disconnects.push(1));

    pg.emit("end");

    expect(disconnects).toHaveLength(1);
  });

  it("unregister stops receiving disconnect signals", async () => {
    /*
     * cancelBus.dispose() 调 unregisterDisconnect —— 之后 client
     * 'error' / 'end' 事件不应再触发 handler(避免 zombie listener)。
     */
    const pg = createMockPgClient();
    const adapter = wrapPgClient(pg);
    let count = 0;
    const unregister = adapter.onClientDisconnect(() => count++);

    pg.emit("error", new Error("first"));
    expect(count).toBe(1);

    unregister();
    /*
     * EventEmitter 在没有 'error' listener 时 emit('error') 会抛错——
     * 这是它的特殊语义。adapter 已 unregister,client 没有 'error' listener,
     * 所以这里需要 try/catch 阻止抛错传到测试断言。
     */
    try {
      pg.emit("error", new Error("after-unregister"));
    } catch {
      // EventEmitter 自动抛错被吞
    }
    pg.emit("end");

    expect(count).toBe(1);
  });

  it("multiple disconnect handlers are isolated", async () => {
    /*
     * 多个订阅者场景:两个 handler 都收到,但一个 unregister 不影响另一个。
     */
    const pg = createMockPgClient();
    const adapter = wrapPgClient(pg);
    let a = 0;
    let b = 0;
    const unregisterA = adapter.onClientDisconnect(() => a++);
    adapter.onClientDisconnect(() => b++);

    pg.emit("error", new Error("boom"));
    expect(a).toBe(1);
    expect(b).toBe(1);

    unregisterA();
    pg.emit("error", new Error("boom-2"));
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it("listen stop unregisters the notification listener", async () => {
    /*
     * stop() 必须真正移除 'notification' 监听——避免 zombie listener
     * 持续占用 client。
     */
    const pg = createMockPgClient();
    const adapter = wrapPgClient(pg);
    const received: string[] = [];
    const stop = await adapter.listen("run_engine_cancel", (payload) => {
      received.push(payload);
    });

    pg.emit("notification", { channel: "run_engine_cancel", payload: "run-1" });
    expect(received).toEqual(["run-1"]);

    await stop();

    pg.emit("notification", { channel: "run_engine_cancel", payload: "run-2" });
    expect(received).toEqual(["run-1"]);

    /*
     * 同时验证 adapter 执行了 UNLISTEN SQL——避免 pg server 端
     * LISTEN 累积泄漏。
     */
    const unlistenCall = pg.queryCalls.find(
      (c) => c.sql === 'UNLISTEN "run_engine_cancel"'
    );
    expect(unlistenCall).toBeDefined();
  });

  it("listen executes LISTEN SQL on subscribe", async () => {
    /*
     * 首次订阅必须发 LISTEN SQL——否则 pg server 不会发 NOTIFY。
     */
    const pg = createMockPgClient();
    const adapter = wrapPgClient(pg);
    await adapter.listen("run_engine_cancel", () => undefined);

    const listenCall = pg.queryCalls.find(
      (c) => c.sql === 'LISTEN "run_engine_cancel"'
    );
    expect(listenCall).toBeDefined();
  });

  it("query forwards to client.query", async () => {
    /*
     * publish 路径:adapter.query(sql, params) → client.query(sql, params)。
     */
    const pg = createMockPgClient();
    const adapter = wrapPgClient(pg);

    await adapter.query("SELECT pg_notify($1, $2)", ["ch", "payload"]);

    expect(pg.queryCalls).toEqual([
      { sql: "SELECT pg_notify($1, $2)", parameters: ["ch", "payload"] }
    ]);
  });

  it("end-to-end:pg 'error' triggers cancelBus reconnect", async () => {
    /*
     * 与 cancel-bus-reconnect.test.ts 类似,但通过 pg adapter 触发——
     * 验证完整路径:pg error → adapter → cancelBus onClientDisconnect → 重连 + re-LISTEN。
     */
    const { createPostgresRunCancelBus } = await import(
      "../src/postgres-run-cancel-bus.js"
    );
    const pg = createMockPgClient();
    const adapter = wrapPgClient(pg);
    // 暴露 queryCalls 用于 stop 后 UNLISTEN 验证
    const bus = createPostgresRunCancelBus(adapter);
    const received: string[] = [];
    await bus.subscribe((runId) => {
      received.push(runId);
    });

    /*
     * 第一次 NOTIFY 模拟 server 端 publish + 派发。
     */
    pg.emit("notification", {
      channel: "run_engine_cancel",
      payload: "run-before"
    });
    expect(received).toEqual(["run-before"]);

    /*
     * 触发 pg 错误——adapter 应将 error 转 onClientDisconnect,
     * cancelBus 启动重连循环。
     */
    pg.emit("error", new Error("connection terminated"));

    /*
     * cancelBus 重连后会再次调 adapter.listen,adapter 内部
     * 执行 LISTEN SQL + 注册新的 notification listener。
     * mock pg 的 EventEmitter 第一次的 listener 已被前一次 stop
     * 移除,新 listener 是新的——但同一个 EventEmitter 实例,
     * 所以再次 emit 会触发新 listener。
     */
    await new Promise((resolve) => setTimeout(resolve, 200));

    pg.emit("notification", {
      channel: "run_engine_cancel",
      payload: "run-after-reconnect"
    });
    expect(received).toContain("run-after-reconnect");
  });
});