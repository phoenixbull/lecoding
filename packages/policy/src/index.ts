import type { ApprovalMode, FileAccessScope } from "@lecoding/contracts";

export type Capability =
  | { type: "sensitive_file_read"; realpath: string }
  | { type: "protected_file_write"; realpath: string }
  | { type: "command_exec"; argv: string[]; cwd: string }
  | { type: "network_egress"; scheme: "https"; domain: string; port: number }
  | { type: "model_upgrade"; modelId: string };

export interface CapabilityRequest {
  approvalMode: ApprovalMode;
  fileAccessScope: FileAccessScope;
  capability: Capability;
}

export type PolicyDecision =
  | { decision: "allow" }
  | { decision: "ask"; reason: string }
  | { decision: "deny"; reason: string };

export interface PolicyEngine {
  authorize(request: CapabilityRequest): Promise<PolicyDecision>;
}

export function createPolicyEngine(): PolicyEngine {
  return new DefaultPolicyEngine();
}

class DefaultPolicyEngine implements PolicyEngine {
  async authorize(request: CapabilityRequest): Promise<PolicyDecision> {
    if (
      request.capability.type === "sensitive_file_read" &&
      request.capability.realpath === "/var/run/docker.sock"
    ) {
      return {
        decision: "deny",
        reason: "Docker socket access is never allowed"
      };
    }

    if (request.approvalMode === "full_access") {
      return { decision: "allow" };
    }

    if (
      request.approvalMode === "auto_review" &&
      isLowRiskCommand(request.capability)
    ) {
      return { decision: "allow" };
    }

    return { decision: "ask", reason: "Capability requires approval" };
  }
}

function isLowRiskCommand(capability: Capability): boolean {
  if (capability.type !== "command_exec") {
    return false;
  }

  const [executable, command] = capability.argv;
  return (
    ((executable === "pnpm" || executable === "npm" || executable === "yarn") &&
      (command === "test" ||
        command === "lint" ||
        command === "typecheck" ||
        command === "check")) ||
    (executable === "git" && (command === "status" || command === "diff"))
  );
}
