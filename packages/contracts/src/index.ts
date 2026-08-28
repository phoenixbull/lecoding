export type RunId = string;
export type ProjectId = string;
/** Membership authority ordered from read-only visibility to administration. */
export type ProjectRole = "viewer" | "developer" | "admin";
export type EnvironmentId = string;

export type ApprovalMode = "manual" | "auto_review" | "full_access";
export type FileAccessScope =
  | "workspace_only"
  | "selected_directories"
  | "host_full";

export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "waiting_approval"
  | "waiting_user"
  | "environment_offline"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled";

export interface StartRun {
  projectId: ProjectId;
  environmentId: EnvironmentId;
  task: string;
  acceptanceCriteria: string[];
  approvalMode: ApprovalMode;
  fileAccessScope: FileAccessScope;
  /**
   * Run 作用域的命令拒绝列表:匹配到 argv[0] 的命令一律 deny,
   * 优先级高于 approvalMode 的全局规则。
   * 用于"这个 Run 特定禁用某些命令"的场景,例如安全敏感任务
   * 即使 approvalMode 是 full_access 也不允许跑 curl/docker。
   */
  deniedCommands?: string[];
}

/** Public create body; project identity is bound by the versioned URL path. */
export type CreateRunInput = Omit<StartRun, "projectId">;

/** Accepted Run identity returned before background execution begins. */
export interface CreateRunResult {
  runId: RunId;
}

/** Non-secret registered project exposed to authenticated control-plane clients. */
export interface ControlPlaneProject {
  id: ProjectId;
  /** Current authenticated caller's authority within this project. */
  role: ProjectRole;
}

/** Non-secret membership projection returned only to a project administrator. */
export interface ProjectMembership {
  userId: string;
  role: ProjectRole;
}

/** Complete current membership list for one authorized project. */
export interface ProjectMembershipResult {
  memberships: ProjectMembership[];
}

/** Immutable exact project policy rule visible only to project administrators. */
export interface ProjectPolicyRule {
  id: string;
  projectId: ProjectId;
  capabilityType:
    | "command_exec"
    | "network_egress"
    | "sensitive_file_read"
    | "protected_file_write"
    | "model_upgrade";
  capabilityHash: string;
  constraints: { [key: string]: JsonValue };
  decision: "allow" | "deny";
  createdBy: string;
  sourceApprovalId: string;
  createdAt: string;
  revokedAt?: string;
  revokedBy?: string;
}

/** Complete version history for one authorized project's exact policy rules. */
export interface ProjectPolicyRuleResult {
  rules: ProjectPolicyRule[];
}

/** Non-secret bootstrap values required by the Web client. */
export interface ControlPlaneConfig {
  /** Backward-compatible default project identity. */
  projectId: ProjectId;
  projects: ControlPlaneProject[];
  defaultEnvironmentId: EnvironmentId;
}

export type VerificationOutcome = "passed" | "failed" | "inconclusive";

export interface VerificationCheck {
  name: string;
  outcome: VerificationOutcome;
  detail: string;
}

export interface VerificationReport {
  outcome: VerificationOutcome;
  checks: VerificationCheck[];
}

export interface RunView {
  id: RunId;
  projectId: ProjectId;
  environmentId: EnvironmentId;
  task: string;
  status: RunStatus;
  pendingApproval?: PendingApproval;
  pendingUserRequest?: PendingUserRequest;
  failure?: RunFailure;
  verification?: VerificationReport;
  /** Bounded references to retained large command output; content is fetched separately. */
  artifacts?: ArtifactReference[];
  /** Non-secret provider usage, hard limits, and stable warning labels. */
  budget?: RunBudgetView;
}

/** Authenticated Run usage projection; user identity remains server-side. */
export interface RunBudgetView {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: number;
  toolCalls: number;
  modelRetries: number;
  elapsedMs: number;
  maxTotalTokens: number;
  warningCostUsd: number;
  maxCostUsd: number;
  maxWallTimeMs: number;
  maxToolCalls: number;
  maxModelRetries: number;
  teamMonthlyCostUsd: number;
  teamMonthlyWarningUsd: number;
  teamMonthlyMaxUsd: number;
  modelId: string;
  pricingVersion: string;
  warnings: Array<
    | "token_warning"
    | "cost_warning"
    | "wall_time_warning"
    | "tool_call_warning"
    | "retry_warning"
    | "team_monthly_cost_warning"
  >;
}

