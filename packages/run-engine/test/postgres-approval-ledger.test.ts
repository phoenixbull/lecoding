import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createPostgresApprovalLedger } from "../src/postgres-approval-ledger.js";

describe("PostgreSQL ApprovalLedger", () => {
  it("persists a normalized request and one immutable attributed decision", async () => {
    const database = new PGlite();
    const ledger = await createPostgresApprovalLedger(database, {
      now: () => "2026-08-28T03:00:00.000Z"
    });
    const request = {
      id: "approval-call-1",
      runId: "run-1",
      toolCallId: "call-1",
      capabilityType: "command_exec" as const,
      capabilityHash: "a".repeat(64),
      reason: "Capability requires approval",
      constraints: { argv: ["pnpm", "test"], cwd: ".", shellMode: "direct" }
    };

    await ledger.request(request);
    await ledger.decide({
      approvalId: request.id,
      runId: request.runId,
      decision: "allow",
      scope: "run",
      decidedBy: "github_42"
    });

    await expect(ledger.get(request.id)).resolves.toEqual({
      ...request,
      status: "decided",
      decision: "allow",
      scope: "run",
      decidedBy: "github_42",
      decidedAt: "2026-08-28T03:00:00.000Z"
    });
    await expect(
      ledger.decide({
        approvalId: request.id,
        runId: request.runId,
        decision: "deny",
        scope: "once",
        decidedBy: "github_99"
      })
    ).rejects.toThrow("not pending");
    await database.close();
  });

  it("rejects approval identity reuse with different normalized constraints", async () => {
    const database = new PGlite();
    const ledger = await createPostgresApprovalLedger(database);
    const request = {
      id: "approval-call-1",
      runId: "run-1",
      toolCallId: "call-1",
      capabilityType: "network_egress" as const,
      capabilityHash: "b".repeat(64),
      reason: "Network access requires approval",
      constraints: { scheme: "https", domain: "registry.npmjs.org", port: 443 }
    };

    await ledger.request(request);
    await expect(
      ledger.request({
        ...request,
        constraints: { ...request.constraints, domain: "attacker.example" }
      })
    ).rejects.toThrow("reused");
    await database.close();
  });

  it("audits the exact narrower capability used by edit-and-allow-once", async () => {
    const database = new PGlite();
    const ledger = await createPostgresApprovalLedger(database, {
      now: () => "2026-08-28T06:00:00.000Z"
    });
    await ledger.request({
      id: "approval-edit-1",
      runId: "run-edit-1",
      toolCallId: "call-edit-1",
      capabilityType: "command_exec",
      capabilityHash: "a".repeat(64),
      reason: "Capability requires approval",
      constraints: { argv: ["pnpm", "test", "--force"], cwd: "." }
    });

    await ledger.decide({
      approvalId: "approval-edit-1",
      runId: "run-edit-1",
      decision: "allow",
      scope: "once",
      decidedBy: "github_42",
      editedCapability: {
        capabilityType: "command_exec",
        capabilityHash: "b".repeat(64),
        constraints: { argv: ["pnpm", "test"], cwd: ".", shellMode: "direct" }
      }
    });

    await expect(ledger.get("approval-edit-1")).resolves.toMatchObject({
      status: "decided",
      editedCapability: {
        capabilityType: "command_exec",
        capabilityHash: "b".repeat(64),
        constraints: { argv: ["pnpm", "test"] }
      }
    });
    await database.close();
  });

  it("migrates the legacy once/run scope constraint before project decisions", async () => {
    const database = new PGlite();
    await database.query(`
      CREATE TABLE run_engine_approvals (
        id text PRIMARY KEY,
        run_id text NOT NULL,
        tool_call_id text NOT NULL,
        status text NOT NULL CHECK (status IN ('pending', 'decided')),
        capability_type text NOT NULL,
        capability_hash text NOT NULL,
        reason text NOT NULL,
        constraints jsonb NOT NULL,
        decision text CHECK (decision IN ('allow', 'deny')),
        scope text CHECK (scope IN ('once', 'run')),
        decided_by text,
        decided_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const ledger = await createPostgresApprovalLedger(database);
    await ledger.request({
      id: "approval-project-migration",
      runId: "run-project-migration",
      toolCallId: "call-project-migration",
      capabilityType: "command_exec",
      capabilityHash: "c".repeat(64),
      reason: "Project administrator decision",
      constraints: { argv: ["pnpm", "test"] }
    });

    await expect(
      ledger.decide({
        approvalId: "approval-project-migration",
        runId: "run-project-migration",
        decision: "allow",
        scope: "project",
        decidedBy: "github_42"
      })
    ).resolves.toBeUndefined();
    await database.close();
  });
});
