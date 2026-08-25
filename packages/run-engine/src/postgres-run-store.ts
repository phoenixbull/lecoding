import {
  RunConflictError,
  type RunStore,
  type StoredRun
} from "./index.js";
import type { PostgresExecutor } from "./postgres-run-lease.js";

/** PostgreSQL schema for durable Run snapshots. */
export const RUN_STORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_engine_runs (
  run_id text PRIMARY KEY,
  version bigint NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * Creates a durable RunStore whose compare-and-swap version survives Worker restarts.
 * Callers must persist only JSON-safe Run snapshots.
 */
export async function createPostgresRunStore(
  database: PostgresExecutor
): Promise<RunStore> {
  await database.query(RUN_STORE_SCHEMA_SQL);
  return new PostgresRunStore(database);
}

class PostgresRunStore implements RunStore {
  constructor(private readonly database: PostgresExecutor) {}

  async save(run: StoredRun): Promise<number> {
    const { version: expectedVersion, ...snapshot } = run;
    const result = await this.database.query<{ version: string | number }>(
      `
      WITH updated AS (
        UPDATE run_engine_runs
        SET version = version + 1,
            snapshot = $3::jsonb,
            updated_at = CURRENT_TIMESTAMP
        WHERE run_id = $1::text AND version = $2::bigint
        RETURNING version
      ), inserted AS (
        INSERT INTO run_engine_runs (run_id, version, snapshot)
        SELECT $1::text, 1, $3::jsonb
        WHERE $2::bigint = 0 AND NOT EXISTS (SELECT 1 FROM updated)
        ON CONFLICT (run_id) DO NOTHING
        RETURNING version
      )
      SELECT version FROM updated
      UNION ALL
      SELECT version FROM inserted;
      `,
      [run.id, expectedVersion, JSON.stringify(snapshot)]
    );
    const persistedVersion = Number(result.rows[0]?.version);
    if (!Number.isSafeInteger(persistedVersion) || persistedVersion < 1) {
      // A missing RETURNING row means another writer advanced the snapshot first.
      throw new RunConflictError(run.id);
    }
    return persistedVersion;
  }

  async get(runId: string): Promise<StoredRun | undefined> {
    const result = await this.database.query<{
      version: string | number;
      snapshot: Omit<StoredRun, "version">;
    }>(
      `SELECT version, snapshot FROM run_engine_runs WHERE run_id = $1::text;`,
      [runId]
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error("PostgreSQL returned an invalid Run version");
    }
    // The version column remains authoritative so stale JSON cannot bypass CAS.
    return { ...row.snapshot, version };
  }
}
