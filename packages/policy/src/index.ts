import type { ApprovalMode, FileAccessScope } from "@lecoding/contracts";
import { isIP } from "node:net";

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
      isCredentialOrHostControlPath(request.capability.realpath)
    ) {
      return {
        decision: "deny",
        reason:
          request.capability.realpath === "/var/run/docker.sock"
            ? "Docker socket access is never allowed"
            : "Credential and browser secret files are never allowed"
      };
    }

    if (
      request.capability.type === "network_egress" &&
      isForbiddenNetworkTarget(request.capability.domain)
    ) {
      return {
        decision: "deny",
        reason: "Private and metadata network targets are never allowed"
      };
    }

    if (
      request.capability.type === "command_exec" &&
      isHostControlCommand(request.capability.argv[0])
    ) {
      return {
        decision: "deny",
        reason: "Host control commands are never allowed"
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

function isForbiddenNetworkTarget(domain: string): boolean {
  const normalized = domain.trim().toLowerCase().replace(/\.$/u, "");
  // Approval is domain-scoped; raw IP literals cannot receive an interactive grant.
  if (isIP(normalized) !== 0) {
    return true;
  }
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "metadata.google.internal" ||
    normalized.endsWith(".metadata.google.internal") ||
    normalized === "instance-data.ec2.internal" ||
    normalized.endsWith(".instance-data.ec2.internal")
  );
}

function isCredentialOrHostControlPath(realpath: string): boolean {
  const normalized = realpath.toLowerCase();
  const basename = normalized.split("/").at(-1) ?? "";
  return (
    normalized === "/var/run/docker.sock" ||
    basename === ".env" ||
    basename.startsWith(".env.") ||
    basename === ".npmrc" ||
    basename === ".pypirc" ||
    basename === ".netrc" ||
    normalized.includes("/.ssh/") ||
    normalized.includes("/.gnupg/") ||
    normalized.endsWith("/.aws/credentials") ||
    normalized.endsWith("/.kube/config") ||
    normalized.includes("/keychains/") ||
    normalized.includes("/google-chrome/") ||
    normalized.includes("/chromium/") ||
    normalized.includes("/firefox/")
  );
}

function isHostControlCommand(executable: string | undefined): boolean {
  const basename = executable?.split("/").at(-1)?.toLowerCase();
  return (
    basename !== undefined &&
    new Set([
      "sudo",
      "mount",
      "umount",
      "docker",
      "podman",
      "nerdctl",
      "nsenter",
      "unshare"
    ]).has(basename)
  );
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
