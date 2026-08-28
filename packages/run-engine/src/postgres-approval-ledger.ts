import type { ApprovalScope, JsonValue, RunId } from "@lecoding/contracts";
import type { PostgresExecutor } from "./postgres-run-lease.js";

/** Capability kinds currently executable through the Phase 2 approval boundary. */
export type ApprovalCapabilityType = "command_exec" | "network_egress";

/** Immutable normalized request persisted before the Run waits for a decision. */
export interface ApprovalRequestInput {
  id: string;
  runId: RunId;
  toolCallId: string;
  capabilityType: ApprovalCapabilityType;
  capabilityHash: string;
  reason: string;
  constraints: Record<string, JsonValue>;
}

/** Attributed user decision accepted exactly once for a pending request. */
export interface ApprovalDecisionInput {
  approvalId: string;
  runId: RunId;
  decision: "allow" | "deny";
  scope: ApprovalScope;
  decidedBy: string;
  /** Exact user-narrowed capability; present only for edit-and-allow-once. */
  editedCapability?: EditedApprovalAudit;
}

/** Immutable normalized replacement retained beside the original request. */
export interface EditedApprovalAudit {
  capabilityType: ApprovalCapabilityType;
  capabilityHash: string;
  constraints: Record<string, JsonValue>;
}

/** Read-only approval audit projection; decided fields are absent while pending. */
export type ApprovalAuditRecord = ApprovalRequestInput &
  (
    | { status: "pending" }
    | {
        status: "decided";
        decision: "allow" | "deny";
        scope: ApprovalScope;
        decidedBy: string;
        decidedAt: string;
        editedCapability?: EditedApprovalAudit;
      }
  );

/** Append/decide ledger kept outside model-controlled Run state. */
export interface ApprovalLedger {
  request(input: ApprovalRequestInput): Promise<void>;
  decide(input: ApprovalDecisionInput): Promise<void>;
  get(approvalId: string): Promise<ApprovalAuditRecord | undefined>;
}

/** Creates a process-local approval ledger for tests and local development. */
export function createInMemoryApprovalLedger(
  options: { now?: () => string } = {}
): ApprovalLedger {
  const records = new Map<string, ApprovalAuditRecord>();
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async request(input) {
      validateRequest(input);
      const existing = records.get(input.id);
      if (!existing) {
        records.set(input.id, structuredClone({ ...input, status: "pending" }));
        return;
      }
      const immutableExisting = {
        id: existing.id,
        runId: existing.runId,
        toolCallId: existing.toolCallId,
        capabilityType: existing.capabilityType,
        capabilityHash: existing.capabilityHash,
        reason: existing.reason,
        constraints: existing.constraints
      };
      if (canonicalJson(immutableExisting) !== canonicalJson(input)) {
        throw new Error(`Approval identity was reused: ${input.id}`);
      }
    },
    async decide(input) {
      validateIdentifier(input.decidedBy, "Decision actor");
      validateDecision(input);
      const existing = records.get(input.approvalId);
      if (!existing || existing.runId !== input.runId) {
        throw new Error(`Approval is not pending: ${input.approvalId}`);
      }
      if (existing.status === "decided") {
        if (matchesDecision(existing, input)) {
          return;
        }
        throw new Error(`Approval is not pending: ${input.approvalId}`);
      }
      records.set(input.approvalId, {
        ...existing,
        status: "decided",
        decision: input.decision,
        scope: input.scope,
        decidedBy: input.decidedBy,
        decidedAt: requireTimestamp(now()),
        ...(input.editedCapability
          ? { editedCapability: structuredClone(input.editedCapability) }
          : {})
      });
    },
    async get(approvalId) {
      const record = records.get(approvalId);
      return record ? structuredClone(record) : undefined;
    }
  };
}

