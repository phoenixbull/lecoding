import { PGlite } from "@electric-sql/pglite";
import {
  createPostgresRunCancelBus,
  wrapPglite,
  type PostgresNotifiable
} from "../../src/postgres-run-cancel-bus.js";
import type { RunCancelBus } from "../../src/run-cancel-bus.js";

/**
 * PGlite 多 session cancel bus 测试 fixture。
 *
 * PGlite 是单进程 embedded Postgres。与早期假设不同——已实测 PGlite
 * 0.5.5 允许两个独立 PGlite 实例共享同一 dataDir(无独占 lock 冲突),
 * 但共享 dataDir 的实例运行期数据与 NOTIFY 都互不互通(dataDir 只是
 * 冷启动初始快照;PGlite 是独立 WASM 内核,无 server/TCP 模式)。
 *
 * 因此本 fixture 用"单 PGlite 实例内的多个并发 listen session"模拟真实
 * PG server 上多 worker 进程共享同一连接的语义(这是唯一可行的近似,
 * 见同目录 pglite-multi-instance-cluster.ts 的隔离边界验证):
 *
 *   - 每个 listen() 在 PGlite 内部创建一个独立 session
 *   - NOTIFY 派发到所有正在 listen 的 session(跨 session fanout)
 *   - unlisten 只影响该 session,其他 session 仍工作
 *
 * 因此"单 PGlite + 多 cancelBus 实例"可以替代"多 worker + 真实 PG server",
 * 在单测环境下验证跨 worker 语义。
 *
 * 设计:cluster.createBus(workerId) 返回一个**完整 RunCancelBus**(可被
 * RunEngine 直接注入)。测试需要断言时,自己通过 bus.subscribe(handler)
 * 注册一个 spy handler 收集 received——这样 engine.dispose() 会同时
 * stop engine 自己的 handler 和 spy handler,无独立 collector。
 *
 * 用法:
 * ```ts
 * const cluster = await createPGliteCancelBusCluster();
 * const busA = cluster.createBus("worker-A");
 * const busB = cluster.createBus("worker-B");
 * const receivedB: string[] = [];
 * await busB.subscribe((runId) => receivedB.push(runId));
 * await busA.publish("run-1");
 * await new Promise((r) => setTimeout(r, 100));
 * expect(receivedB).toEqual(["run-1"]);
 * await cluster.close();
 * ```
 */
export interface PGliteCancelBusCluster {
  /** 创建一个新 worker 的 cancelBus。每个 bus 是独立 listen session。 */
  createBus(workerId: string): RunCancelBus;
  /** 关闭底层 PGlite 实例,所有 bus 自动失效。 */
  close(): Promise<void>;
}

export async function createPGliteCancelBusCluster(): Promise<PGliteCancelBusCluster> {
  const pg = new PGlite();
  /*
   * 每个 workerId 对应一个独立 listen session(独立 db.listen 调用)。
   * cluster 不再内部 collector——由测试侧按需订阅 spy handler。
   */
  return {
    createBus(workerId: string): RunCancelBus {
      const bus = createPostgresRunCancelBus(wrapPglite(pg));
      return {
        publish: bus.publish,
        subscribe: bus.subscribe
      };
      // 保留 workerId 仅作调试/未来扩展;当前不参与逻辑
      void workerId;
    },
    async close() {
      await pg.close();
    }
  };
}