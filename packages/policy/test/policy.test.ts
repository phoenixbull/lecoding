import { describe, expect, it } from "vitest";
import { createPolicyEngine } from "../src/index.js";

describe("PolicyEngine", () => {
  it("allows, asks, or denies file and command capabilities at the public seam", async () => {
    const policy = createPolicyEngine();

    await expect(
      policy.authorize({
        approvalMode: "full_access",
        fileAccessScope: "host_full",
        capability: { type: "protected_file_write", realpath: "/workspace/a.ts" }
      })
    ).resolves.toEqual({ decision: "allow" });
    await expect(
      policy.authorize({
        approvalMode: "manual",
        fileAccessScope: "workspace_only",
        capability: { type: "command_exec", argv: ["pnpm", "test"], cwd: "/workspace" }
      })
    ).resolves.toMatchObject({ decision: "ask" });
    await expect(
      policy.authorize({
        approvalMode: "full_access",
        fileAccessScope: "workspace_only",
        capability: { type: "command_exec", argv: ["curl"], cwd: "/workspace" },
        deniedCommands: ["curl"]
      })
    ).resolves.toMatchObject({ decision: "deny" });
  });

  it("denies Docker socket access even in full-access mode", async () => {
    const policy = createPolicyEngine();

    await expect(
      policy.authorize({
        approvalMode: "full_access",
        fileAccessScope: "host_full",
        capability: {
          type: "sensitive_file_read",
          realpath: "/var/run/docker.sock"
        }
      })
    ).resolves.toEqual({
      decision: "deny",
      reason: "Docker socket access is never allowed"
    });
  });
});