/** PostgreSQL schema for immutable approval requests and single-write decisions. */
export const APPROVAL_LEDGER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_engine_approvals (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  tool_call_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'decided')),
  capability_type text NOT NULL CHECK (capability_type IN ('command_exec', 'network_egress')),
  capability_hash text NOT NULL,
  reason text NOT NULL,
  constraints jsonb NOT NULL,
  decision text CHECK (decision IN ('allow', 'deny')),
  scope text CHECK (scope IN ('once', 'run', 'project')),
  decided_by text,
  decided_at timestamptz,
  edited_capability_type text,
  edited_capability_hash text,
  edited_constraints jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

const APPROVAL_LEDGER_EDIT_MIGRATION_SQL = `
ALTER TABLE run_engine_approvals
  ADD COLUMN IF NOT EXISTS edited_capability_type text,
  ADD COLUMN IF NOT EXISTS edited_capability_hash text,
  ADD COLUMN IF NOT EXISTS edited_constraints jsonb;
`;

const APPROVAL_LEDGER_SCOPE_MIGRATION_SQL = `
DO $$
DECLARE
  scope_definition text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('lecoding:run_engine_approvals:scope:v2', 0)
  );
  SELECT pg_get_constraintdef(oid)
    INTO scope_definition
    FROM pg_constraint
   WHERE conrelid = 'run_engine_approvals'::regclass
     AND conname = 'run_engine_approvals_scope_check';
  IF scope_definition IS NULL OR position('project' IN scope_definition) = 0 THEN
    ALTER TABLE run_engine_approvals
      DROP CONSTRAINT IF EXISTS run_engine_approvals_scope_check;
    ALTER TABLE run_engine_approvals
      ADD CONSTRAINT run_engine_approvals_scope_check
      CHECK (scope IN ('once', 'run', 'project'));
  END IF;
END;
$$;
`;

