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
});
