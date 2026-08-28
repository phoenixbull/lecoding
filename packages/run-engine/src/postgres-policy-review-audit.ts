import type {
  CapabilityRequest,
  PolicyReviewAudit,
  RiskReviewResult
} from "@lecoding/policy";
import type { PostgresExecutor } from "./postgres-run-lease.js";

/** Durable automatic-review record exposed to audit and monitoring readers. */
export interface PolicyReviewAuditRecord {
  request: CapabilityRequest;
  result: RiskReviewResult;
  recordedAt: string;
}

/** Persistent reviewer audit with a read seam for evidence and operations. */
export interface PostgresPolicyReviewAudit extends PolicyReviewAudit {
  get(runId: string, toolCallId: string): Promise<PolicyReviewAuditRecord | undefined>;
}

/** PostgreSQL schema keeping reviewer output outside model-controlled Run state. */
export const POLICY_REVIEW_AUDIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_engine_policy_reviews (
  run_id text NOT NULL,
  tool_call_id text NOT NULL,
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, tool_call_id)
);
`;

/** Creates the fail-closed production sink for independent policy reviews. */
export async function createPostgresPolicyReviewAudit(
  database: PostgresExecutor,
  options: { now?: () => string } = {}
): Promise<PostgresPolicyReviewAudit> {
  await database.query(POLICY_REVIEW_AUDIT_SCHEMA_SQL);
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async record(entry) {
      const context = entry.request.context;
      if (!context) {
        throw new Error("Automatic policy review requires Run context");
      }
      validateIdentifier(context.runId, "Run ID");
      validateIdentifier(context.toolCallId, "Tool call ID");
      const requestJson = canonicalJson(entry.request);
      const resultJson = canonicalJson(entry.result);
      const recordedAt = requireTimestamp(now());
      const inserted = await database.query<{ run_id: string }>(
        `INSERT INTO run_engine_policy_reviews
           (run_id, tool_call_id, request, result, recorded_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::timestamptz)
         ON CONFLICT (run_id, tool_call_id) DO NOTHING
         RETURNING run_id`,
        [
          context.runId,
          context.toolCallId,
          requestJson,
          resultJson,
          recordedAt
        ]
      );
      if (inserted.rows.length === 1) {
        return;
      }
      const existing = await readRecord(
        database,
        context.runId,
        context.toolCallId
      );
      if (
        !existing ||
        canonicalJson(existing.request) !== requestJson ||
        canonicalJson(existing.result) !== resultJson
      ) {
        throw new Error("Automatic policy review changed after persistence");
      }
    },

    get(runId, toolCallId) {
      validateIdentifier(runId, "Run ID");
      validateIdentifier(toolCallId, "Tool call ID");
      return readRecord(database, runId, toolCallId);
    }
  };
}

interface PolicyReviewRow extends Record<string, unknown> {
  request: CapabilityRequest;
  result: RiskReviewResult;
  recorded_at: string | Date;
}

async function readRecord(
  database: PostgresExecutor,
  runId: string,
  toolCallId: string
): Promise<PolicyReviewAuditRecord | undefined> {
  const result = await database.query<PolicyReviewRow>(
    `SELECT request, result, recorded_at
       FROM run_engine_policy_reviews
      WHERE run_id = $1 AND tool_call_id = $2`,
    [runId, toolCallId]
  );
  const row = result.rows[0];
  if (!row) {
    return undefined;
  }
  return {
    request: row.request,
    result: row.result,
    recordedAt:
      row.recorded_at instanceof Date
        ? row.recorded_at.toISOString()
        : new Date(row.recorded_at).toISOString()
  };
}

function validateIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function requireTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("Policy review audit clock must return an ISO timestamp");
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