/** Creates the approval audit ledger shared by every production Worker. */
export async function createPostgresApprovalLedger(
  database: PostgresExecutor,
  options: { now?: () => string } = {}
): Promise<ApprovalLedger> {
  await database.query(APPROVAL_LEDGER_SCHEMA_SQL);
  await database.query(APPROVAL_LEDGER_EDIT_MIGRATION_SQL);
  await database.query(APPROVAL_LEDGER_SCOPE_MIGRATION_SQL);
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async request(input) {
      validateRequest(input);
      const constraints = canonicalJson(input.constraints);
      const inserted = await database.query<{ id: string }>(
        `INSERT INTO run_engine_approvals
           (id, run_id, tool_call_id, status, capability_type,
            capability_hash, reason, constraints)
         VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7::jsonb)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          input.id,
          input.runId,
          input.toolCallId,
          input.capabilityType,
          input.capabilityHash,
          input.reason,
          constraints
        ]
      );
      if (inserted.rows.length === 1) {
        return;
      }
      const existing = await readRecord(database, input.id);
      const immutableExisting = existing && {
        id: existing.id,
        runId: existing.runId,
        toolCallId: existing.toolCallId,
        capabilityType: existing.capabilityType,
        capabilityHash: existing.capabilityHash,
        reason: existing.reason,
        constraints: existing.constraints
      };
      if (canonicalJson(immutableExisting) !== canonicalJson(input)) {
        // A stable approval ID cannot be rebound to a broader capability.
        throw new Error(`Approval identity was reused: ${input.id}`);
      }
    },

    async decide(input) {
      validateIdentifier(input.approvalId, "Approval ID");
      validateIdentifier(input.runId, "Run ID");
      validateIdentifier(input.decidedBy, "Decision actor");
      validateDecision(input);
      const decidedAt = requireTimestamp(now());
      const result = await database.query<{ id: string }>(
        `UPDATE run_engine_approvals
            SET status = 'decided', decision = $3, scope = $4,
                decided_by = $5, decided_at = $6::timestamptz,
                edited_capability_type = $7,
                edited_capability_hash = $8,
                edited_constraints = $9::jsonb
          WHERE id = $1 AND run_id = $2 AND status = 'pending'
        RETURNING id`,
        [
          input.approvalId,
          input.runId,
          input.decision,
          input.scope,
          input.decidedBy,
          decidedAt,
          input.editedCapability?.capabilityType ?? null,
          input.editedCapability?.capabilityHash ?? null,
          input.editedCapability
            ? canonicalJson(input.editedCapability.constraints)
            : null
        ]
      );
      if (result.rows.length !== 1) {
        const existing = await readRecord(database, input.approvalId);
        if (existing?.status === "decided" && matchesDecision(existing, input)) {
          // Exact retries recover safely after a decision committed before Run state.
          return;
        }
        throw new Error(`Approval is not pending: ${input.approvalId}`);
      }
    },

    get(approvalId) {
      validateIdentifier(approvalId, "Approval ID");
      return readRecord(database, approvalId);
    }
  };
}

interface ApprovalRow extends Record<string, unknown> {
  id: string;
  run_id: string;
  tool_call_id: string;
  status: "pending" | "decided";
  capability_type: ApprovalCapabilityType;
  capability_hash: string;
  reason: string;
  constraints: Record<string, JsonValue>;
  decision: "allow" | "deny" | null;
  scope: ApprovalScope | null;
  decided_by: string | null;
  decided_at: string | Date | null;
  edited_capability_type: ApprovalCapabilityType | null;
  edited_capability_hash: string | null;
  edited_constraints: Record<string, JsonValue> | null;
}

async function readRecord(
  database: PostgresExecutor,
  approvalId: string
): Promise<ApprovalAuditRecord | undefined> {
  const result = await database.query<ApprovalRow>(
    `SELECT id, run_id, tool_call_id, status, capability_type,
            capability_hash, reason, constraints, decision, scope,
            decided_by, decided_at, edited_capability_type,
            edited_capability_hash, edited_constraints
       FROM run_engine_approvals
      WHERE id = $1`,
    [approvalId]
  );
  const row = result.rows[0];
  if (!row) {
    return undefined;
  }
  const request = {
    id: row.id,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    capabilityType: row.capability_type,
    capabilityHash: row.capability_hash,
    reason: row.reason,
    constraints: row.constraints
  };
  if (row.status === "pending") {
    return { ...request, status: "pending" };
  }
  if (!row.decision || !row.scope || !row.decided_by || !row.decided_at) {
    throw new Error(`Approval audit row is incomplete: ${row.id}`);
  }
  return {
    ...request,
    status: "decided",
    decision: row.decision,
    scope: row.scope,
    decidedBy: row.decided_by,
    decidedAt:
      row.decided_at instanceof Date
        ? row.decided_at.toISOString()
        : new Date(row.decided_at).toISOString(),
    ...(row.edited_capability_type &&
    row.edited_capability_hash &&
    row.edited_constraints
      ? {
          editedCapability: {
            capabilityType: row.edited_capability_type,
            capabilityHash: row.edited_capability_hash,
            constraints: row.edited_constraints
          }
        }
      : {})
  };
}

function validateRequest(input: ApprovalRequestInput): void {
  validateIdentifier(input.id, "Approval ID");
  validateIdentifier(input.runId, "Run ID");
  validateIdentifier(input.toolCallId, "Tool call ID");
  if (!/^[a-f0-9]{64}$/u.test(input.capabilityHash)) {
    throw new Error("Capability hash is invalid");
  }
  if (input.reason.trim() === "" || input.reason.length > 2_000) {
    throw new Error("Approval reason is invalid");
  }
}

function validateIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function validateDecision(input: ApprovalDecisionInput): void {
  if (!input.editedCapability) {
    return;
  }
  if (input.decision !== "allow" || input.scope !== "once") {
    throw new Error("Edited approval must allow exactly once");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.editedCapability.capabilityHash)) {
    throw new Error("Edited capability hash is invalid");
  }
}

function requireTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("Approval clock must return an ISO timestamp");
  }
  return value;
}

function matchesDecision(
  record: Extract<ApprovalAuditRecord, { status: "decided" }>,
  input: ApprovalDecisionInput
): boolean {
  return (
    record.runId === input.runId &&
    record.decision === input.decision &&
    record.scope === input.scope &&
    record.decidedBy === input.decidedBy &&
    canonicalJson(record.editedCapability) === canonicalJson(input.editedCapability)
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
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
