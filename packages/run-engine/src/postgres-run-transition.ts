import type { RunStatus } from "@lecoding/contracts";
import { RUN_EVENT_SCHEMA_SQL } from "@lecoding/run-events";
import {
  RunConflictError,
  type StoredRun
} from "./index.js";
import type { PostgresExecutor } from "./postgres-run-lease.js";
import { RUN_STORE_SCHEMA_SQL } from "./postgres-run-store.js";

/** Atomic persistence seam for one Run status transition and its durable event. */
export interface RunTransitionWriter {
  persist(run: StoredRun, status: RunStatus): Promise<number>;
}

/** Construction inputs for deterministic status-event timestamps. */
export interface PostgresRunTransitionWriterOptions {
  database: PostgresExecutor;
  now(): string;
}

/**
 * Creates a writer that commits Run state, RunEvent, and delivery outbox together.
 * The returned version is the only snapshot version callers may use afterwards.
 */
export async function createPostgresRunTransitionWriter(
  options: PostgresRunTransitionWriterOptions
): Promise<RunTransitionWriter> {
  await options.database.query(RUN_STORE_SCHEMA_SQL);
  // The shared executor seam models prepared queries, so initialize each DDL separately.
  for (const statement of RUN_EVENT_SCHEMA_SQL.split(";")) {
    if (statement.trim() !== "") {
      await options.database.query(`${statement};`);
    }
  }
  return new PostgresRunTransitionWriter(options);
}

class PostgresRunTransitionWriter implements RunTransitionWriter {
  constructor(private readonly options: PostgresRunTransitionWriterOptions) {}

  async persist(run: StoredRun, status: RunStatus): Promise<number> {
    const { version: expectedVersion, ...previousSnapshot } = run;
    const snapshot = { ...previousSnapshot, status };
    const occurredAt = this.options.now();
    const result = await this.options.database.query<{
      version: string | number;
      sequence: string | number;
    }>(
      `
      WITH updated_run AS (
        UPDATE run_engine_runs
        SET version = version + 1,
            snapshot = $3::jsonb,
            updated_at = CURRENT_TIMESTAMP
        WHERE run_id = $1::text AND version = $2::bigint
        RETURNING version
      ), inserted_run AS (
        INSERT INTO run_engine_runs (run_id, version, snapshot)
        SELECT $1::text, 1, $3::jsonb
        WHERE $2::bigint = 0 AND NOT EXISTS (SELECT 1 FROM updated_run)
        ON CONFLICT (run_id) DO NOTHING
        RETURNING version
      ), persisted_run AS (
        SELECT version FROM updated_run
        UNION ALL
        SELECT version FROM inserted_run
      ), allocated AS (
        INSERT INTO run_event_counters (run_id, next_sequence)
        SELECT $1::text, 2 FROM persisted_run
        ON CONFLICT (run_id) DO UPDATE
          SET next_sequence = run_event_counters.next_sequence + 1
        RETURNING next_sequence - 1 AS sequence
      ), inserted_event AS (
        INSERT INTO run_events (
          run_id, sequence, version, event_type, occurred_at, data
        )
        SELECT $1::text, sequence, 1, 'status_changed', $4::timestamptz, $5::jsonb
        FROM allocated
        RETURNING sequence
      ), queued AS (
        INSERT INTO run_event_outbox (run_id, event_sequence)
        SELECT $1::text, sequence FROM inserted_event
        RETURNING event_sequence
      )
      SELECT persisted_run.version, inserted_event.sequence
      FROM persisted_run
      INNER JOIN inserted_event ON true
      INNER JOIN queued ON queued.event_sequence = inserted_event.sequence;
      `,
      [
        run.id,
        expectedVersion,
        JSON.stringify(snapshot),
        occurredAt,
        JSON.stringify({ status })
      ]
    );
    const version = Number(result.rows[0]?.version);
    const sequence = Number(result.rows[0]?.sequence);
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    ) {
      // No returned row means the snapshot CAS failed, so no event was allocated.
      throw new RunConflictError(run.id);
    }
    return version;
  }
}
