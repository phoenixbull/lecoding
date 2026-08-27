import type { ModelEnvironment } from "@lecoding/openai-model";
import {
  composeProductionWorker,
  type ProductionWorkerOptions,
  type WorkerDatabase,
  type WorkerRuntime
} from "./index.js";
import { createPostgresWorkerDatabase } from "./postgres-database.js";

const REQUIRED_TABLES = [
  "run_engine_leases",
  "run_engine_runs",
  "run_engine_steering_messages",
  "run_engine_tool_calls",
  "run_event_counters",
  "run_event_outbox",
  "run_events"
] as const;

const RECOVERY_QUEUES = [
  "lecoding-run-recovery",
  "lecoding-run-recovery-scan"
] as const;

/** Secret-free evidence emitted after a real production Worker startup and shutdown. */
export interface PostgresWorkerSmokeReport {
  status: "passed";
  checks: {
    database: "ready";
    workerLifecycle: "started-and-stopped";
    projectRegistrations: number;
    requiredTables: readonly string[];
    recoveryQueues: readonly string[];
  };
}

/** Injectable deployment seams keep the command-level smoke contract testable. */
export interface PostgresWorkerSmokeOptions {
  environment: ModelEnvironment;
  createDatabase?: (environment: ModelEnvironment) => Promise<WorkerDatabase>;
  composeWorker?: (options: ProductionWorkerOptions) => Promise<WorkerRuntime>;
}

/**
 * Starts the production composition root, verifies its durable PostgreSQL
 * surfaces, and shuts it down without creating a Run or contacting a model.
 */
export async function runPostgresWorkerSmoke(
  options: PostgresWorkerSmokeOptions
): Promise<PostgresWorkerSmokeReport> {
  const backgroundErrors: unknown[] = [];
  const createDatabase =
    options.createDatabase ??
    ((environment: ModelEnvironment) =>
      createPostgresWorkerDatabase({
        environment,
        onUnexpectedError: (error) => backgroundErrors.push(error)
      }));
  const composeWorker = options.composeWorker ?? composeProductionWorker;
  const database = await createDatabase(options.environment);
  const runtime = await composeWorker({
    database,
    environment: options.environment,
    onBackgroundError: (error) => backgroundErrors.push(error)
  });

  let report: PostgresWorkerSmokeReport;
  try {
    await runtime.start();
    const requiredTables = await readRequiredTables(database);
    const recoveryQueues = await readRecoveryQueues(database);
    if (backgroundErrors.length > 0) {
      throw new Error("Worker background processing failed during PostgreSQL smoke");
    }
    report = {
      status: "passed",
      checks: {
        database: "ready",
        workerLifecycle: "started-and-stopped",
        projectRegistrations: runtime.control.projectIds.length,
        requiredTables,
        recoveryQueues
      }
    };
  } finally {
    // Runtime teardown also proves pg-boss releases the externally owned pool.
    await runtime.stop();
  }
  return report;
}

async function readRequiredTables(database: WorkerDatabase): Promise<string[]> {
  const result = await database.executor.query<{ table_name: string }>(
    `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    ORDER BY table_name;
    `,
    [[...REQUIRED_TABLES]]
  );
  return requireExactNames(
    "Worker PostgreSQL tables",
    REQUIRED_TABLES,
    result.rows.map((row) => row.table_name)
  );
}

async function readRecoveryQueues(database: WorkerDatabase): Promise<string[]> {
  const result = await database.executor.query<{ name: string }>(
    `
    SELECT name
    FROM pgboss.queue
    WHERE name = ANY($1::text[])
    ORDER BY name;
    `,
    [[...RECOVERY_QUEUES]]
  );
  return requireExactNames(
    "pg-boss recovery queues",
    RECOVERY_QUEUES,
    result.rows.map((row) => row.name)
  );
}

function requireExactNames(
  label: string,
  expected: readonly string[],
  actual: readonly string[]
): string[] {
  const sortedExpected = [...expected].sort();
  const sortedActual = [...actual].sort();
  if (
    sortedExpected.length !== sortedActual.length ||
    sortedExpected.some((name, index) => name !== sortedActual[index])
  ) {
    // Keep failure text independent of database contents and deployment names.
    throw new Error(`${label} are incomplete`);
  }
  return sortedActual;
}
