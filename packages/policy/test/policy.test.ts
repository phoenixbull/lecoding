import { describe, expect, it, vi } from "vitest";
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

  it("uses an independent auto reviewer and audits its bounded allow decision", async () => {
    const review = vi.fn(async () => ({
      decision: "allow" as const,
      riskLevel: "low" as const,
      reason: "Exact read-only status command",
      ruleVersion: "policy-v2",
      reviewerVersion: "risk-reviewer-v1"
    }));
    const record = vi.fn(async () => undefined);
    const policy = createPolicyEngine({ reviewer: { review }, audit: { record } });
    const request = {
      approvalMode: "auto_review" as const,
      fileAccessScope: "workspace_only" as const,
      capability: {
        type: "command_exec" as const,
        argv: ["git", "status"],
        cwd: "/workspace"
      },
      context: {
        runId: "run-1",
        projectId: "project-1",
        toolCallId: "call-1",
        userTask: "Inspect repository status"
      }
    };

    await expect(policy.authorize(request)).resolves.toEqual({
      decision: "allow",
      review: {
        decision: "allow",
        riskLevel: "low",
        reason: "Exact read-only status command",
        ruleVersion: "policy-v2",
        reviewerVersion: "risk-reviewer-v1"
      }
    });
    expect(review).toHaveBeenCalledWith(request);
    expect(record).toHaveBeenCalledWith({ request, result: expect.any(Object) });
  });

  it("never invokes the auto reviewer for a fixed-deny capability", async () => {
    const review = vi.fn();
    const record = vi.fn();
    const policy = createPolicyEngine({ reviewer: { review }, audit: { record } });

    await expect(
      policy.authorize({
        approvalMode: "auto_review",
        fileAccessScope: "workspace_only",
        capability: {
          type: "network_egress",
          scheme: "https",
          domain: "169.254.169.254",
          port: 443
        }
      })
    ).resolves.toMatchObject({ decision: "deny" });
    expect(review).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("applies exact project rules after fixed deny and before approval mode", async () => {
    const resolve = vi.fn(async (input: { capabilityHash: string }) =>
      input.capabilityHash === "allow-hash" ? ("allow" as const) : ("deny" as const)
    );
    const policy = createPolicyEngine({ projectRules: { resolve } });

    await expect(
      policy.authorize({
        approvalMode: "manual",
        fileAccessScope: "workspace_only",
        capability: {
          type: "network_egress",
          scheme: "https",
          domain: "registry.npmjs.org",
          port: 443
        },
        context: {
          runId: "run-1",
          projectId: "project-1",
          toolCallId: "call-allow",
          userTask: "Install dependencies",
          capabilityHash: "allow-hash"
        }
      })
    ).resolves.toEqual({ decision: "allow", projectRule: "allow" });
    await expect(
      policy.authorize({
        approvalMode: "full_access",
        fileAccessScope: "workspace_only",
        capability: { type: "command_exec", argv: ["pnpm", "test"], cwd: "." },
        context: {
          runId: "run-1",
          projectId: "project-1",
          toolCallId: "call-deny",
          userTask: "Run tests",
          capabilityHash: "deny-hash"
        }
      })
    ).resolves.toEqual({
      decision: "deny",
      reason: "Project policy denies this exact capability",
      projectRule: "deny"
    });
  });
});