/** Content-free operational projection derived from one Run's durable timeline. */
export interface RunOperationalMetrics {
  runId: RunId;
  observedAt: string;
  statusDwellMs: Partial<Record<RunStatus, number>>;
  tools: {
    total: number;
    failed: number;
    totalDurationMs: number;
    outputTruncated: number;
  };
  approvals: {
    requested: number;
    decided: number;
    denied: number;
    totalWaitMs: number;
  };
  userActions: {
    steers: number;
    answers: number;
    cancellations: number;
    keeps: number;
    discards: number;
  };
  worktree: {
    created: boolean;
    disposition: "unresolved" | "retained" | "discarded";
    cleanupFailures: number;
  };
  verification: {
    attempts: number;
    passed: number;
    failed: number;
    inconclusive: number;
  };
  failures: Partial<Record<RunFailure["code"], number>>;
}

/** Durable model question that must be answered before the Run can continue. */
export interface PendingUserRequest {
  id: string;
  prompt: string;
}

/** Lightweight durable Run row used by project history and refresh recovery. */
export interface RunSummary {
  id: RunId;
  projectId: ProjectId;
  environmentId: EnvironmentId;
  task: string;
  status: RunStatus;
  updatedAt: string;
}

/** Bounded newest-first history response for one trusted project. */
export interface RunHistoryResult {
  runs: RunSummary[];
}

/** Bounded, text-only Git change projection for one managed Run worktree. */
export interface RunChanges {
  changedFiles: string[];
  unifiedDiff: string;
  truncated: boolean;
}

export interface RunFailure {
  code:
    | "agent_loop_failed"
    | "policy_denied"
    | "tool_call_outcome_unknown"
    | "budget_exhausted";
  message: string;
}

export interface PendingApproval {
  id: string;
  callId: string;
  summary: string;
  /** Normalized capability category rendered by approval clients. */
  capabilityType?: "command_exec" | "network_egress";
  /** Stable normalized-argument digest used for exact-scope reuse. */
  capabilityHash?: string;
  /** Stable policy explanation; provider response bodies never appear here. */
  reason?: string;
  /** Deterministic presentation severity assigned before user interaction. */
  riskLevel?: "low" | "medium" | "high";
  /** Maximum scopes the current normalized capability can safely reuse. */
  allowedScopes?: ApprovalScope[];
  /** Normalized, non-secret value an approval client may only narrow. */
  editableCapability?: EditedApprovalCapability;
}

/** Maximum persistence boundary for an approval decision. */
export type ApprovalScope = "once" | "run" | "project";

/** User-authored narrower capability accepted only by edit-and-allow-once. */
export type EditedApprovalCapability =
  | { type: "command_exec"; argv: string[] }
  | {
      type: "network_egress";
      scheme: "https";
      domain: string;
      port: number;
    };

export type RunCommand =
  | { type: "cancel" }
  | { type: "steer"; commandId: string; message: string }
  | { type: "answer"; commandId: string; requestId: string; value: string }
  | {
      type: "reject";
      approvalId: string;
      scope: ApprovalScope;
    }
  | {
      type: "approve";
      approvalId: string;
      scope: ApprovalScope;
    }
  | {
      type: "edit_approve";
      approvalId: string;
      replacement: EditedApprovalCapability;
    }
  /**
   * Worker 主动放弃当前环境:把 Run 转为 environment_offline,释放本地句柄,
   * 并 dispose 已注册环境。下次 resume() 会重新 prepare。
   */
  | { type: "recover_environment"; reason: string };

/** Trusted caller context supplied by the authenticated control-plane adapter. */
export interface RunCommandContext {
  actorId: string;
  /** Set only by an API authorization check for a current project admin. */
  canManageProjectRules?: boolean;
}

