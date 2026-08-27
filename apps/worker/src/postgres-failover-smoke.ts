import { randomUUID } from "node:crypto";
import type { ModelEnvironment } from "@lecoding/openai-model";
import {
  createPgBossRecoveryWorker,
  createPostgresRunLease,
  createPostgresRunStore,
  type RunRecoveryWorker
} from "@lecoding/run-engine";
import type { WorkerDatabase } from "./index.js";
import { createPostgresWorkerDatabase } from "./postgres-database.js";
import {
  createProductionPgBossRecoveryQueue,
  type ProductionPgBossRecoveryQueue
} from "./pg-boss-recovery.js";

/** Secret-free evidence for a two-Worker claim against one real PostgreSQL service. */
export interface PostgresFailoverSmokeReport {
  status: "passed";
  checks: {
    recoveryWorkers: 2;
    expiredRunClaims: 1;
    distinctClaimers: 1;
    isolatedFixtureCleanup: "complete";
  };
}

/** Database creation seam shared by the real command and compatible integration test. */
export interface PostgresFailoverSmokeOptions {
  environment: ModelEnvironment;
  createDatabase?: (environment: ModelEnvironment) => Promise<WorkerDatabase>;
}

/**
 * Runs two independent pg-boss consumers against one exact expired fixture.
 * Dedicated queue names and a Run allowlist prevent interaction with real Runs.
 */
export async function runPostgresFailoverSmoke(
  options: PostgresFailoverSmokeOptions
): Promise<PostgresFailoverSmokeReport> {
  const backgroundErrors: unknown[] = [];
  const createDatabase =
    options.createDatabase ??
    ((environment: ModelEnvironment) =>
      createPostgresWorkerDatabase({
        environment,
        onUnexpectedError: (error) => backgroundErrors.push(error)
      }));
  const token = randomUUID().replaceAll("-", "");
  const runId = `smoke_failover_${token}`;
  const queueNames = {
    scan: `lecoding_smoke_${token}_scan`,
    run: `lecoding_smoke_${token}_run`
  };
  const databases: WorkerDatabase[] = [];
  const queues: ProductionPgBossRecoveryQueue[] = [];
  const workers: RunRecoveryWorker[] = [];
  const claims: string[] = [];
  let fixtureCreated = false;
  let report: PostgresFailoverSmokeReport | undefined;
  let operationError: unknown;

  try {
    const first = await createDatabase(options.environment);
    databases.push(first);
    const second = await createDatabase(options.environment);
    databases.push(second);
    await createPostgresRunStore(first.executor);
    await createPostgresRunLease(first.executor);
    await first.executor.query(
      `
      INSERT INTO run_engine_runs (run_id, version, snapshot)
      VALUES ($1::text, 1, '{"status":"running"}'::jsonb);
      `,
      [runId]
    );
    await first.executor.query(
      `
      INSERT INTO run_engine_leases (run_id, owner_id, lease_until, generation)
      VALUES ($1::text, 'smoke-dead-worker',
              CURRENT_TIMESTAMP - INTERVAL '1 minute', 1);
      `,
      [runId]
    );
    fixtureCreated = true;

    for (const [index, database] of databases.entries()) {
      const queue = createProductionPgBossRecoveryQueue({
        executor: database.executor,
        onError: (error) => backgroundErrors.push(error)
      });
      queues.push(queue);
      const workerName = `replacement-${index + 1}`;
      workers.push(
        createPgBossRecoveryWorker({
          queue,
          executor: database.executor,
          queueNames,
          runIdScope: [runId],
          scanIntervalSeconds: 1,
          resumer: {
            async resume(candidateRunId) {
              /* This CAS models the RunEngine lease gate without invoking a model. */
              const result = await database.executor.query<{ claimed: boolean }>(
                `
                UPDATE run_engine_leases
                   SET owner_id = $2::text,
                       lease_until = CURRENT_TIMESTAMP + INTERVAL '5 minutes',
                       generation = generation + 1
                 WHERE run_id = $1::text
                   AND lease_until < CURRENT_TIMESTAMP
                RETURNING true AS claimed;
                `,
                [candidateRunId, workerName]
              );
              if (result.rows[0]?.claimed) {
                claims.push(workerName);
              }
            },
            async recoverEnvironment() {
              // The fixture has no worktree or container by design.
            }
          }
        })
      );
    }

    /*
     * Register both consumers before the first polling cycle. Serial migration
     * also keeps single-session PostgreSQL-compatible test adapters valid.
     */
    for (const worker of workers) {
      await worker.start();
    }
    await waitForSingleClaim(claims);
    if (backgroundErrors.length > 0) {
      throw new Error("Recovery processing failed during PostgreSQL failover smoke");
    }
    report = {
      status: "passed",
      checks: {
        recoveryWorkers: 2,
        // waitForSingleClaim established these literal evidence invariants.
        expiredRunClaims: 1,
        distinctClaimers: 1,
        isolatedFixtureCleanup: "complete"
      }
    };
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors = await cleanupSmoke({
    workers,
    queues,
    databases,
    queueNames,
    runId,
    fixtureCreated
  });
  if (operationError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      "PostgreSQL failover smoke and cleanup failed"
    );
  }
  if (operationError) {
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "PostgreSQL failover smoke cleanup failed");
  }
  return report!;
}

async function waitForSingleClaim(claims: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (claims.length === 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  if (claims.length !== 1) {
    throw new Error("Expected exactly one replacement Worker claim");
  }
}

async function cleanupSmoke(input: {
  workers: RunRecoveryWorker[];
  queues: ProductionPgBossRecoveryQueue[];
  databases: WorkerDatabase[];
  queueNames: { scan: string; run: string };
  runId: string;
  fixtureCreated: boolean;
}): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const worker of input.workers) {
    await worker.stop().catch((error) => errors.push(error));
  }
  const queue = input.queues[0];
  const database = input.databases[0];
  if (queue && database) {
    for (const name of [input.queueNames.scan, input.queueNames.run]) {
      // Workers are stopped, so every UUID-owned job state is safe to remove.
      await database.executor
        .query("DELETE FROM pgboss.job WHERE name = $1::text;", [name])
        .catch((error) => errors.push(error));
      await queue.deleteQueue(name).catch((error) => errors.push(error));
    }
  }
  if (database && input.fixtureCreated) {
    // Delete only the UUID-owned fixture; unrelated Run rows are never selected.
    await database.executor
      .query("DELETE FROM run_engine_leases WHERE run_id = $1::text;", [input.runId])
      .catch((error) => errors.push(error));
    await database.executor
      .query("DELETE FROM run_engine_runs WHERE run_id = $1::text;", [input.runId])
      .catch((error) => errors.push(error));
  }
  if (database && errors.length === 0) {
    const residue = await database.executor
      .query<{ remains: boolean }>(
        `
        SELECT
          EXISTS (SELECT 1 FROM run_engine_leases WHERE run_id = $1::text)
          OR EXISTS (SELECT 1 FROM run_engine_runs WHERE run_id = $1::text)
          OR EXISTS (
            SELECT 1 FROM pgboss.queue WHERE name = ANY($2::text[])
          ) AS remains;
        `,
        [input.runId, [input.queueNames.scan, input.queueNames.run]]
      )
      .catch((error) => {
        errors.push(error);
        return undefined;
      });
    if (residue?.rows[0]?.remains) {
      errors.push(new Error("PostgreSQL failover smoke cleanup left residue"));
    }
  }
  for (const owned of input.databases) {
    await owned.close().catch((error) => errors.push(error));
  }
  return errors;
}
