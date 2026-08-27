import type { RunId, RunResumer } from "@lecoding/contracts";
import type { PostgresExecutor } from "./postgres-run-lease.js";

/**
 * Recovery lifecycle shared by the production pg-boss scheduler and the
 * deterministic interval adapter retained for focused lease tests.
 */
export interface RunRecoveryWorker {
  start(): void | Promise<void>;
  stop(): Promise<void>;
}

/** Minimal pg-boss surface kept structural so RunEngine does not own connections. */
export interface RecoveryJobQueue {
  start(): Promise<void>;
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<void>;
  createQueue(name: string, options?: RecoveryQueueOptions): Promise<void>;
  send(
    name: string,
    data?: Record<string, unknown>,
    options?: RecoverySendOptions
  ): Promise<string | null>;
  work(
    name: string,
    options: RecoveryWorkOptions,
    handler: (job: { data: unknown }) => Promise<void>
  ): Promise<string>;
}

/** Queue-level retry and expiration controls used by recovery scheduling. */
export interface RecoveryQueueOptions {
  policy: "standard" | "short";
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  expireInSeconds: number;
}

/** Per-job de-duplication or deferral controls. */
export interface RecoverySendOptions {
  singletonKey?: string;
  singletonSeconds?: number;
  startAfter?: number;
}

/** Bounded pg-boss fetch size for one polling worker. */
export interface RecoveryWorkOptions {
  batchSize: number;
}

/** Inputs for the durable pg-boss recovery scheduler. */
export interface PgBossRecoveryWorkerOptions {
  queue: RecoveryJobQueue;
  executor: PostgresExecutor;
  resumer: RunResumer;
  /** Optional isolated queue names for bounded operational smoke tests. */
  queueNames?: RecoveryQueueNames;
  /** Optional exact Run allowlist; omitted production workers scan every project. */
  runIdScope?: readonly RunId[];
  /** Durable scan cadence; pg-boss `startAfter` is expressed in seconds. */
  scanIntervalSeconds?: number;
  /** Deterministic lease-expiry clock used by tests and production composition. */
  now?: () => string;
}

/** Queue pair that must be shared by every Worker in one recovery domain. */
export interface RecoveryQueueNames {
  scan: string;
  run: string;
}

const RECOVERY_SCAN_QUEUE = "lecoding-run-recovery-scan";
const RUN_RECOVERY_QUEUE = "lecoding-run-recovery";

/**
 * Creates a durable recovery scheduler: one chained scan job discovers expired
 * leases, while per-Run jobs provide SKIP LOCKED claiming and automatic retry.
 */
export function createPgBossRecoveryWorker(
  options: PgBossRecoveryWorkerOptions
): RunRecoveryWorker {
  const scanIntervalSeconds = options.scanIntervalSeconds ?? 5;
  if (!Number.isSafeInteger(scanIntervalSeconds) || scanIntervalSeconds < 1) {
    throw new Error("Recovery scan interval must be a positive integer");
  }
  const queueNames = options.queueNames ?? {
    scan: RECOVERY_SCAN_QUEUE,
    run: RUN_RECOVERY_QUEUE
  };
  validateQueueNames(queueNames);
  const runIdScope = options.runIdScope
    ? [...new Set(options.runIdScope.map(readScopedRunId))]
    : undefined;
  const now = options.now ?? (() => new Date().toISOString());
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let queueStarted = false;

  async function startQueue(): Promise<void> {
    try {
      await options.queue.start();
      queueStarted = true;
      await options.queue.createQueue(queueNames.scan, {
        // `short` keeps at most one future scan queued across all Worker processes.
        policy: "short",
        retryLimit: 20,
        retryDelay: scanIntervalSeconds,
        retryBackoff: true,
        expireInSeconds: Math.max(30, scanIntervalSeconds * 3)
      });
      await options.queue.createQueue(queueNames.run, {
        policy: "standard",
        retryLimit: 5,
        retryDelay: 5,
        retryBackoff: true,
        // RunEngine owns its finer lease heartbeat; this is only a crash ceiling.
        expireInSeconds: 43_200
      });
      await options.queue.work(
        queueNames.run,
        // A failed handler must retry only its own Run, never a successful batch peer.
        { batchSize: 1 },
        async (job) => {
          const runId = readRecoveryRunId(job.data);
          // Throwing delegates transient failure/backoff to pg-boss persistence.
          await options.resumer.resume(runId);
        }
      );
      await options.queue.work(
        queueNames.scan,
        { batchSize: 1 },
        async () => {
          const expired = await findRecoverableExpiredLeases(
            options.executor,
            now(),
            runIdScope
          );
          for (const runId of expired) {
            await options.queue.send(
              queueNames.run,
              { runId },
              {
                // Repeated scans coalesce one Run while its prior job is pending.
                singletonKey: runId,
                singletonSeconds: scanIntervalSeconds
              }
            );
          }
          // The next scan is committed before this job completes, surviving restarts.
          await options.queue.send(
            queueNames.scan,
            {},
            { startAfter: scanIntervalSeconds }
          );
        }
      );
      // Queue policy coalesces concurrent process startup into one pending scan.
      await options.queue.send(queueNames.scan, {});
    } catch (error) {
      if (queueStarted) {
        await options.queue.stop({ graceful: false }).catch(() => undefined);
        queueStarted = false;
      }
      throw error;
    }
  }

  return {
    start() {
      if (stopPromise) {
        return Promise.reject(new Error("Recovery worker has stopped"));
      }
      startPromise ??= startQueue();
      return startPromise;
    },
    stop() {
      if (stopPromise) {
        return stopPromise;
      }
      stopPromise = (async () => {
        await startPromise?.catch(() => undefined);
        if (queueStarted) {
          // Stop polling first and let active Run recovery finish before DB teardown.
          await options.queue.stop({ graceful: true, timeout: 30_000 });
          queueStarted = false;
        }
      })();
      return stopPromise;
    }
  };
}

function validateQueueNames(names: RecoveryQueueNames): void {
  for (const name of [names.scan, names.run]) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(name)) {
      throw new Error("Recovery queue names must use 1-128 safe characters");
    }
  }
  if (names.scan === names.run) {
    throw new Error("Recovery scan and Run queue names must differ");
  }
}

function readScopedRunId(runId: RunId): RunId {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(runId)) {
    throw new Error("Recovery Run scope contains an invalid identity");
  }
  return runId;
}

function readRecoveryRunId(data: unknown): RunId {
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    typeof (data as { runId?: unknown }).runId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/u.test((data as { runId: string }).runId)
  ) {
    throw new Error("Recovery job contains an invalid Run identity");
  }
  return (data as { runId: RunId }).runId;
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
    async start() {
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

async function findRecoverableExpiredLeases(
  executor: PostgresExecutor,
  nowIso: string,
  runIdScope?: readonly RunId[]
): Promise<RunId[]> {
  const scopeClause = runIdScope ? "AND run.run_id = ANY($2::text[])" : "";
  const { rows } = await executor.query<{ run_id: string }>(
    `
    SELECT lease.run_id
      FROM run_engine_leases AS lease
      JOIN run_engine_runs AS run ON run.run_id = lease.run_id
     WHERE lease.lease_until < $1::timestamptz
       AND run.snapshot->>'status' NOT IN ('succeeded', 'failed', 'cancelled')
       ${scopeClause}
     ORDER BY lease.lease_until ASC
     LIMIT 50;
    `,
    runIdScope ? [nowIso, runIdScope] : [nowIso]
  );
  return rows.map((row) => row.run_id);
}
