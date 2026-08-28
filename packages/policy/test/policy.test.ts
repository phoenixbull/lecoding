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

  it("denies loopback, private, link-local, and metadata network targets in every mode", async () => {
    const policy = createPolicyEngine();
    const targets = [
      "localhost",
      "127.0.0.1",
      "10.20.30.40",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "metadata.google.internal"
    ];

    for (const approvalMode of ["manual", "auto_review", "full_access"] as const) {
      for (const domain of targets) {
        await expect(
          policy.authorize({
            approvalMode,
            fileAccessScope: "workspace_only",
            capability: {
              type: "network_egress",
              scheme: "https",
              domain,
              port: 443
            }
          })
        ).resolves.toEqual({
          decision: "deny",
          reason: "Private and metadata network targets are never allowed"
        });
      }
    }
  });

  it("keeps credentials and host-control commands denied in every approval mode", async () => {
    const policy = createPolicyEngine();
    const credentials = [
      "/workspace/.env",
      "/home/alice/.ssh/id_rsa",
      "/home/alice/.aws/credentials",
      "/home/alice/.config/google-chrome/Default/Login Data",
      "/var/run/docker.sock"
    ];
    const commands = ["sudo", "mount", "docker"];

    for (const approvalMode of ["manual", "auto_review", "full_access"] as const) {
      for (const realpath of credentials) {
        await expect(
          policy.authorize({
            approvalMode,
            fileAccessScope: "host_full",
            capability: { type: "sensitive_file_read", realpath }
          })
        ).resolves.toMatchObject({ decision: "deny" });
      }
      for (const executable of commands) {
        await expect(
          policy.authorize({
            approvalMode,
            fileAccessScope: "host_full",
            capability: {
              type: "command_exec",
              argv: [executable, "--version"],
              cwd: "/workspace"
            }
          })
        ).resolves.toEqual({
          decision: "deny",
          reason: "Host control commands are never allowed"
        });
      }
    }
  });
});
