import {
  parseRunEvent,
  type RunEventV1,
  type RunId
} from "@lecoding/contracts";
import type { AppendRunEvent, RunEventRepository } from "./index.js";

/** Minimum query interface implemented by pg Pool/Client and the PGlite test adapter. */
export interface PostgresExecutor {
  query<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: unknown[]
  ): Promise<{ rows: Row[] }>;
}

/** One leased outbox record and its fully validated event. */
export interface RunEventOutboxClaim {
  id: string;
  event: RunEventV1;
}

/** Inputs for an explicit, deterministic delivery lease. */
export interface ClaimRunEventOutbox {
  workerId: string;
  limit: number;
  now: string;
  leaseUntil: string;
}

/** Inputs that let only the lease owner acknowledge successful delivery. */
export interface AckRunEventOutbox {
  workerId: string;
  claimIds: string[];
  deliveredAt: string;
}

/** Durable delivery seam consumed by a future SSE outbox dispatcher. */
export interface RunEventOutbox {
  claim(input: ClaimRunEventOutbox): Promise<RunEventOutboxClaim[]>;
  ack(input: AckRunEventOutbox): Promise<void>;
}

/**
 * Initial PostgreSQL schema for ordered events and their transactional outbox.
 * The counter row serializes sequence allocation independently for each Run.
 */
export const RUN_EVENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_event_counters (
  run_id text PRIMARY KEY,
  next_sequence bigint NOT NULL CHECK (next_sequence > 0)
);

CREATE TABLE IF NOT EXISTS run_events (
  run_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  version smallint NOT NULL CHECK (version = 1),
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, sequence)
);

CREATE TABLE IF NOT EXISTS run_event_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id text NOT NULL,
  event_sequence bigint NOT NULL,
  locked_by text,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, event_sequence),
  FOREIGN KEY (run_id, event_sequence)
    REFERENCES run_events (run_id, sequence)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS run_event_outbox_pending_idx
  ON run_event_outbox (id)
  WHERE delivered_at IS NULL;
