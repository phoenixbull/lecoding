import { randomUUID } from "node:crypto";
import type { JsonValue } from "@lecoding/contracts";
import type {
  Capability,
  ProjectPolicyRuleResolver
} from "@lecoding/policy";
import type { PostgresExecutor } from "./postgres-run-lease.js";

/** Administrator-authored exact project rule mutation. */
export interface SetProjectPolicyRuleInput {
  projectId: string;
  capabilityType: Capability["type"];
  capabilityHash: string;
  constraints: Record<string, JsonValue>;
  decision: "allow" | "deny";
  createdBy: string;
  /** Idempotency identity of the approval/settings action creating this version. */
  sourceApprovalId: string;
}

/** Immutable rule version retained after replacement or revocation. */
export interface ProjectPolicyRuleRecord extends SetProjectPolicyRuleInput {
  id: string;
  createdAt: string;
  revokedAt?: string;
  revokedBy?: string;
}

/** Persistent exact-rule authority shared by policy evaluation and admin APIs. */
export interface ProjectPolicyRules extends ProjectPolicyRuleResolver {
  set(input: SetProjectPolicyRuleInput): Promise<string>;
  list(projectId: string): Promise<ProjectPolicyRuleRecord[]>;
  revoke(projectId: string, ruleId: string, revokedBy: string): Promise<void>;
}

/** PostgreSQL schema retaining every project policy rule version. */
export const PROJECT_POLICY_RULES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project_policy_rules (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  capability_type text NOT NULL,
  capability_hash text NOT NULL,
  constraints jsonb NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow', 'deny')),
  created_by text NOT NULL,
  source_approval_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  revoked_by text,
  revoked_at timestamptz
);
`;

const PROJECT_POLICY_RULES_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS project_policy_rules_active_exact
  ON project_policy_rules (project_id, capability_type, capability_hash)
  WHERE revoked_at IS NULL;
`;

const PROJECT_POLICY_RULES_SET_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION lecoding_set_project_policy_rule(
  p_id text,
  p_project_id text,
  p_capability_type text,
  p_capability_hash text,
  p_constraints jsonb,
  p_decision text,
  p_actor text,
  p_source_approval_id text,
  p_now timestamptz
) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_source_approval_id, 0)
  );
  IF EXISTS (SELECT 1 FROM project_policy_rules WHERE source_approval_id = p_source_approval_id) THEN
    IF EXISTS (
      SELECT 1 FROM project_policy_rules
       WHERE source_approval_id = p_source_approval_id
         AND project_id = p_project_id
         AND capability_type = p_capability_type
         AND capability_hash = p_capability_hash
         AND constraints = p_constraints
         AND decision = p_decision
         AND created_by = p_actor
    ) THEN
      RETURN (SELECT id FROM project_policy_rules WHERE source_approval_id = p_source_approval_id);
    END IF;
    RAISE EXCEPTION 'project policy source identity was reused';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_project_id || ':' || p_capability_type || ':' || p_capability_hash, 0)
  );
  UPDATE project_policy_rules
     SET revoked_at = p_now, revoked_by = p_actor
   WHERE project_id = p_project_id
     AND capability_type = p_capability_type
     AND capability_hash = p_capability_hash
     AND revoked_at IS NULL;
  INSERT INTO project_policy_rules
    (id, project_id, capability_type, capability_hash, constraints,
     decision, created_by, source_approval_id, created_at)
  VALUES
    (p_id, p_project_id, p_capability_type, p_capability_hash, p_constraints,
     p_decision, p_actor, p_source_approval_id, p_now);
  RETURN p_id;
