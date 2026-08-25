import type { PostgresNotifiable } from "./postgres-run-cancel-bus.js";
import type { EventEmitter } from "node:events";

/**
 * node-postgres pg.Client 的最小 duck-typed 表面——wrapPgClient 实际
 * 调用的方法集合。不 import 'pg' 类型,避免引入 @types/pg 依赖;
 * 真实 pg.Client 实例满足该 duck-typed 接口,可直接传入。
 *
 * 设计选择:adapter 只暴露它会用到的 API,避免类型耦合——pg.Client 是
 * 一个非常大的接口(连接池/事务/COPY 等),而我们只关心 query +
 * 三个事件。
 */
export interface PgClientLike extends EventEmitter {
  query(sql: string, parameters?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * 把 pg.Client(duck-typed)适配成 PostgresNotifiable。
 *
 * 关键映射:
 * - query → client.query(sql, parameters) 直接转发
 * - listen → 注册 'notification' 事件监听 + 执行 LISTEN SQL,
 *           stop 时反注册监听 + 执行 UNLISTEN SQL
 * - onClientDisconnect → 'error' + 'end' 事件作为 disconnect 信号
 *
 * 为什么 'error' + 'end' 都算 disconnect:
 * - 'error':网络断开 / server gone away / 协议错误——典型 transient
 * - 'end':server 单方面关闭连接 / idle timeout——也需重连
 * 生产 pg.Client 适配上 pg-ears / sqlx 模式都监听这两个事件。
 *
 * **cancelBus 重连路径关键**:长跑 worker 进程的网络抖动会触发 'error',
 * adapter 转发给 cancelBus.onClientDisconnect → 状态机启动指数退避
 * + 重新 listen,handler 永远不变。
 */
export function wrapPgClient(client: PgClientLike): PostgresNotifiable {
  return {
    query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[]
    ): Promise<{ rows: Row[] }> {
      /*
       * query 与 listen 共用同一个 client 是危险的:pg.Client 长连接在
       * 持有 LISTEN 时,如果其他 query 引起协议错(例如 CONNECTION_CLOSED),
       * LISTEN 会一并失效。生产最佳实践是 listen 用独立 client,query
       * 用连接池——但这超出本 adapter 职责范围。
       *
       * 此处直接转发,留作 caller 责任:可以传入 pool.query 包装的对象,
       * 也可以传入专用的 listen client。
       */
      return client.query(sql, parameters) as Promise<{ rows: Row[] }>;
    },

    async listen(
      channel: string,
      callback: (payload: string) => void
    ): Promise<() => Promise<void>> {
      /*
       * 注册 'notification' 事件 listener——pg.Client 收到 NOTIFY 时
       * 触发该事件,msg.channel / msg.payload 字段。
       * 我们过滤 channel 但不抛错:如果 client 收到其他 channel 的
       * NOTIFY,handler 不应被调(避免泄漏)。
       */
      const notificationListener = (msg: {
        channel?: string;
        payload?: string;
      }) => {
        if (msg.channel === channel && typeof msg.payload === "string") {
          try {
            callback(msg.payload);
          } catch {
            // 隔离 handler 错误,不打断 listener 链
          }
        }
      };
      client.on("notification", notificationListener);

      /*
       * 首次订阅执行 LISTEN SQL:pg server 端建立 channel → session 映射,
       * 之后该 session 的 NOTIFY 才会派发到 client。
       */
      await client.query(`LISTEN ${quoteIdentifier(channel)}`);

      return async (): Promise<void> => {
        client.removeListener("notification", notificationListener);
        /*
         * UNLISTEN SQL 释放 server 端资源——避免长跑 client LISTEN 累积。
         * pg-ears README 提到的"LISTEN leaks"问题就是缺少这一步。
         * 注意:UNLISTEN 失败不应阻止 stop 幂等——catch 忽略。
         */
        try {
          await client.query(`UNLISTEN ${quoteIdentifier(channel)}`);
        } catch {
          // ignore: stop 失败不影响幂等性
        }
      };
    },

    onClientDisconnect(handler: () => void): () => void {
      /*
       * 'error' + 'end' 都视为 disconnect——adapter 转给 cancelBus 状态机。
       * 多个 disconnect 事件可能连续触发(error 后通常紧跟 end),
       * cancelBus 状态机应能容忍重复 scheduleReconnect(内部 stopped 检查 + 幂等)。
       */
      const errorListener = (): void => {
        try {
          handler();
        } catch {
          // 隔离 handler 错误
        }
      };
      const endListener = (): void => {
        try {
          handler();
        } catch {
          // 隔离 handler 错误
        }
      };
      client.on("error", errorListener);
      client.on("end", endListener);

      return () => {
        client.removeListener("error", errorListener);
        client.removeListener("end", endListener);
      };
    }
  };
}

/**
 * 引用 channel 标识符,防止 SQL 注入。
 * PG identifier 规则:必须以字母/下划线开头,后续可含字母/数字/下划线;
 * 我们的 channel 命名固定(`run_engine_cancel`),但防御性引用是良好实践。
 */
function quoteIdentifier(channel: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(channel)) {
    throw new Error(`Invalid PG channel identifier: ${channel}`);
  }
  return `"${channel}"`;
}