import type { RunId } from "@lecoding/contracts";
import type { RunCancelBus } from "./run-cancel-bus.js";

/**
 * 与 PostgresExecutor 结构兼容的最小订阅接口。
 * publish 走 query("NOTIFY ...") 不需要独立连接,可与 query 共用。
 * listen 返回长连接句柄——PGlite/真实 pg 的 listen 会独占连接直到 unsub。
 *
 * onClientDisconnect:底层 client 整体断开事件。
 * cancelBus 用此触发自动重连 + re-LISTEN。所有实现者(包括 PGlite 适配)
 * 都必须提供——可以 stub 一个 no-op,但接口契约要求存在以驱动重连状态机。
 *
 * onClientDisconnect 返回 unregister() 用于取消监听(测试内部清理用)。
 */
export interface PostgresNotifiable {
  query<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: unknown[]
  ): Promise<{ rows: Row[] }>;
  listen(
    channel: string,
    callback: (payload: string) => void
  ): Promise<() => Promise<void>>;
  /**
   * 订阅 client 整体断开事件。返回 unregister 取消订阅。
   * PGlite / pg.Client 适配都需实现——PGlite 没有 native disconnect 信号,
   * 可注册一个永远不会触发的 no-op handler(stub),但接口必填以保证
   * cancelBus 状态机始终可用。
   */
  onClientDisconnect(handler: () => void): () => void;
}

/**
 * 重连策略:指数退避封顶 30s,最多 10 次重试后停止。
 * 生产可调——目前用常量简化,未来可作为参数注入。
 */
const RECONNECT_BACKOFF_INITIAL_MS = 100;
const RECONNECT_BACKOFF_MAX_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 10;

/**
 * 计算指数退避:100ms, 200, 400, 800, 1600, ... 封顶 30s。
 */
function nextBackoff(attempt: number): number {
  const ms = RECONNECT_BACKOFF_INITIAL_MS * 2 ** attempt;
  return Math.min(ms, RECONNECT_BACKOFF_MAX_MS);
}

/**
 * PostgreSQL LISTEN/NOTIFY 实现的跨进程 cancel 信号总线。
 *
 * 设计要点:
 * - channel 统一为 `run_engine_cancel`,payload 是 runId 字符串。
 * - publish 走 query("NOTIFY ...") 与查询共享连接池,不需要独立连接。
 * - subscribe 启动 listen + **内置重连状态机**——底层 client 断开后
 *   自动 backoff + 重新 LISTEN,使 worker 进程长跑也不会因网络抖动丢订阅。
 *   这是 sqlx PgListener / pg-ears 的核心能力,工业级 PG listener 必备。
 * - stop() 取消重连 + 真正调用底层 unlisten。
 * - 错误隔离:publish 与 subscribe 的 handler 抛错互不影响。
 */