END;
$$;
`;

/** Creates the versioned project policy rule store. */
export async function createPostgresProjectPolicyRules(
  database: PostgresExecutor,
  options: { now?: () => string; createId?: () => string } = {}
): Promise<ProjectPolicyRules> {
  await database.query(PROJECT_POLICY_RULES_SCHEMA_SQL);
  await database.query(PROJECT_POLICY_RULES_INDEX_SQL);
  await database.query(PROJECT_POLICY_RULES_SET_FUNCTION_SQL);
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? randomUUID;
  return {
    async set(input) {
      validateRuleInput(input);
      const id = createId();
      validateIdentifier(id, "Rule ID");
      validateIdentifier(input.sourceApprovalId, "Rule source approval ID");
      const createdAt = requireTimestamp(now());
      const result = await database.query<{ id: string }>(
        `SELECT lecoding_set_project_policy_rule(
           $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::timestamptz
         ) AS id`,
        [
          id,
          input.projectId,
          input.capabilityType,
          input.capabilityHash,
          JSON.stringify(input.constraints),
          input.decision,
          input.createdBy,
          input.sourceApprovalId,
          createdAt
        ]
      );
      if (result.rows.length !== 1) {
        throw new Error("Project policy rule was not persisted");
      }
      return id;
    },

    async resolve(input) {
      validateIdentifier(input.projectId, "Project ID");
      validateCapabilityHash(input.capabilityHash);
      const result = await database.query<{ decision: "allow" | "deny" }>(
        `SELECT decision
           FROM project_policy_rules
          WHERE project_id = $1
            AND capability_type = $2
            AND capability_hash = $3
            AND revoked_at IS NULL`,
        [input.projectId, input.capabilityType, input.capabilityHash]
      );
      return result.rows[0]?.decision;
    },

    async list(projectId) {
      validateIdentifier(projectId, "Project ID");
      const result = await database.query<ProjectPolicyRuleRow>(
        `SELECT id, project_id, capability_type, capability_hash, constraints,
                decision, created_by, source_approval_id, created_at,
                revoked_by, revoked_at
           FROM project_policy_rules
          WHERE project_id = $1
          ORDER BY created_at DESC, id DESC`,
        [projectId]
      );
      return result.rows.map(toRecord);
    },

    async revoke(projectId, ruleId, revokedBy) {
      validateIdentifier(projectId, "Project ID");
      validateIdentifier(ruleId, "Rule ID");
      validateIdentifier(revokedBy, "Revocation actor");
      const result = await database.query<{ id: string }>(
        `UPDATE project_policy_rules
            SET revoked_at = $4::timestamptz, revoked_by = $3
          WHERE project_id = $1 AND id = $2 AND revoked_at IS NULL
        RETURNING id`,
        [projectId, ruleId, revokedBy, requireTimestamp(now())]
      );
      if (result.rows.length !== 1) {
        throw new Error(`Project policy rule is not active: ${ruleId}`);
      }
    }
  };
}

interface ProjectPolicyRuleRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  capability_type: Capability["type"];
  capability_hash: string;
  constraints: Record<string, JsonValue>;
  decision: "allow" | "deny";
  created_by: string;
  source_approval_id: string;
  created_at: string | Date;
  revoked_by: string | null;
  revoked_at: string | Date | null;
}

function toRecord(row: ProjectPolicyRuleRow): ProjectPolicyRuleRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    capabilityType: row.capability_type,
    capabilityHash: row.capability_hash,
    constraints: row.constraints,
    decision: row.decision,
    createdBy: row.created_by,
    sourceApprovalId: row.source_approval_id,
    createdAt: timestampToIso(row.created_at),
    ...(row.revoked_at ? { revokedAt: timestampToIso(row.revoked_at) } : {}),
    ...(row.revoked_by ? { revokedBy: row.revoked_by } : {})
  };
}

function validateRuleInput(input: SetProjectPolicyRuleInput): void {
  validateIdentifier(input.projectId, "Project ID");
  validateIdentifier(input.createdBy, "Rule actor");
  validateCapabilityHash(input.capabilityHash);
}

function validateCapabilityHash(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("Capability hash is invalid");
  }
}

function validateIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function requireTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("Project policy rule clock must return an ISO timestamp");
  }
  return value;
}

function timestampToIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
