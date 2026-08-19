import { describe, expect, it } from "vitest";
import { createPolicyEngine } from "../src/index.js";

describe("PolicyEngine", () => {
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
