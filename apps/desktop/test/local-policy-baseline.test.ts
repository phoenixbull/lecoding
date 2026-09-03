import { describe, expect, it } from "vitest";
import type { Capability, PolicyDecision } from "@lecoding/policy";
import { createPolicyEngine, type CapabilityRequest } from "@lecoding/policy";

/**
 * M2.4: the fixed policy baseline survives local execution.
 *
 * The Local Runner adds a filesystem fence, but it must never become a
 * *replacement* for the policy engine. These are the decisions that must hold
 * no matter where a command runs, because they protect things a filesystem
 * fence does not even model: credential files, container control sockets and
 * private network targets.
 */

function request(capability: Capability, overrides: Partial<CapabilityRequest> = {}): CapabilityRequest {
  return {
    approvalMode: "full_access",
    fileAccessScope: "workspace_only",
    capability,
    context: {
      runId: "run-1",
      projectId: "project-a",
      toolCallId: "call-1",
      userTask: "Add a health check endpoint"
    },
    ...overrides
  };
}

const decisions = {
  deny: (reason: string) => ({ decision: "deny", reason }) as PolicyDecision
};

describe("policy baseline under local execution", () => {
  it("denies credential paths even in full_access mode", async () => {
    // full_access is the user's least restrictive choice, and it still must not
    // reach a credential file. If this failed, switching the approval mode
    // would silently unlock every secret on the developer's machine.
    const engine = createPolicyEngine();
    const result = await engine.authorize(
      request({ type: "sensitive_file_read", realpath: "/Users/dev/.ssh/id_rsa" })
    );
    expect(result).toEqual(decisions.deny("Credential and browser secret paths are never allowed"));
  });

  it("denies writes to environment files", async () => {
    const engine = createPolicyEngine();
    const result = await engine.authorize(
      request({ type: "protected_file_write", realpath: "/Users/dev/project/.env" })
    );
    expect(result.decision).toBe("deny");
  });

  it("denies container control commands", async () => {
    // A local Run has the user's privileges, so `docker` could reach the host
    // daemon and escape every fence this repository builds.
    const engine = createPolicyEngine();
    const result = await engine.authorize(
      request({ type: "command_exec", argv: ["docker", "run", "-v", "/:/host", "busybox"], cwd: "/work" })
    );
    expect(result).toEqual(decisions.deny("Host control commands are never allowed"));
  });

  it("denies sudo regardless of the approval mode", async () => {
    const engine = createPolicyEngine();
    const result = await engine.authorize(
      request({ type: "command_exec", argv: ["sudo", "rm", "-rf", "/"], cwd: "/work" })
    );
    expect(result.decision).toBe("deny");
  });

  it("denies private network targets", async () => {
    const engine = createPolicyEngine();
    const result = await engine.authorize(
      request({ type: "network_egress", scheme: "https", domain: "metadata.google.internal", port: 443 })
    );
    expect(result.decision).toBe("deny");
  });

  it("forces a user decision for a domain outside the project's ask list", async () => {
    // askDomains governs egress on the server and must keep governing it
    // locally: a local Run is on the developer's own network, where the
    // reachable targets are more sensitive, not less.
    const engine = createPolicyEngine({ askDomains: ["api.github.com"] });
    const inside = await engine.authorize(
      request({ type: "network_egress", scheme: "https", domain: "api.github.com", port: 443 })
    );
    const outside = await engine.authorize(
      request({ type: "network_egress", scheme: "https", domain: "example.com", port: 443 })
    );
    expect(inside.decision).toBe("allow");
    expect(outside.decision).toBe("ask");
  });

  it("surfaces a protected path for approval even in full_access mode", async () => {
    const engine = createPolicyEngine({
      protectedPaths: { matches: (path) => path.endsWith("/.ai-agent/secrets.yaml") }
    });
    const result = await engine.authorize(
      request({ type: "protected_file_write", realpath: "/work/project/.ai-agent/secrets.yaml" })
    );
    // A project-declared protected path must be approved by a person, which is
    // a stronger requirement than the mode alone would impose.
    expect(result.decision).toBe("ask");
  });

  it("honours the Run's own deny list", async () => {
    // `full_access` cannot override a per-Run deny: the deny list exists
    // precisely to forbid specific commands in a Run that is otherwise open.
    const engine = createPolicyEngine();
    const result = await engine.authorize(
      request(
        { type: "command_exec", argv: ["curl", "https://example.com"], cwd: "/work" },
        { deniedCommands: ["curl"] }
      )
    );
    expect(result.decision).toBe("deny");
  });

  it("still allows a low-risk command under full_access", async () => {
    // Guard against the baseline becoming deny-everything: the fence is meant
    // to remove host escape routes, not to break ordinary development work.
    const engine = createPolicyEngine();
    const result = await engine.authorize(
      request({ type: "command_exec", argv: ["pnpm", "test"], cwd: "/work" })
    );
    expect(result.decision).toBe("allow");
  });
});
