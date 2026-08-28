import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createPostgresProjectPolicyRules } from "../src/postgres-project-policy-rules.js";

describe("PostgreSQL ProjectPolicyRules", () => {
  it("versions exact admin rules and supports explicit revocation", async () => {
    const database = new PGlite();
    let sequence = 0;
    const rules = await createPostgresProjectPolicyRules(database, {
      now: () => `2026-08-28T05:00:0${sequence}.000Z`,
      createId: () => `rule-${++sequence}`
    });
    const capability = {
      projectId: "project-1",
      capabilityType: "network_egress" as const,
      capabilityHash: "a".repeat(64),
      constraints: {
        scheme: "https",
        domain: "registry.npmjs.org",
        port: 443
      }
    };

    const allowId = await rules.set({
      ...capability,
      decision: "allow",
      createdBy: "github_42",
      sourceApprovalId: "approval-allow"
    });
    expect(
      await rules.resolve({
        projectId: capability.projectId,
        capabilityType: capability.capabilityType,
        capabilityHash: capability.capabilityHash
      })
    ).toBe("allow");

    const denyId = await rules.set({
      ...capability,
      decision: "deny",
      createdBy: "github_42",
      sourceApprovalId: "approval-deny"
    });
    const history = await rules.list("project-1");
    expect(history).toMatchObject([
      { id: denyId, decision: "deny" },
      { id: allowId, decision: "allow", revokedAt: expect.any(String) }
    ]);
    expect(history[0]).not.toHaveProperty("revokedAt");
    expect(
      await rules.resolve({
        projectId: capability.projectId,
        capabilityType: capability.capabilityType,
        capabilityHash: capability.capabilityHash
      })
    ).toBe("deny");

    await rules.revoke("project-1", denyId, "github_42");
    await expect(
      rules.resolve({
        projectId: capability.projectId,
        capabilityType: capability.capabilityType,
        capabilityHash: capability.capabilityHash
      })
    ).resolves.toBeUndefined();
    await database.close();
  });
});
