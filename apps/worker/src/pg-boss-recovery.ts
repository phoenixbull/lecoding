import PgBoss from "pg-boss";
import type {
  PostgresExecutor,
  RecoveryJobQueue,
  RecoveryQueueOptions,
  RecoverySendOptions,
  RecoveryWorkOptions
} from "@lecoding/run-engine";

/** Production queue adapter inputs; pg-boss reuses the Worker-owned pg pool. */
export interface PgBossRecoveryQueueOptions {
  executor: PostgresExecutor;
  /** Receives stable lifecycle handling without making EventEmitter errors fatal. */
  onError?: (error: unknown) => void;
}

/** Recovery queue plus exact queue cleanup used by isolated operational smokes. */
export interface ProductionPgBossRecoveryQueue extends RecoveryJobQueue {
  deleteQueue(name: string): Promise<void>;
}

/**
 * Adapts pg-boss 10.x batch callbacks to RunEngine's single-job recovery seam.
 * The external DB adapter ensures pg-boss never owns or closes the Worker pool.
 */
export function createProductionPgBossRecoveryQueue(
  options: PgBossRecoveryQueueOptions
): ProductionPgBossRecoveryQueue {
  const boss = new PgBoss({
    db: {
      async executeSql(text: string, values: unknown[]) {
        return options.executor.query<Record<string, unknown>>(text, values);
      }
    }
  });
  // EventEmitter treats an unhandled `error` event as process-fatal.
  boss.on("error", (error) => {
    try {
      options.onError?.(error);
    } catch {
      // Observability callbacks cannot become a second queue failure channel.
    }
  });

  return {
    async start() {
      await boss.start();
    },
    async stop(stopOptions) {
      await boss.stop({
        ...stopOptions,
        wait: true,
        close: false
      });
    },
    async createQueue(name: string, queueOptions?: RecoveryQueueOptions) {
      await boss.createQueue(
        name,
        queueOptions ? { name, ...queueOptions } : undefined
      );
    },
    async deleteQueue(name: string) {
      // pg-boss deletes only this named queue and its partition-owned jobs.
      await boss.deleteQueue(name);
    },
    send(name: string, data = {}, sendOptions?: RecoverySendOptions) {
      return sendOptions
        ? boss.send(name, data, sendOptions)
        : boss.send(name, data);
    },
    work(
      name: string,
      workOptions: RecoveryWorkOptions,
      handler: (job: { data: unknown }) => Promise<void>
    ) {
      return boss.work<unknown>(name, workOptions, async (jobs) => {
        // One failed Run rejects the batch so pg-boss persists its retry attempt.
        await Promise.all(jobs.map((job) => handler({ data: job.data })));
      });
    }
  };
}
