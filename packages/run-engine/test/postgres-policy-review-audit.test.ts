import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createPostgresPolicyReviewAudit } from "../src/postgres-policy-review-audit.js";

describe("PostgreSQL PolicyReviewAudit", () => {
  it("persists one immutable independent review and accepts only exact retries", async () => {
    const database = new PGlite();
    const audit = await createPostgresPolicyReviewAudit(database, {
      now: () => "2026-08-28T05:00:00.000Z"
    });
    const entry = {
      request: {
        approvalMode: "auto_review" as const,
        fileAccessScope: "workspace_only" as const,
        capability: {
          type: "command_exec" as const,
          argv: ["git", "status"],
          cwd: "."
        },
        context: {
          runId: "run-1",
          projectId: "project-1",
          toolCallId: "call-1",
          userTask: "Inspect repository status"
        }
      },
      result: {
        decision: "allow" as const,
        riskLevel: "low" as const,
        reason: "Exact read-only status command",
        ruleVersion: "policy-v2",
        reviewerVersion: "risk-reviewer-v1"
      }
    };

    await audit.record(entry);
    await audit.record(entry);

    await expect(audit.get("run-1", "call-1")).resolves.toEqual({
      ...entry,
      recordedAt: "2026-08-28T05:00:00.000Z"
    });
    await expect(
      audit.record({
        ...entry,
        result: { ...entry.result, decision: "ask" as const }
      })
    ).rejects.toThrow("changed after persistence");
    await database.close();
  });
});
