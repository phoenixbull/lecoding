import { describe, it, expect, beforeEach } from "vitest";

/**
 * Phase-0 risk 2:PG LISTEN 连接断开后自动重连 + 重新 LISTEN。
 *
 * 工业级 PG listener(sqlx PgListener、pg-ears)的核心特性:
 * - 连接断开后自动重连
 * - 重连后自动重新 LISTEN 原 channel(避免订阅丢失)
 * - 重连期间 handler 仍生效——新连接到来后 handler 继续派发
 * - stop() 后停止重连
 *
 * 抽象 seam:PostgresNotifiable.onClientDisconnect(可选)由 client 实现
 * 暴露 client 整体断开事件;cancelBus 用此触发自动重连 + re-LISTEN。
 * 生产 PGlite 不传(连接通常稳定),测试 mock 传以验证状态机。
 *
 * 测试策略:不依赖真实 PG / PGlite 断开行为(难以触发),用 mock listener:
 * - 测试触发 disconnect → mock 调所有 onClientDisconnect handler
 * - cancelBus 内部 backoff + 重新 listen
 * - 测试模拟 NOTIFY 抵达 → handler 再次被调
 *
 * 关键可观察面:
 * 1. disconnect 后 handler 仍存在,后续 NOTIFY 仍触发 handler
 * 2. stop() 后再 reconnect,handler 不再被调
 */

interface ActiveListener {
  channel: string;
  handler: (payload: string) => void;
  stop: () => Promise<void>;
}

interface MockPostgresNotifiable {
  query<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: unknown[]
  ): Promise<{ rows: Row[] }>;
  listen(
    channel: string,
    callback: (payload: string) => void
  ): Promise<() => Promise<void>>;
  onClientDisconnect(handler: () => void): () => void;
  triggerDisconnect(): void;
  deliverToAll(payload: string): void;
  waitForNextListen(): Promise<void>;
}

function createMockPostgresNotifiable(): MockPostgresNotifiable {
  let listeners: ActiveListener[] = [];
  let disconnectHandlers: Array<() => void> = [];
  let nextListenResolve: (() => void) | null = null;

  return {
    async query(sql: string) {
      void sql;
      return { rows: [] };
    },
    listen(
      channel: string,
      handler: (payload: string) => void
    ): Promise<() => Promise<void>> {
      const stop = async (): Promise<void> => {
        listeners = listeners.filter((l) => l.stop !== stop);
      };
      listeners.push({ channel, handler, stop });
      nextListenResolve?.();
      nextListenResolve = null;
      return Promise.resolve(stop);
    },
    onClientDisconnect(handler: () => void): () => void {
      disconnectHandlers.push(handler);
      return () => {
        disconnectHandlers = disconnectHandlers.filter((h) => h !== handler);
      };
    },
    triggerDisconnect(): void {
      listeners = [];
      for (const h of disconnectHandlers) {
        try {
          h();
        } catch {
          // 隔离 listener 错误
        }
      }
    },
    deliverToAll(payload: string): void {
      for (const l of listeners) {
        try {
          l.handler(payload);
        } catch {
          // 隔离 handler 错误
        }
      }
    },
    waitForNextListen(): Promise<void> {
      return new Promise((resolve) => {
        nextListenResolve = resolve;
      });
    }
  };
}

describe("PostgresRunCancelBus reconnect after disconnect", () => {
  let pg: MockPostgresNotifiable;

  beforeEach(() => {
    pg = createMockPostgresNotifiable();
  });

  it("re-LISTENs after disconnect: handler keeps receiving NOTIFYs", async () => {
    /*
     * 基础重连语义:
     * - subscribe 后 publish → handler 收到
     * - trigger disconnect → onClientDisconnect 触发
     * - cancelBus 内部 reconnect → 重新 LISTEN
     * - publish → handler 再次收到(说明 re-LISTEN 生效)
     */
    const { createPostgresRunCancelBus } = await import(
      "../src/postgres-run-cancel-bus.js"
    );
    const bus = createPostgresRunCancelBus(pg);
    const received: string[] = [];
    await bus.subscribe((runId) => {
      received.push(runId);
    });

    /*
     * 第一次 publish + 收到
     */
    pg.deliverToAll("run-before-disconnect");
    expect(received).toEqual(["run-before-disconnect"]);

    /*
     * 触发 disconnect——cancelBus 应自动重连
     */
    const nextListen = pg.waitForNextListen();
    pg.triggerDisconnect();
    /*
     * cancelBus 看到 onClientDisconnect 后启动重连循环:
     * - backoff 100ms(attempt 0)
     * - 重新 listen(channel, handler)
     */
    await nextListen;
    pg.deliverToAll("run-after-reconnect");
    expect(received).toContain("run-after-reconnect");
  });

  it("stop() prevents further reconnect attempts", async () => {
    /*
     * 关闭语义:stop() 后 cancelBus 不再重连,handler 不再被调。
     */
    const { createPostgresRunCancelBus } = await import(
      "../src/postgres-run-cancel-bus.js"
    );
    const bus = createPostgresRunCancelBus(pg);
    const received: string[] = [];
    const stop = await bus.subscribe((runId) => {
      received.push(runId);
    });

    await stop();

    pg.triggerDisconnect();
    pg.deliverToAll("after-stop");
    expect(received).not.toContain("after-stop");
  });

  it("exponential backoff retries listen before giving up", async () => {
    /*
     * backoff 重试语义:listen 持续失败时,cancelBus 应按指数退避重试
     * 而不是只重试一次。本测试验证多次失败后 handler 仍最终恢复。
     *
     * 通过一个特殊 mock:前 2 次 listen 失败,第 3 次成功。
     */
    const flakyPg: MockPostgresNotifiable = {
      ...createMockPostgresNotifiable(),
      listen: undefined as never
    };
    let attempt = 0;
    const innerPg = createMockPostgresNotifiable();
    let listenAttempts = 0;
    flakyPg.listen = async (
      channel: string,
      callback: (payload: string) => void
    ): Promise<() => Promise<void>> => {
      /*
       * 初始 subscribe 一定成功;后续 reconnect listen 失败 2 次后成功。
       * listenAttempts 表示 reconnect 后的 listen 调用序号。
       */
      if (listenAttempts >= 1 && listenAttempts <= 2) {
        listenAttempts += 1;
        throw new Error("listen failed (simulated)");
      }
      listenAttempts += 1;
      return innerPg.listen(channel, callback);
    };
    flakyPg.onClientDisconnect = innerPg.onClientDisconnect;
    flakyPg.triggerDisconnect = innerPg.triggerDisconnect;
    flakyPg.deliverToAll = innerPg.deliverToAll;
    flakyPg.waitForNextListen = innerPg.waitForNextListen;
    flakyPg.query = innerPg.query;
    void attempt;

    const { createPostgresRunCancelBus } = await import(
      "../src/postgres-run-cancel-bus.js"
    );
    const bus = createPostgresRunCancelBus(flakyPg);
    const received: string[] = [];
    await bus.subscribe((runId) => {
      received.push(runId);
    });

    flakyPg.triggerDisconnect();
    /*
     * 等待 listen 重试完成(100 + 200 + 400 ms backoff = 700ms 总耗时)
     */
    await new Promise((resolve) => setTimeout(resolve, 1500));
    flakyPg.deliverToAll("after-flaky-reconnect");
    expect(received).toContain("after-flaky-reconnect");
  });
});