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
  /**
   * Run 作用域的命令拒绝列表:argv[0] 命中即 deny,
   * 优先级高于 approvalMode 全局规则。由 Run 启动方传入,
   * 每个 Run 可自定义安全边界。
   */
  deniedCommands?: string[];
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

    /*
     * Run 作用域拒绝列表:优先级高于 approvalMode 全局规则。
     * 即使 approvalMode 是 full_access,也要拒绝 deniedCommands 中的命令——
     * 这是"这个 Run 特定禁用某些命令"的安全边界。
     * 仅匹配 argv[0](可执行文件名),子串精确匹配,避免误伤同名变体。
     */
    if (
      request.capability.type === "command_exec" &&
      request.deniedCommands !== undefined &&
      request.capability.argv[0] !== undefined &&
      request.deniedCommands.includes(request.capability.argv[0])
    ) {
      return {
        decision: "deny",
        reason: `Command "${request.capability.argv[0]}" is denied by this run's policy`
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