export function createPostgresRunCancelBus(
  client: PostgresNotifiable
): RunCancelBus {
  return {
    async publish(runId: RunId): Promise<void> {
      // NOTIFY payload 是字符串,直接传 runId;PG 限制 payload <= 8000 字节
      // 对我们的 runId 远不会触顶。
      await client.query<Record<string, never>>(
        "SELECT pg_notify($1, $2);",
        ["run_engine_cancel", runId]
      );
    },
    async subscribe(handler: (runId: RunId) => void): Promise<() => void> {
      /*
       * 重连状态机:
       * - stopped 标志订阅已取消,reconnect loop 不再启动新 listen
       * - currentStop 持有当前底层 listen 的 stop 闭包;
       *   重连时先调它清理旧 listener,再 listen 新连接
       * - attempt 计数指数退避
       * - reconnectPromise 是当前正在 reconnect 的 promise,用于 stop() 等待
       */
      let stopped = false;
      let currentStop: (() => Promise<void>) | null = null;
      let attempt = 0;
      let reconnectPromise: Promise<void> = Promise.resolve();

      const startListen = async (): Promise<void> => {
        /*
         * listen 返回前先 await,然后把 stop 闭包存到 currentStop。
         */
        const stop = await client.listen("run_engine_cancel", (payload) => {
          try {
            handler(payload as RunId);
          } catch {
            // 隔离订阅者错误,不打断 listen 循环
          }
        });
        currentStop = stop;
        attempt = 0;
      };

      const scheduleReconnect = (): void => {
        if (stopped) {
          return;
        }
        reconnectPromise = (async () => {
          while (!stopped && attempt < RECONNECT_MAX_ATTEMPTS) {
            const backoff = nextBackoff(attempt);
            attempt += 1;
            await new Promise((resolve) => setTimeout(resolve, backoff));
            if (stopped) {
              return;
            }
            try {
              /*
               * 先清理旧 listener 闭包,再 listen 新连接。
               * 旧闭包可能在断开后已自动 unlisten——catch 忽略。
               */
              if (currentStop) {
                try {
                  await currentStop();
                } catch {
                  // ignore: stop 失败不阻止重连
                }
                currentStop = null;
              }
              await startListen();
              return;
            } catch {
              /*
               * listen 失败——下个循环继续重试,attempt 已递增,
               * backoff 会按指数增长直到封顶。
               */
            }
          }
          /*
           * 达到最大重试次数仍未恢复——handler 永久失效。
           * 生产场景下应触发 worker 进程告警;此处不主动抛错,
           * 保持接口幂等(后续 NOTIFY 丢失但不污染调用方)。
           */
        })();
      };

      /*
       * 注册 client 整体断开钩子——所有 client 实现都应提供 onClientDisconnect
       * (即使是 no-op stub)。cancelBus 状态机依赖此钩子启动重连。
       */
      const unregisterDisconnect = client.onClientDisconnect(() => {
        if (stopped) {
          return;
        }
        scheduleReconnect();
      });

      await startListen();

      return async () => {
        stopped = true;
        unregisterDisconnect();
        /*
         * await 当前 reconnect 完成,避免 stop 与 listen race:
         * stop 设置 stopped 后,正在跑的 reconnect loop 看到标志会退出,
         * 但可能仍在调 listen——先 await 它,确保所有 listen 完成后再清理。
         */
        await reconnectPromise;
        if (currentStop) {
          try {
            await currentStop();
          } catch {
            // ignore: stop 失败不影响幂等
          }
          currentStop = null;
        }
      };
    }
  };
}

/**
 * 给 PGlite 实例加 onClientDisconnect 接口契约——PGlite 没有 native
 * disconnect 信号(单进程 embedded Postgres,通常不会断开),
 * 所以 stub 一个 no-op handler 满足 PostgresNotifiable 接口要求。
 *
 * 用法:
 * ```ts
 * const pg = new PGlite();
 * const adapter = wrapPglite(pg);
 * const bus = createPostgresRunCancelBus(adapter);
 * ```
 *
 * 注意:生产部署如用真实 pg.Client,改用 wrapPgClient(client)
 * 暴露真实 disconnect 信号。
 */
export function wrapPglite(pg: {
  query: (
    sql: string,
    parameters?: unknown[]
  ) => Promise<{ rows: unknown[] }>;
  listen: (
    channel: string,
    callback: (payload: string) => void
  ) => Promise<() => Promise<void>>;
}): PostgresNotifiable {
  const handlers = new Set<() => void>();
  /*
   * bind pg.query / pg.listen 保留 `this`——PGlite 的 query 是 prototype 方法,
   * 直接传引用会丢失 this 导致内部访问 _runExclusiveListen 等实例字段失败。
   * duck-typed pg.Client 同样适用(node-postgres 也使用 prototype method)。
   */
  const query: PostgresNotifiable["query"] = pg.query.bind(pg) as PostgresNotifiable["query"];
  const listen: PostgresNotifiable["listen"] = pg.listen.bind(pg) as PostgresNotifiable["listen"];
  return {
    query,
    listen,
    onClientDisconnect(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    }
  };
  void handlers;
}