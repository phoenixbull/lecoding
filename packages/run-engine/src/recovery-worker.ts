import type { RunId, RunResumer } from "@lecoding/contracts";
import type { PostgresExecutor } from "./postgres-run-lease.js";

/**
 * 恢复 Worker:后台扫描过期 lease,自动调用 RunResumer.resume 接管。
 * 生产环境用 pg-boss 替换;当前实现是 setInterval 轮询版(tracer bullet)。
 *
 * 语义约束:
 * - start() 幂等(已启动则 no-op)
 * - stop() 幂等;返回当前正在执行的扫描周期结束后的 Promise
 * - 扫描周期内对每条过期 lease 调一次 resumer.resume;
 *   resume 自身幂等(isDriverStartable + lease 抢锁),重复触发安全
 */
export interface RunRecoveryWorker {
  start(): void;
  stop(): Promise<void>;
}

export interface IntervalRecoveryWorkerOptions {
  executor: PostgresExecutor;
  resumer: RunResumer;
  /** 扫描间隔,默认 5000ms。测试可缩短。 */
  intervalMs?: number;
  /** 注入时钟,用于判定 lease 过期。缺省为 Date.now。 */
  now?: () => string;
}

export function createIntervalRecoveryWorker(
  options: IntervalRecoveryWorkerOptions
): RunRecoveryWorker {
  const intervalMs = options.intervalMs ?? 5000;
  const now = options.now ?? (() => new Date().toISOString());
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  let currentCycle: Promise<void> | undefined;
  /** 正在恢复中的 Run:避免同一轮扫描内或跨轮重复触发。 */
  const inFlight = new Set<RunId>();

  async function scanAndResume(): Promise<void> {
    try {
      const expired = await findExpiredLeases(options.executor, now());
      for (const runId of expired) {
        if (stopping) {
          return;
        }
        if (inFlight.has(runId)) {
          // 上一次恢复还在进行中,跳过
          continue;
        }
        inFlight.add(runId);
        // resume 已内置幂等闸门(isDriverStartable + lease 竞争)
        // 与正常调度路径完全相同。无论成功失败,完成后从 inFlight 移除,
        // 下一轮扫描可以重新评估(例如上次恢复失败,这次可以重试)。
        void options.resumer
          .resume(runId)
          .catch(() => {
            // 单个 Run 恢复失败不中断整体扫描;生产记录 metrics 即可。
          })
          .finally(() => {
            inFlight.delete(runId);
          });
      }
    } catch (error) {
      // 扫描周期内的错误不应中断 worker
      // (例如 PG 短暂不可达)。
      // 生产环境应记录 metrics;tracer bullet 阶段静默重试。
      console.warn("Recovery worker scan failed:", error);
    }
  }

  return {
    start() {
      if (timer !== undefined) {
        return;
      }
      stopping = false;
      timer = setInterval(() => {
        if (stopping) {
          return;
        }
        // 串行:上一轮没结束就跳过本轮,避免堆积
        if (currentCycle) {
          return;
        }
        currentCycle = scanAndResume().finally(() => {
          currentCycle = undefined;
        });
      }, intervalMs);
    },

    async stop() {
      if (timer === undefined) {
        return;
      }
      stopping = true;
      clearInterval(timer);
      timer = undefined;
      if (currentCycle) {
        await currentCycle;
      }
    }
  };
}

async function findExpiredLeases(
  executor: PostgresExecutor,
  nowIso: string
): Promise<RunId[]> {
  const { rows } = await executor.query<{ run_id: string }>(
    `
    SELECT run_id
      FROM run_engine_leases
     WHERE lease_until < $1::timestamptz
     ORDER BY lease_until ASC
     LIMIT 50;
    `,
    [nowIso]
  );
  return rows.map((row) => row.run_id);
}