export interface RunEngine {
  start(input: StartRun, context?: RunStartContext): Promise<RunId>;
  command(
    runId: RunId,
    command: RunCommand,
    context?: RunCommandContext
  ): Promise<void>;
  inspect(runId: RunId): Promise<RunView>;
}

/** Authenticated identity used only for server-side quota admission. */
export interface RunStartContext {
  actorId: string;
}

/**
 * Worker 侧入口:把 Run 从 queued 推进到终态(可恢复执行,也可被其他 Worker 接管)。
 * 对非可驱动状态(novel driver: 非 queued/preparing/waiting_approval/waiting_user/environment_offline)
 * 静默返回,保证幂等,允许调度器无副作用地轮询。
 */
export interface RunResumer {
  resume(runId: RunId): Promise<void>;

  /**
   * Worker 内部环境故障自检入口:独立获取租约(不经用户 command 接口),
   * 把 Run 转为 environment_offline、dispose 已注册环境并释放本地句柄,
   * 下一次 resume() 会重新 prepare。
   * 其他 Worker 持有有效租约时静默返回;语义与
   * command(runId, { type: "recover_environment" }) 一致。
   */
  recoverEnvironment(runId: RunId): Promise<void>;
}

/**
 * Run 租约:跨 Worker 互斥、限时、自动续约。
 * acquire/renew 返回 token 时表示调用方拿到本 Run 的驱动权;
 * 返回 undefined 表示当前已有其他 Worker 持有有效租约(本轮不应推进)。
 * release 必须由持 token 方调用;非 owner 调用安全忽略。
 *
 * 生产可由 PostgreSQL 行锁或 pg-boss 风格 lease 实现。
 * 测试可用本地互斥实现。
 */
export interface RunLease {
  acquire(input: RunLeaseAcquire): Promise<RunLeaseToken | undefined>;
  renew(input: RunLeaseRenew): Promise<boolean>;
  release(input: RunLeaseRelease): Promise<void>;
  /** 标记 run 的当前租约失效;任意持有方在下一次检查时会被踢出。 */
  invalidate(input: RunLeaseRelease): Promise<void>;
}

export interface RunLeaseAcquire {
  runId: RunId;
  ownerId: string;
  leaseUntil: string;
}

export interface RunLeaseRenew {
  runId: RunId;
  ownerId: string;
  leaseUntil: string;
  /**
   * 乐观锁世代号:PG 等持久化租约实现使用。
   * 内存实现忽略;调用方从 acquire 返回的 token 中透传即可。
   * 缺省表示"不做版本校验,仅按 owner 匹配"——旧调用方兼容。
   */
  generation?: number;
}

export interface RunLeaseRelease {
  runId: RunId;
  ownerId: string;
  /** 乐观锁世代号;同 RunLeaseRenew.generation 语义。 */
  generation?: number;
}

export interface RunLeaseToken {
  runId: RunId;
  ownerId: string;
  /**
   * 乐观锁世代号:PG 等持久化租约实现填充。
   * Opaque token:RunEngine 不读,仅在 renew/release/invalidate 时透传。
   * 内存实现不设置。
   */
  generation?: number;
}

/**
 * acquire 重试策略:RunEngine 在 lease 被抢占时按策略循环重试,
 * 避免立即放弃。wait 函数返回本次重试前的等待毫秒数;shouldRetry
 * 在超出总预算时返回 false,RunEngine 视为放弃本次推进。
 * 默认实现 see `createDefaultRunLeaseRetryPolicy` in @lecoding/run-engine,
 * 5 秒封顶,指数退避 25ms 起。
 */
export interface RetryPolicy {
  /** 决策:是否应再试一次 acquire?总预算耗尽时返回 false。 */
  shouldRetry(input: { attempt: number; elapsedMs: number }): boolean;
  /** 等待:在下次尝试前挂起,返回实际等待毫秒数。 */
  wait(input: { attempt: number; elapsedMs: number }): Promise<number>;
}

/**
 * 租约心跳:把长 await(镜像拉取、远端验证等)包进守护,
 * 在 leaseMilliseconds/2 间隔持续 renewLease,
 * 避免长 await 期间租约过期被新 Worker 接管。
 * 适配器内部启动 setInterval 调度;fn resolve 后清除守护。
 * 失租立即抛 LeaseLostError,RunEngine 静默放弃驱动。
 */
