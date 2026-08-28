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
  /** Stable context supplied by RunEngine; never inferred from reviewer output. */
  context?: {
    runId: string;
    projectId: string;
    toolCallId: string;
    userTask: string;
    capabilityHash?: string;
  };
}

/** Exact administrator-owned project rule lookup; absence falls through to mode. */
export interface ProjectPolicyRuleResolver {
  resolve(input: {
    projectId: string;
    capabilityType: Capability["type"];
    capabilityHash: string;
  }): Promise<"allow" | "deny" | undefined>;
}

/** Bounded independent review result; it can never override a fixed deny. */
export interface RiskReviewResult {
  decision: "allow" | "ask";
  riskLevel: "low" | "medium" | "high";
  reason: string;
  ruleVersion: string;
  reviewerVersion: string;
}

/** Reviewer runs independently from the task model and sees normalized input only. */
export interface RiskReviewer {
  review(request: CapabilityRequest): Promise<RiskReviewResult>;
}

/** Durable observer required by production for every automatic review decision. */
export interface PolicyReviewAudit {
  record(entry: {
    request: CapabilityRequest;
    result: RiskReviewResult;
  }): Promise<void>;
}

/** Construction seams for reviewer isolation and durable audit persistence. */
export interface PolicyEngineOptions {
  reviewer?: RiskReviewer;
  audit?: PolicyReviewAudit;
  projectRules?: ProjectPolicyRuleResolver;
}

export type PolicyDecision =
  | {
      decision: "allow";
      review?: RiskReviewResult;
      projectRule?: "allow";
    }
  | { decision: "ask"; reason: string; review?: RiskReviewResult }
  | { decision: "deny"; reason: string; projectRule?: "deny" };

export interface PolicyEngine {
  authorize(request: CapabilityRequest): Promise<PolicyDecision>;
}

export function createPolicyEngine(
  options: PolicyEngineOptions = {}
): PolicyEngine {
  return new DefaultPolicyEngine(
    options.reviewer ?? new DeterministicRiskReviewer(),
    options.audit ?? { async record() {} },
    options.projectRules
  );
}

class DefaultPolicyEngine implements PolicyEngine {
  constructor(
    private readonly reviewer: RiskReviewer,
    private readonly audit: PolicyReviewAudit,
    private readonly projectRules?: ProjectPolicyRuleResolver
  ) {}

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

    const projectRule =
      request.context?.capabilityHash && this.projectRules
        ? await this.projectRules.resolve({
            projectId: request.context.projectId,
            capabilityType: request.capability.type,
            capabilityHash: request.context.capabilityHash
          })
        : undefined;
    if (projectRule === "deny") {
      return {
        decision: "deny",
        reason: "Project policy denies this exact capability",
        projectRule
      };
    }
    if (projectRule === "allow") {
      return { decision: "allow", projectRule };
    }

    if (request.approvalMode === "full_access") {
      return { decision: "allow" };
    }

    if (request.approvalMode === "auto_review") {
      const review = validateRiskReview(await this.reviewer.review(request));
      // Audit completion is part of authorization; failure therefore fails closed.
      await this.audit.record({ request, result: review });
      return review.decision === "allow"
        ? { decision: "allow", review }
        : { decision: "ask", reason: review.reason, review };
    }

    return { decision: "ask", reason: "Capability requires approval" };
  }
}

class DeterministicRiskReviewer implements RiskReviewer {
  async review(request: CapabilityRequest): Promise<RiskReviewResult> {
    const allow = isLowRiskCommand(request.capability);
    return {
      decision: allow ? "allow" : "ask",
      riskLevel: allow ? "low" : "high",
      reason: allow
        ? "Deterministic low-risk command rule matched"
        : "Independent reviewer requires user approval",
      ruleVersion: "phase2-policy-v1",
      reviewerVersion: "deterministic-risk-reviewer-v1"
    };
  }
}

function validateRiskReview(result: RiskReviewResult): RiskReviewResult {
  if (
    (result.decision !== "allow" && result.decision !== "ask") ||
    !["low", "medium", "high"].includes(result.riskLevel) ||
    result.reason.trim() === "" ||
    result.reason.length > 2_000 ||
    result.ruleVersion.trim() === "" ||
    result.ruleVersion.length > 128 ||
    result.reviewerVersion.trim() === "" ||
    result.reviewerVersion.length > 128
  ) {
    throw new Error("Risk reviewer returned an invalid decision");
  }
  return result;
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
  const exactScript = ["test", "lint", "typecheck", "check"];
  if (
    executable === "git" &&
    capability.argv.length === 2 &&
    (command === "status" || command === "diff")
  ) {
    return true;
  }
  if (
    (executable === "pnpm" || executable === "yarn") &&
    capability.argv.length === 2 &&
    command !== undefined &&
    exactScript.includes(command)
  ) {
    return true;
  }
  if (executable === "npm") {
    return (
      (capability.argv.length === 2 && command === "test") ||
      (capability.argv.length === 3 &&
        command === "run" &&
        exactScript.includes(capability.argv[2]!))
    );
  }
  return false;
}
