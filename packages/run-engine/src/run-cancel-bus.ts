import type { RunId } from "@lecoding/contracts";

/**
 * 跨进程 cancel 信号总线:
 * - publish(runId):通知持有该 Run 的 worker 中断正在进行的 perform
 *   (PG 实现用 NOTIFY;内存实现用 EventEmitter)。
 * - subscribe(handler):worker 进程启动时调用,handler 收到 runId 时
 *   调本地 handles.abort(runId) 触发 AbortSignal。
 *
 * 关键设计:
 * - publish 与 subscribe 是解耦的——发布者不需要订阅者存在;
 *   订阅者也不需要发布者在同一进程。这是 PG LISTEN/NOTIFY 的核心能力。
 * - handler 抛错被吞(不让一个订阅者挂掉其他订阅者或挂掉 publish)。
 */
export interface RunCancelBus {
  publish(runId: RunId): Promise<void>;
  /**
   * 注册订阅者;返回 stop() 用于 worker 关闭时取消订阅。生产 LISTEN
   * 清理可以异步,调用方必须 await 后再关闭底层数据库连接。
   */
  subscribe(
    handler: (runId: RunId) => void
  ): Promise<() => void | Promise<void>>;
}

/**
 * 测试用 / 同进程 fallback:用 EventEmitter 模拟 LISTEN/NOTIFY。
 * 生产 PG 实现见 PostgresRunCancelBus。
 */
export class InMemoryRunCancelBus implements RunCancelBus {
  private readonly subscribers: Set<(runId: RunId) => void> = new Set();

  async publish(runId: RunId): Promise<void> {
    /*
     * 同步派发所有 handler(内存里没有跨进程延迟)。
     * handler 抛错被吞,与 PG LISTEN 行为一致:
     * 每个 listener 独立处理,一个失败不影响其他。
     */
    for (const handler of this.subscribers) {
      try {
        handler(runId);
      } catch {
        // 隔离订阅者错误,不打断其他派发
      }
    }
  }

  async subscribe(handler: (runId: RunId) => void): Promise<() => void> {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }
}
