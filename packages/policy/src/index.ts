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

/**
 * Project-declared protected paths, surfaced from the reviewed
 * `.ai-agent/project.yaml`. A match forces `protected_file_write` to be
 * surfaced for explicit user approval without weakening the fixed deny that
 * covers credential and host-control paths.
 */
export interface ProjectProtectedPathMatcher {
  matches(realpath: string): boolean;
}

/**
 * Project-declared network allow list (from the reviewed
 * `.ai-agent/project.yaml`). When the matcher is bound, `network_egress`
 * targets whose domain does not match are forced through explicit user
 * approval even in `full_access` mode. The matcher sits after the fixed
 * deny so private and metadata targets stay denied regardless of the
 * operator-owned allow list.
 */
export interface ProjectNetworkAllowListMatcher {
  /**
   * Returns true if the given normalised domain is allowed by the project's
   * declared `network.askDomains`.
   */
  matches(domain: string): boolean;
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
  /** Optional project-declared protected-path matcher (from `.ai-agent/project.yaml`). */
  protectedPaths?: ProjectProtectedPathMatcher;
  /**
   * Optional project-declared network allow list (from the reviewed
   * `network.askDomains` YAML field). When provided, every `network_egress`
   * whose domain is not in the list returns `ask` regardless of approval mode.
   */
  askDomains?: ProjectNetworkAllowListMatcher | string[];
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
    options.projectRules,
    options.protectedPaths,
    normaliseAskDomains(options.askDomains)
  );
}

class DefaultPolicyEngine implements PolicyEngine {
  constructor(
    private readonly reviewer: RiskReviewer,
    private readonly audit: PolicyReviewAudit,
    private readonly projectRules?: ProjectPolicyRuleResolver,
    private readonly protectedPaths?: ProjectProtectedPathMatcher,
    private readonly askDomains?: ProjectNetworkAllowListMatcher
  ) {}

  async authorize(request: CapabilityRequest): Promise<PolicyDecision> {
    if (
      (request.capability.type === "sensitive_file_read" ||
        request.capability.type === "protected_file_write") &&
      isCredentialOrHostControlPath(request.capability.realpath)
    ) {
      return {
        decision: "deny",
        reason:
          isHostControlSocketPath(request.capability.realpath)
            ? "Docker socket access is never allowed"
            : "Credential and browser secret paths are never allowed"
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

    /*
     * Project-declared network allow list (from `network.askDomains`).
     * Sits after the fixed deny so the operator cannot re-authorise
     * private or metadata targets; sits before the project rules and
     * approval mode so even `full_access` Runs must surface undeclared
     * domains for explicit user approval.
     */
    if (
      request.capability.type === "network_egress" &&
      this.askDomains !== undefined &&
      !this.askDomains.matches(request.capability.domain)
    ) {
      return {
        decision: "ask",
        reason: "Domain is not in the project's allow list; user approval required"
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
     * Project-declared protected paths: this sits AFTER the fixed-deny checks
     * so an attacker cannot bypass the credential/host-control block by
     * listing `/workspace/.env` in the project rules. It sits BEFORE the
     * project rules / approval mode so every protected path write requires
     * explicit user approval regardless of mode.
     */
    if (
      request.capability.type === "protected_file_write" &&
      this.protectedPaths !== undefined &&
      this.protectedPaths.matches(request.capability.realpath)
    ) {
      return {
        decision: "ask",
        reason: "Project declares this path as protected; user approval required"
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

function normaliseDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/u, "");
}

/**
 * Coerces the optional `askDomains` option into a matcher. An explicit
 * matcher is passed through untouched; a `string[]` is normalised into an
 * exact-domain matcher that lower-cases and strips the trailing dot, so the
 * YAML loader does not need to know about either operation.
 */
function normaliseAskDomains(
  option: ProjectNetworkAllowListMatcher | string[] | undefined
): ProjectNetworkAllowListMatcher | undefined {
  if (option === undefined) {
    return undefined;
  }
  if (Array.isArray(option)) {
    const allowed = new Set(option.map(normaliseDomain).filter((entry) => entry.length > 0));
    // An empty allow list is equivalent to "no project-level restriction":
    // every domain passes and the existing approval-mode pipeline decides.
    if (allowed.size === 0) {
      return undefined;
    }
    return {
      matches(domain) {
        return allowed.has(normaliseDomain(domain));
      }
    };
  }
  return option;
}

function isCredentialOrHostControlPath(realpath: string): boolean {
  const normalized = realpath.toLowerCase();
  const basename = normalized.split("/").at(-1) ?? "";
  return (
    isHostControlSocketPath(normalized) ||
    basename === ".env" ||
    basename.startsWith(".env.") ||
    basename === ".npmrc" ||
    basename === ".pypirc" ||
    basename === ".netrc" ||
    normalized.includes("/.ssh/") ||
    normalized.includes("/.gnupg/") ||
    normalized.endsWith("/.aws/credentials") ||
    normalized.endsWith("/.docker/config.json") ||
    normalized.includes("/.config/gcloud/") ||
    normalized.includes("/.azure/") ||
    normalized.endsWith("/.kube/config") ||
    normalized.includes("/keychains/") ||
    normalized.includes("/google-chrome/") ||
    normalized.includes("/chromium/") ||
    normalized.includes("/firefox/")
  );
}

/** Covers canonical system and rootless container-runtime control sockets. */
function isHostControlSocketPath(realpath: string): boolean {
  const basename = realpath.toLowerCase().split("/").at(-1) ?? "";
  return new Set(["docker.sock", "podman.sock", "containerd.sock"]).has(basename);
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
