import type {
  EnvironmentAction,
  EnvironmentResult,
  RunId
} from "@lecoding/contracts";
import type { PostgresExecutor } from "./postgres-run-lease.js";

/** A stable tool invocation identity and the exact action bound to that identity. */
export interface ToolCallClaimInput {
  runId: RunId;
  callId: string;
  action: EnvironmentAction;
}

/** Claim result that prevents an uncertain side effect from being replayed. */
export type ToolCallClaim =
  | { status: "claimed" }
  | { status: "outcome_unknown" }
  | { status: "completed"; result: EnvironmentResult };

/** Completion input persisted immediately after the environment returns. */
export interface ToolCallCompleteInput {
  runId: RunId;
  callId: string;
  result: EnvironmentResult;
}

/** Durable idempotency boundary used before any tool can produce side effects. */
export interface ToolCallLedger {
  claim(input: ToolCallClaimInput): Promise<ToolCallClaim>;
  complete(input: ToolCallCompleteInput): Promise<void>;
}

/** Creates a process-local ledger for tests and single-process development. */
export function createInMemoryToolCallLedger(): ToolCallLedger {
  const calls = new Map<
    string,
    {
      actionJson: string;
      result?: EnvironmentResult;
    }
  >();
  return {
    async claim(input) {
      const key = `${input.runId}\u0000${input.callId}`;
      const actionJson = JSON.stringify(input.action);
      const existing = calls.get(key);
      if (!existing) {
        calls.set(key, { actionJson });
        return { status: "claimed" };
      }
      if (existing.actionJson !== actionJson) {
        throw new Error(`Tool call identity was reused with another action: ${input.callId}`);
      }
      return existing.result
        ? { status: "completed", result: existing.result }
        : { status: "outcome_unknown" };
    },
    async complete(input) {
      const key = `${input.runId}\u0000${input.callId}`;
      const existing = calls.get(key);
      if (!existing || existing.result) {
        throw new Error(`Tool call was not executing: ${input.callId}`);
      }
      calls.set(key, { ...existing, result: structuredClone(input.result) });
    }
  };
}

/** PostgreSQL schema for the durable tool-call idempotency ledger. */
export const TOOL_CALL_LEDGER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_engine_tool_calls (
  run_id text NOT NULL,
  call_id text NOT NULL,
  action jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('executing', 'completed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz,
  PRIMARY KEY (run_id, call_id)
);
`;

/** Creates a PostgreSQL ledger shared by every Worker process. */
export async function createPostgresToolCallLedger(
  database: PostgresExecutor
): Promise<ToolCallLedger> {
  await database.query(TOOL_CALL_LEDGER_SCHEMA_SQL);
  return new PostgresToolCallLedger(database);
}

class PostgresToolCallLedger implements ToolCallLedger {
  constructor(private readonly database: PostgresExecutor) {}

  async claim(input: ToolCallClaimInput): Promise<ToolCallClaim> {
    const actionJson = JSON.stringify(input.action);
    const inserted = await this.database.query<{ call_id: string }>(
      `
      INSERT INTO run_engine_tool_calls (run_id, call_id, action, status)
      VALUES ($1::text, $2::text, $3::jsonb, 'executing')
      ON CONFLICT (run_id, call_id) DO NOTHING
      RETURNING call_id;
      `,
      [input.runId, input.callId, actionJson]
    );
    if (inserted.rows.length === 1) {
      return { status: "claimed" };
    }

    const existing = await this.database.query<{
      action: EnvironmentAction;
      status: "executing" | "completed";
      result: EnvironmentResult | null;
    }>(
      `
      SELECT action, status, result
      FROM run_engine_tool_calls
      WHERE run_id = $1::text AND call_id = $2::text;
      `,
      [input.runId, input.callId]
    );
    const row = existing.rows[0];
    if (!row || JSON.stringify(row.action) !== actionJson) {
      // Rebinding a stable callId to another command would bypass idempotency.
      throw new Error(`Tool call identity was reused with another action: ${input.callId}`);
    }
    if (row.status === "completed" && row.result !== null) {
      return { status: "completed", result: row.result };
    }
    return { status: "outcome_unknown" };
  }

  async complete(input: ToolCallCompleteInput): Promise<void> {
    const result = await this.database.query<{ call_id: string }>(
      `
      UPDATE run_engine_tool_calls
      SET status = 'completed',
          result = $3::jsonb,
          completed_at = CURRENT_TIMESTAMP
      WHERE run_id = $1::text
        AND call_id = $2::text
        AND status = 'executing'
      RETURNING call_id;
      `,
      [input.runId, input.callId, JSON.stringify(input.result)]
    );
    if (result.rows.length !== 1) {
      throw new Error(`Tool call was not executing: ${input.callId}`);
    }
  }
}
