import type { RunId } from "@lecoding/contracts";
import {
  RUN_EVENT_SCHEMA_SQL,
  type RunEventJournal
} from "@lecoding/run-events";
import type { PostgresExecutor } from "./postgres-run-lease.js";

/** One durable user instruction ordered independently from the Run driver's lease. */
export interface RunSteerMessage {
  sequence: number;
  message: string;
}

/** Durable append/read seam used to deliver steering at safe model-turn boundaries. */
export interface RunSteerMailbox {
  enqueue(input: EnqueueRunSteer): Promise<EnqueueRunSteerResult>;
  getByCommandId(
    runId: RunId,
    commandId: string
  ): Promise<RunSteerMessage | undefined>;
  readAfter(runId: RunId, sequence: number, limit: number): Promise<RunSteerMessage[]>;
}

/** Client-stable identity makes retried steering commands idempotent. */
export interface EnqueueRunSteer {
  runId: RunId;
  commandId: string;
  message: string;
}

/** Existing commands return their original sequence without a second event. */
export interface EnqueueRunSteerResult {
  sequence: number;
  inserted: boolean;
}

/** Creates the process-local mailbox used by deterministic tests and local adapters. */
export function createInMemoryRunSteerMailbox(options: {
  events: Pick<RunEventJournal, "publish">;
}): RunSteerMailbox {
  let nextSequence = 1;
  const messages = new Map<RunId, Array<RunSteerMessage & { commandId: string }>>();
  return {
    async enqueue(input) {
      validateEnqueue(input);
      const existing = (messages.get(input.runId) ?? []).find(
        (entry) => entry.commandId === input.commandId
      );
      if (existing) {
        if (existing.message !== input.message) {
          throw new Error("Steering commandId was reused with a different message");
        }
        return { sequence: existing.sequence, inserted: false };
      }
      const sequence = nextSequence;
      nextSequence += 1;
      const runMessages = messages.get(input.runId) ?? [];
      runMessages.push({
        sequence,
        commandId: input.commandId,
        message: input.message
      });
      messages.set(input.runId, runMessages);
      try {
        await options.events.publish({
          runId: input.runId,
          type: "user_message_submitted",
          data: {
            messageId: `steer:${sequence}`,
            commandId: input.commandId,
            mode: "steer",
            message: input.message
          }
        });
      } catch (error) {
        // The in-memory adapter rolls back the row when its paired event fails.
        runMessages.pop();
        throw error;
      }
      return { sequence, inserted: true };
    },
    async getByCommandId(runId, commandId) {
      const entry = (messages.get(runId) ?? []).find(
        (message) => message.commandId === commandId
      );
      return entry ? { sequence: entry.sequence, message: entry.message } : undefined;
    },
    async readAfter(runId, sequence, limit) {
      return (messages.get(runId) ?? [])
        .filter((entry) => entry.sequence > sequence)
        .slice(0, limit)
        .map((entry) => ({ ...entry }));
    }
  };
}

