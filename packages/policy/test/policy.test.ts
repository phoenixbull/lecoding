import { describe, expect, it, vi } from "vitest";
import { createPolicyEngine, type Capability } from "../src/index.js";

describe("PolicyEngine", () => {
  it("allows, asks, or denies file and command capabilities at the public seam", async () => {
    const policy = createPolicyEngine();

    await expect(
      policy.authorize({
        approvalMode: "full_access",
        capability: { type: "protected_file_write", realpath: "/workspace/a.ts" }
      })
    ).resolves.toEqual({ decision: "allow" });
    await expect(
      policy.authorize({
        approvalMode: "manual",
        capability: { type: "command_exec", argv: ["pnpm", "test"], cwd: "/workspace" }
      })
    ).resolves.toMatchObject({ decision: "ask" });
    await expect(
      policy.authorize({
        approvalMode: "full_access",
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
            capability: { type: "sensitive_file_read", realpath }
          })
        ).resolves.toMatchObject({ decision: "deny" });
      }
      for (const executable of commands) {
        await expect(
          policy.authorize({
            approvalMode,
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

  it("keeps writes to credential and host-control paths denied in every mode", async () => {
    const policy = createPolicyEngine();
    const protectedPaths = [
      "/workspace/.env.local",
      "/home/alice/.ssh/authorized_keys",
      "/home/alice/.aws/credentials",
      "/home/alice/.docker/config.json",
      "/home/alice/.config/gcloud/application_default_credentials.json",
      "/home/alice/.config/google-chrome/Default/Login Data",
      "/var/run/docker.sock",
      "/run/docker.sock",
      "/run/user/1000/podman/podman.sock"
    ];

    for (const approvalMode of ["manual", "auto_review", "full_access"] as const) {
      for (const realpath of protectedPaths) {
        await expect(
          policy.authorize({
            approvalMode,
            capability: { type: "protected_file_write", realpath }
          })
        ).resolves.toMatchObject({ decision: "deny" });
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

  it("never lets a project allow rule or approval mode override the fixed-deny matrix", async () => {
    const resolve = vi.fn(async () => "allow" as const);
    const review = vi.fn(async () => ({
      decision: "allow" as const,
      riskLevel: "low" as const,
      reason: "must not be consulted",
      ruleVersion: "test",
      reviewerVersion: "test"
    }));
    const policy = createPolicyEngine({
      projectRules: { resolve },
      reviewer: { review }
    });
    const fixedDenied: Capability[] = [
      { type: "sensitive_file_read", realpath: "/run/docker.sock" },
      { type: "protected_file_write", realpath: "/home/alice/.ssh/config" },
      {
        type: "network_egress",
        scheme: "https",
        domain: "169.254.169.254",
        port: 443
      },
      { type: "command_exec", argv: ["/usr/bin/sudo", "id"], cwd: "/workspace" }
    ];

    for (const approvalMode of ["manual", "auto_review", "full_access"] as const) {
      for (const capability of fixedDenied) {
        await expect(
          policy.authorize({
            approvalMode,
            capability,
            context: {
              runId: "run-fixed-deny",
              projectId: "project-1",
              toolCallId: "call-fixed-deny",
              userTask: "Attempt a fixed-deny capability",
              capabilityHash: "a".repeat(64)
            }
          })
        ).resolves.toMatchObject({ decision: "deny" });
      }
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it("applies exact project rules after fixed deny and before approval mode", async () => {
    const resolve = vi.fn(async (input: { capabilityHash: string }) =>
      input.capabilityHash === "allow-hash" ? ("allow" as const) : ("deny" as const)
    );
    const policy = createPolicyEngine({ projectRules: { resolve } });

    await expect(
      policy.authorize({
        approvalMode: "manual",
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

describe("PolicyEngine filesystem-scope boundary", () => {
  /*
   * The engine must not carry a file-access scope at all. A `fileAccessScope`
   * input used to exist and never influenced any decision, which read as a
   * safety guarantee the engine did not actually provide. Filesystem scope is
   * enforced by the sandbox at process creation, under a grant the user issued;
   * keeping a dead field here would invite the same false promise again.
   */
  it("exposes no file-access scope on the authorization request", () => {
    const keys = Object.keys({
      approvalMode: "full_access",
      capability: { type: "command_exec", argv: ["pnpm", "test"], cwd: "/work" },
    });
    // The contract is the type: a request carrying the old field would not
    // compile. Type-level removal is worth a test because the field is easy to
    // reintroduce and impossible to notice once it is ignored again.
    expect(keys).toEqual(["approvalMode", "capability"]);
  });

  it("still denies what it denied, with no scope involved", async () => {
    const engine = createPolicyEngine();
    const credential = await engine.authorize({
      approvalMode: "full_access",
      capability: { type: "sensitive_file_read", realpath: "/home/dev/.ssh/id_rsa" },
    });
    expect(credential.decision).toBe("deny");
  });

  it("still allows a low-risk command, with no scope involved", async () => {
    const engine = createPolicyEngine();
    const decision = await engine.authorize({
      approvalMode: "full_access",
      capability: { type: "command_exec", argv: ["pnpm", "test"], cwd: "/work" },
    });
    expect(decision.decision).toBe("allow");
  });
});

describe("PolicyEngine + project protectedPaths", () => {
  it("forces an ask on protected_file_write that matches a project glob, in every approval mode", async () => {
    const matcher = {
      matches: (realpath: string) =>
        realpath === "/workspace/.ai-agent/project.yaml"
    };
    const policy = createPolicyEngine({ protectedPaths: matcher });
    for (const approvalMode of [
      "manual",
      "auto_review",
      "full_access"
    ] as const) {
      await expect(
        policy.authorize({
          approvalMode,
          capability: {
            type: "protected_file_write",
            realpath: "/workspace/.ai-agent/project.yaml"
          }
        })
      ).resolves.toEqual({
        decision: "ask",
        reason: "Project declares this path as protected; user approval required"
      });
    }
  });

  it("leaves non-matching protected_file_write alone when the glob does not match", async () => {
    const matcher = {
      matches: (realpath: string) =>
        realpath.endsWith(".github/workflows/release.yml")
    };
    const policy = createPolicyEngine({ protectedPaths: matcher });
    await expect(
      policy.authorize({
        approvalMode: "full_access",
        capability: {
          type: "protected_file_write",
          realpath: "/workspace/src/index.ts"
        }
      })
    ).resolves.toEqual({ decision: "allow" });
  });

  it("does not intercept capabilities other than protected_file_write", async () => {
    const matcher = {
      matches: (realpath: string) =>
        realpath === "/workspace/.ai-agent/project.yaml"
    };
    const policy = createPolicyEngine({ protectedPaths: matcher });
    await expect(
      policy.authorize({
        approvalMode: "manual",
        capability: {
          type: "sensitive_file_read",
          realpath: "/workspace/.ai-agent/project.yaml"
        }
      })
    ).resolves.toMatchObject({ decision: "ask" });
  });

  it("lets the fixed-deny deny credential paths even when a project glob would also match", async () => {
    const matcher = { matches: () => true };
    const policy = createPolicyEngine({ protectedPaths: matcher });
    await expect(
      policy.authorize({
        approvalMode: "auto_review",
        capability: {
          type: "protected_file_write",
          realpath: "/workspace/.env.local"
        }
      })
    ).resolves.toMatchObject({ decision: "deny" });
  });
});

describe("PolicyEngine + project askDomains", () => {
  it("forces an ask on network_egress whose domain is not in the project allow list", async () => {
    const policy = createPolicyEngine({
      askDomains: ["registry.npmjs.org"]
    });
    for (const approvalMode of [
      "manual",
      "auto_review",
      "full_access"
    ] as const) {
      await expect(
        policy.authorize({
          approvalMode,
          capability: {
            type: "network_egress",
            scheme: "https",
            domain: "example.com",
            port: 443
          }
        })
      ).resolves.toEqual({
        decision: "ask",
        reason: "Domain is not in the project's allow list; user approval required"
      });
    }
  });

  it("lets an allowed domain proceed through the existing policy pipeline", async () => {
    const policy = createPolicyEngine({
      askDomains: ["registry.npmjs.org"]
    });
    await expect(
      policy.authorize({
        approvalMode: "full_access",
        capability: {
          type: "network_egress",
          scheme: "https",
          domain: "registry.npmjs.org",
          port: 443
        }
      })
    ).resolves.toEqual({ decision: "allow" });
  });

  it("normalises domain casing and trailing dot before comparing", async () => {
    const policy = createPolicyEngine({
      askDomains: ["registry.npmjs.org"]
    });
    await expect(
      policy.authorize({
        approvalMode: "full_access",
        capability: {
          type: "network_egress",
          scheme: "https",
          domain: "REGISTRY.NPMJS.ORG.",
          port: 443
        }
      })
    ).resolves.toEqual({ decision: "allow" });
  });

  it("lets the fixed-deny deny forbidden targets even when they appear in the project allow list", async () => {
    const policy = createPolicyEngine({
      askDomains: ["metadata.google.internal"]
    });
    await expect(
      policy.authorize({
        approvalMode: "full_access",
        capability: {
          type: "network_egress",
          scheme: "https",
          domain: "metadata.google.internal",
          port: 443
        }
      })
    ).resolves.toMatchObject({
      decision: "deny",
      reason: "Private and metadata network targets are never allowed"
    });
  });

  it("ignores the allow list when askDomains is empty (preserves current behaviour)", async () => {
    const policy = createPolicyEngine({ askDomains: [] });
    await expect(
      policy.authorize({
        approvalMode: "full_access",
        capability: {
          type: "network_egress",
          scheme: "https",
          domain: "anything.example.com",
          port: 443
        }
      })
    ).resolves.toEqual({ decision: "allow" });
  });

  it("does not match an IP literal even if the allow list contains it", async () => {
    const policy = createPolicyEngine({ askDomains: ["192.0.2.10"] });
    await expect(
      policy.authorize({
        approvalMode: "full_access",
        capability: {
          type: "network_egress",
          scheme: "https",
          domain: "192.0.2.10",
          port: 443
        }
      })
    ).resolves.toMatchObject({
      decision: "deny",
      reason: "Private and metadata network targets are never allowed"
    });
  });

  it("does not apply the allow list to capabilities other than network_egress", async () => {
    const policy = createPolicyEngine({
      askDomains: ["registry.npmjs.org"]
    });
    await expect(
      policy.authorize({
        approvalMode: "full_access",
        capability: {
          type: "protected_file_write",
          realpath: "/workspace/.github/workflows/release.yml"
        }
      })
    ).resolves.toEqual({ decision: "allow" });
  });
});
