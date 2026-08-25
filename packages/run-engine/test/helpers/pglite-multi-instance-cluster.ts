import { PGlite } from "@electric-sql/pglite";
import {
  createPostgresRunCancelBus,
  wrapPglite
} from "../../src/postgres-run-cancel-bus.js";
import type { RunCancelBus } from "../../src/run-cancel-bus.js";

/**
 * PGlite 多实例 cancel bus 测试 fixture。
 *
 * 与 pglite-cancel-bus-cluster.ts(单 PGlite 多 session)的区别:
 * 这里每个 worker 持有**独立**的 PGlite 实例。
 *
 * 关键事实(已实测,PGlite 0.5.5):
 * - PGlite 实例是独立的 WASM Postgres 内核,没有 server/TCP 模式;
 *   实例间 LISTEN/NOTIFY 不互通(worker-B 实例上 publish,worker-A
 *   实例的 listen session 收不到)。
 * - 即使共享同一 dataDir,并发运行期的写读也不互通(dataDir 只是
 *   冷启动时的初始快照)——因此本 fixture 不给多实例传共享 dataDir,
 *   每个实例内存独立即可。
 *
 * 因此本 fixture 模拟的是真实世界里的**跨 server 隔离 / cancelBus 断连**
 * 场景:worker-A 与 worker-B 各自监听完全不同的 Postgres,worker-B 的
 * publish 永远到不了 worker-A。它验证的是 subscribe 隔离语义的边界,
 * 与单实例多 session fanout 是互补角度:
 *   - 单实例多 session:NOTIFY 在心共享 server 内的是 fanout
 *   - 多实例:NOTIFY 绝不跨界
 *
 * 用法:
 * ```ts
 * const cluster = await createPGliteMultiInstanceCluster();
 * const busA = cluster.createBus("worker-A"); // 独立 PGlite 实例
 * const busB = cluster.createBus("worker-B"); // 独立 PGlite 实例
 * const receivedA: string[] = [];
 * await busA.subscribe((runId) => receivedA.push(runId));
 * await busB.publish("run-1");
 * await new Promise((r) => setTimeout(r, 100));
 * expect(receivedA).toEqual([]); // 跨实例 NOTIFY 不互通
 * await cluster.close();
 * ```
 */
export interface PGliteMultiInstanceCluster {
  /** 创建一个携带独立 PGlite 实例的 cancelBus。 */
  createBus(workerId: string): RunCancelBus;
  /** 关闭所有已创建的 PGlite 实例。 */
  close(): Promise<void>;
}

export async function createPGliteMultiInstanceCluster(): Promise<PGliteMultiInstanceCluster> {
  const instances: PGlite[] = [];
  return {
    createBus(_workerId: string): RunCancelBus {
      // 每个 bus 一个全新 PGlite 实例:内存态相互独立,NOTIFY 绝不跨界
      const pg = new PGlite();
      instances.push(pg);
      const bus = createPostgresRunCancelBus(wrapPglite(pg));
      return {
        publish: bus.publish,
        subscribe: bus.subscribe
      };
    },
    async close() {
      await Promise.all(instances.map((pg) => pg.close()));
      instances.length = 0;
    }
  };
}