/** PostgreSQL schema for cross-Worker steering delivery. */
export const RUN_STEER_MAILBOX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_engine_steering_messages (
  sequence bigserial PRIMARY KEY,
  run_id text NOT NULL,
  command_id text,
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

/** Creates a PostgreSQL mailbox whose ordered messages survive Worker replacement. */
export async function createPostgresRunSteerMailbox(
  options: { database: PostgresExecutor; now(): string }
): Promise<RunSteerMailbox> {
  const { database } = options;
  await database.query(RUN_STEER_MAILBOX_SCHEMA_SQL);
  // Existing development databases created before command IDs receive the column safely.
  await database.query(`
    ALTER TABLE run_engine_steering_messages
      ADD COLUMN IF NOT EXISTS command_id text;
  `);
  // Keep DDL statements separate for PostgreSQL-compatible prepared-query adapters.
  await database.query(`
    CREATE INDEX IF NOT EXISTS run_engine_steering_messages_run_sequence_idx
      ON run_engine_steering_messages (run_id, sequence);
  `);
  await database.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS run_engine_steering_messages_command_idx
      ON run_engine_steering_messages (run_id, command_id)
      WHERE command_id IS NOT NULL;
  `);
  for (const statement of RUN_EVENT_SCHEMA_SQL.split(";")) {
    if (statement.trim() !== "") {
      await database.query(`${statement};`);
    }
  }
  return {
    async enqueue(input) {
      validateEnqueue(input);
      const result = await database.query<{
        sequence: string | number;
        message: string;
        inserted: boolean;
      }>(
        `
        WITH inserted_message AS (
          INSERT INTO run_engine_steering_messages (run_id, command_id, message)
          VALUES ($1::text, $2::text, $3::text)
          ON CONFLICT (run_id, command_id) WHERE command_id IS NOT NULL
            DO NOTHING
          RETURNING sequence, message
        ), selected_message AS (
          SELECT sequence, message, true AS inserted FROM inserted_message
          UNION ALL
          SELECT sequence, message, false AS inserted
          FROM run_engine_steering_messages
          WHERE run_id = $1::text AND command_id = $2::text
            AND NOT EXISTS (SELECT 1 FROM inserted_message)
        ), allocated AS (
          INSERT INTO run_event_counters (run_id, next_sequence)
          SELECT $1::text, 2 FROM inserted_message
          ON CONFLICT (run_id) DO UPDATE
            SET next_sequence = run_event_counters.next_sequence + 1
          RETURNING next_sequence - 1 AS event_sequence
        ), inserted_event AS (
          INSERT INTO run_events (
            run_id, sequence, version, event_type, occurred_at, data
          )
          SELECT
            $1::text,
            allocated.event_sequence,
            1,
            'user_message_submitted',
            $4::timestamptz,
            jsonb_build_object(
              'messageId', 'steer:' || inserted_message.sequence::text,
              'commandId', $2::text,
              'mode', 'steer',
              'message', $3::text
            )
          FROM allocated
          INNER JOIN inserted_message ON true
          RETURNING sequence
        ), queued AS (
          INSERT INTO run_event_outbox (run_id, event_sequence)
          SELECT $1::text, sequence FROM inserted_event
          RETURNING event_sequence
        )
        SELECT selected_message.sequence,
               selected_message.message,
               selected_message.inserted
        FROM selected_message
        LEFT JOIN queued ON selected_message.inserted
        WHERE NOT selected_message.inserted OR queued.event_sequence IS NOT NULL;
        `,
        [input.runId, input.commandId, input.message, options.now()]
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("Steering command could not be persisted");
      }
      if (row.message !== input.message) {
        throw new Error("Steering commandId was reused with a different message");
      }
      return {
        sequence: parseSequence(row.sequence),
        inserted: row.inserted
      };
    },
    async getByCommandId(runId, commandId) {
      const result = await database.query<{
        sequence: string | number;
        message: string;
      }>(
        `
        SELECT sequence, message
        FROM run_engine_steering_messages
        WHERE run_id = $1::text AND command_id = $2::text;
        `,
        [runId, commandId]
      );
      const row = result.rows[0];
      return row
        ? { sequence: parseSequence(row.sequence), message: row.message }
        : undefined;
    },
    async readAfter(runId, sequence, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
        throw new Error("Steering mailbox limit must be an integer from 1 to 20");
      }
      const result = await database.query<{
        sequence: string | number;
        message: string;
      }>(
        `
        SELECT sequence, message
        FROM run_engine_steering_messages
        WHERE run_id = $1::text AND sequence > $2::bigint
        ORDER BY sequence ASC
        LIMIT $3::integer;
        `,
        [runId, sequence, limit]
      );
      return result.rows.map((row) => ({
        sequence: parseSequence(row.sequence),
        message: row.message
      }));
    }
  };
}

function validateEnqueue(input: EnqueueRunSteer): void {
  if (input.runId.trim() === "") {
    throw new Error("Steering runId must not be empty");
  }
  if (input.commandId.trim() === "" || input.commandId.length > 128) {
    throw new Error("Steering commandId must contain between 1 and 128 characters");
  }
  if (input.message.trim() === "" || input.message.trim().length > 4_000) {
    throw new Error("Steering message must contain between 1 and 4000 characters");
  }
}

function parseSequence(value: string | number | undefined): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("PostgreSQL returned an invalid steering sequence");
  }
  return sequence;
}
