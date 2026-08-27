import { describe, expect, it, vi } from "vitest";
import type { WorkerDatabase, WorkerRuntime } from "../src/index.js";
import { runPostgresWorkerSmoke } from "../src/postgres-smoke.js";

const REQUIRED_TABLES = [
  "run_engine_leases",
  "run_engine_runs",
  "run_engine_steering_messages",
  "run_engine_tool_calls",
  "run_event_counters",
  "run_event_outbox",
  "run_events"
];

const RECOVERY_QUEUES = [
  "lecoding-run-recovery",
  "lecoding-run-recovery-scan"
];

describe("PostgreSQL Worker smoke", () => {
  it("reports only the verified lifecycle and durable surfaces", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("information_schema.tables")) {
        return { rows: REQUIRED_TABLES.map((table_name) => ({ table_name })) };
      }
      if (sql.includes("pgboss.queue")) {
        return { rows: RECOVERY_QUEUES.map((name) => ({ name })) };
      }
      throw new Error("Unexpected smoke query");
    });
    const close = vi.fn(async () => undefined);
    const database = {
      executor: { query },
      notifications: {},
      close
    } as unknown as WorkerDatabase;
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const runtime = {
      control: { projectIds: ["secret-project"] },
      start,
      stop
    } as unknown as WorkerRuntime;

    const report = await runPostgresWorkerSmoke({
      environment: {},
      createDatabase: vi.fn(async () => database),
      composeWorker: vi.fn(async () => runtime)
    });

    expect(report).toEqual({
      status: "passed",
      checks: {
        database: "ready",
        workerLifecycle: "started-and-stopped",
        projectRegistrations: 1,
        requiredTables: REQUIRED_TABLES,
        recoveryQueues: RECOVERY_QUEUES
      }
    });
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    // Runtime shutdown owns database cleanup after successful composition.
    expect(close).not.toHaveBeenCalled();
  });
});