`;

/** Creates a PostgreSQL repository whose append is event/outbox atomic. */
export function createPostgresRunEventRepository(
  database: PostgresExecutor
): RunEventRepository {
  return new PostgresRunEventRepository(database);
}

/** Creates the leased PostgreSQL outbox used by delivery workers. */
export function createPostgresRunEventOutbox(
  database: PostgresExecutor
): RunEventOutbox {
  return new PostgresRunEventOutbox(database);
}

class PostgresRunEventRepository implements RunEventRepository {
  constructor(private readonly database: PostgresExecutor) {}

  async append(input: AppendRunEvent): Promise<RunEventV1> {
    /*
     * One CTE statement allocates the sequence, inserts the event, and queues
     * delivery atomically. PostgreSQL rolls back every CTE if any insert fails.
     */
    const result = await this.database.query<{ sequence: string | number }>(
      `
      WITH allocated AS (
        INSERT INTO run_event_counters (run_id, next_sequence)
        VALUES ($1, 2)
        ON CONFLICT (run_id) DO UPDATE
          SET next_sequence = run_event_counters.next_sequence + 1
        RETURNING next_sequence - 1 AS sequence
      ), inserted_event AS (
        INSERT INTO run_events (
          run_id, sequence, version, event_type, occurred_at, data
        )
        SELECT $1, sequence, $2, $3, $4::timestamptz, $5::jsonb
        FROM allocated
        RETURNING sequence
      ), queued AS (
        INSERT INTO run_event_outbox (run_id, event_sequence)
        SELECT $1, sequence FROM inserted_event
        RETURNING event_sequence
      )
      SELECT inserted_event.sequence
      FROM inserted_event
      INNER JOIN queued
        ON queued.event_sequence = inserted_event.sequence
      `,
      [
        input.runId,
        input.version,
        input.type,
        input.occurredAt,
        JSON.stringify(input.data)
      ]
    );
    const sequence = parseSequence(result.rows[0]?.sequence);
    return parseRunEvent({
      version: 1,
      sequence,
      runId: input.runId,
      type: input.type,
      occurredAt: input.occurredAt,
      data: input.data
    });
  }

  async readAfter(runId: RunId, sequence: number): Promise<RunEventV1[]> {
    const result = await this.database.query<PostgresEventRow>(
      `
      SELECT
        version,
        sequence,
        run_id,
        event_type,
        to_char(
          occurred_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS occurred_at,
        data
      FROM run_events
      WHERE run_id = $1 AND sequence > $2
      ORDER BY sequence ASC
      `,
      [runId, sequence]
    );
    return result.rows.map(parseEventRow);
  }
}

class PostgresRunEventOutbox implements RunEventOutbox {
  constructor(private readonly database: PostgresExecutor) {}

  async claim(input: ClaimRunEventOutbox): Promise<RunEventOutboxClaim[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
      throw new Error("Outbox claim limit must be between 1 and 1000");
    }
    if (input.workerId.trim() === "") {
      throw new Error("Outbox workerId must not be empty");
    }

    /*
     * SKIP LOCKED lets multiple dispatchers claim different rows concurrently.
     * The lease update and returned event snapshot happen in one SQL statement.
     */
    const result = await this.database.query<PostgresOutboxRow>(
      `
      WITH candidates AS (
        SELECT id
        FROM run_event_outbox
        WHERE delivered_at IS NULL
          AND (lease_until IS NULL OR lease_until <= $2::timestamptz)
        ORDER BY id ASC
        LIMIT $3::integer
        FOR UPDATE SKIP LOCKED
      ), leased AS (
        UPDATE run_event_outbox AS outbox
        SET
          locked_by = $1,
          lease_until = $4::timestamptz,
          attempts = outbox.attempts + 1
        FROM candidates
        WHERE outbox.id = candidates.id
        RETURNING outbox.id, outbox.run_id, outbox.event_sequence
      )
      SELECT
        leased.id,
        event.version,
        event.sequence,
        event.run_id,
        event.event_type,
        to_char(
          event.occurred_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS occurred_at,
        event.data
      FROM leased
      INNER JOIN run_events AS event
        ON event.run_id = leased.run_id
        AND event.sequence = leased.event_sequence
      ORDER BY leased.id ASC
      `,
      [input.workerId, input.now, input.limit, input.leaseUntil]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      event: parseEventRow(row)
    }));
  }

  async ack(input: AckRunEventOutbox): Promise<void> {
    if (input.claimIds.length === 0) {
      return;
    }
    const result = await this.database.query<{ id: string | number }>(
      `
      UPDATE run_event_outbox
      SET
        delivered_at = $3::timestamptz,
        lease_until = NULL
      WHERE locked_by = $1
        AND id = ANY($2::bigint[])
        AND delivered_at IS NULL
      RETURNING id
      `,
      [input.workerId, input.claimIds, input.deliveredAt]
    );
    if (result.rows.length !== input.claimIds.length) {
      throw new Error("Outbox acknowledgement did not own every claim");
    }
  }
}

interface PostgresEventRow extends Record<string, unknown> {
  version: number;
  sequence: string | number;
  run_id: string;
  event_type: string;
  occurred_at: string;
  data: unknown;
}

interface PostgresOutboxRow extends PostgresEventRow {
  id: string | number;
}

/** Converts driver-specific bigint values while protecting JavaScript precision. */
function parseSequence(value: unknown): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("PostgreSQL returned an invalid RunEvent sequence");
  }
  return sequence;
}

/** Revalidates database rows before returning them to trusted callers. */
function parseEventRow(row: PostgresEventRow): RunEventV1 {
  return parseRunEvent({
    version: Number(row.version),
    sequence: parseSequence(row.sequence),
    runId: row.run_id,
    type: row.event_type,
    occurredAt: row.occurred_at,
    data: row.data
  });
}