export interface LeaseHeartbeat {
  withHeartbeat<T>(
    token: RunLeaseToken,
    intervalMs: number,
    fn: () => Promise<T>,
    /**
     * 每次 renewLease tick 同步触发——提供给 RunEngine 的"store 兜底检测"钩子:
     * 当 PG LISTEN/NOTIFY 漏派时,heartbeat 在 lease 间隔内主动查 store,
     * 发现终态取消立即调 handles.abort 让 perform reject。
     * 错误隔离:onTick 抛错被吞,不污染主路径 fn。
     * 不传则维持原行为(向后兼容)。
     */
    onTick?: () => Promise<void>
  ): Promise<T>;
}

export interface EnvironmentHandle {
  id: string;
  environmentId: EnvironmentId;
}

export interface EnvironmentSpec {
  runId: RunId;
  projectId: ProjectId;
  environmentId: EnvironmentId;
  fileAccessScope: FileAccessScope;
}

export type EnvironmentAction = {
  type: "execute";
  command: string[];
};

export interface EnvironmentResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  artifacts?: ArtifactReference[];
}

/** Content-addressed large-output reference safe to pass through model context. */
export interface ArtifactReference {
  id: string;
  kind: "command_stdout" | "command_stderr";
  contentHash: string;
  byteSize: number;
}

export interface EnvironmentReport {
  changedFiles: string[];
}

/** Event kinds are closed within protocol V1 so every client can render them safely. */
export type RunEventType =
  | "status_changed"
  | "approval_requested"
  | "tool_started"
  | "tool_completed"
  | "user_message_submitted"
  | "user_message_delivered"
  | "agent_question"
  | "verification_completed"
  | "run_failed";

/** JSON-only payloads guarantee that persistence and SSE serialization are lossless. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Stable event envelope shared by Web, Worker, and future PC clients. */
export interface RunEventV1 {
  version: 1;
  sequence: number;
  runId: RunId;
  type: RunEventType;
  occurredAt: string;
  data: JsonValue;
}

const RUN_EVENT_KEYS = new Set([
  "version",
  "sequence",
  "runId",
  "type",
  "occurredAt",
  "data"
]);

const RUN_EVENT_TYPES = new Set<RunEventType>([
  "status_changed",
  "approval_requested",
  "tool_started",
  "tool_completed",
  "user_message_submitted",
  "user_message_delivered",
  "agent_question",
  "verification_completed",
  "run_failed"
]);

/**
 * Validates an untrusted event before it crosses a process or persistence seam.
 * V1 is intentionally strict: new fields or kinds require a versioned contract.
 */
export function parseRunEvent(input: unknown): RunEventV1 {
  if (typeof input !== "object" || input === null || !("version" in input)) {
    throw new Error("Invalid RunEvent envelope");
  }

  if (input.version !== 1) {
    throw new Error(`Unsupported RunEvent version: ${String(input.version)}`);
  }

  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== RUN_EVENT_KEYS.size || keys.some((key) => !RUN_EVENT_KEYS.has(key))) {
    throw new Error("Invalid RunEvent fields");
  }
  if (!Number.isSafeInteger(record.sequence) || Number(record.sequence) < 1) {
    throw new Error("Invalid RunEvent sequence");
  }
  if (typeof record.runId !== "string" || record.runId.trim() === "") {
    throw new Error("Invalid RunEvent runId");
  }
  if (
    typeof record.type !== "string" ||
    !RUN_EVENT_TYPES.has(record.type as RunEventType)
  ) {
    throw new Error("Invalid RunEvent type");
  }
  if (!isCanonicalUtcTimestamp(record.occurredAt)) {
    throw new Error("Invalid RunEvent occurredAt");
  }
  if (!isJsonValue(record.data)) {
    throw new Error("Invalid RunEvent data");
  }

  return input as RunEventV1;
}

/** Canonical UTC timestamps avoid timezone-dependent ordering and display bugs. */
function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

/** Recursively rejects values that JSON.stringify would drop or distort. */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Object.values(value).every(isJsonValue);
}
