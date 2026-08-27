import type {
  ControlPlaneConfig,
  RunEventV1,
  RunEventType,
  RunStatus,
  VerificationOutcome
} from "@lecoding/contracts";

/** Resolves the visible project allowlist while retaining a still-valid choice. */
export function resolveProjectSelection(
  config: ControlPlaneConfig,
  previousProjectId: string | undefined
): { projectIds: string[]; selectedProjectId: string } {
  const projectIds = config.projects.map((project) => project.id);
  if (projectIds.length === 0) {
    throw new Error("Control plane returned no registered projects");
  }
  const defaultProjectId = projectIds.includes(config.projectId)
    ? config.projectId
    : projectIds[0]!;
  const selectedProjectId = projectIds.includes(previousProjectId ?? "")
    ? previousProjectId!
    : defaultProjectId;
  return { projectIds, selectedProjectId };
}

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "已排队",
  preparing: "准备环境",
  running: "执行中",
  waiting_approval: "等待审批",
  waiting_user: "等待输入",
  environment_offline: "环境离线",
  verifying: "验证中",
  succeeded: "已通过",
  failed: "失败",
  cancelling: "取消中",
  cancelled: "已取消"
};

const EVENT_LABELS: Record<RunEventType, string> = {
  status_changed: "状态更新",
  approval_requested: "需要审批",
  tool_started: "开始执行工具",
  tool_completed: "工具执行完成",
  user_message_submitted: "用户追加指令",
  user_message_delivered: "指令已投递",
  agent_question: "Agent 追问",
  verification_completed: "验证完成",
  run_failed: "运行失败"
};

/** Human-readable status label used consistently across the Run header and timeline. */
export function statusLabel(status: RunStatus): string {
  return STATUS_LABELS[status];
}

/** Terminal statuses stop SSE consumption and disable cancellation. */
export function isTerminalStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** A managed worktree exists only after preparation and is discarded on cancel. */
export function canLoadRunChanges(status: RunStatus): boolean {
  return (
    status !== "queued" &&
    status !== "preparing" &&
    status !== "cancelling" &&
    status !== "cancelled"
  );
}

/** Completed worktrees remain user-discardable; cancelled Runs are already cleaned up. */
export function canResolveRunResult(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed";
}

/** Stable event title independent of untrusted event payload content. */
export function formatEventTitle(type: RunEventType): string {
  return EVENT_LABELS[type];
}

/** Formats only validated primitive fields; unknown payloads remain inert summaries. */
export function formatRunEventDetail(event: RunEventV1): string {
  const data =
    typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
      ? event.data
      : undefined;
  if (event.type === "status_changed" && typeof data?.status === "string") {
    return isRunStatus(data.status) ? statusLabel(data.status) : `事件 #${event.sequence}`;
  }
  if (
    event.type === "user_message_submitted" &&
    typeof data?.message === "string"
  ) {
    return data.message;
  }
  if (event.type === "agent_question" && typeof data?.prompt === "string") {
    return data.prompt;
  }
  if (
    event.type === "user_message_delivered" &&
    Array.isArray(data?.messageIds)
  ) {
    return `已投递 ${data.messageIds.length} 条输入`;
  }
  if (event.type === "approval_requested" && typeof data?.summary === "string") {
    return boundedText(data.summary);
  }
  if (event.type === "tool_started" && typeof data?.command === "string") {
    const argumentCount = safeCount(data.argumentCount);
    return argumentCount === undefined
      ? boundedText(data.command)
      : `${boundedText(data.command)}（${argumentCount} 个参数）`;
  }
  if (event.type === "tool_completed") {
    if (data?.outcome === "denied") {
      return "用户已拒绝执行";
    }
    if (data?.outcome === "executed" && typeof data.exitCode === "number") {
      return `执行完成，退出码 ${data.exitCode}`;
    }
  }
  if (
    event.type === "verification_completed" &&
    typeof data?.outcome === "string"
  ) {
    const outcome = verificationOutcomeLabel(data.outcome);
    const checkCount = safeCount(data.checkCount);
    return outcome === undefined
      ? `事件 #${event.sequence}`
      : checkCount === undefined
        ? outcome
        : `${outcome}（${checkCount} 项检查）`;
  }
  if (event.type === "run_failed" && typeof data?.message === "string") {
    const message = boundedText(data.message);
    return typeof data.code === "string"
      ? `${message}（${boundedText(data.code)}）`
      : message;
  }
  return `事件 #${event.sequence}`;
}

/** Terminal status events delimit complete durable history replay. */
export function isTerminalRunEvent(event: RunEventV1): boolean {
  const data =
    typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
      ? event.data
      : undefined;
  return (
    event.type === "status_changed" &&
    typeof data?.status === "string" &&
    isRunStatus(data.status) &&
    isTerminalStatus(data.status)
  );
}

function isRunStatus(value: string): value is RunStatus {
  return Object.prototype.hasOwnProperty.call(STATUS_LABELS, value);
}

/** Caps untrusted timeline strings while preserving the useful leading context. */
function boundedText(value: string): string {
  return value.length <= 240 ? value : `${value.slice(0, 239)}…`;
}

/** Accepts only non-negative integer counters from event payloads. */
function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Maps protocol outcomes without reflecting unknown values into the DOM. */
function verificationOutcomeLabel(value: string): string | undefined {
  switch (value) {
    case "passed":
      return "验证通过";
    case "failed":
      return "验证失败";
    case "inconclusive":
      return "验证结果不确定";
    default:
      return undefined;
  }
}

/** Visual tone keeps inconclusive evidence distinct from a successful check. */
export function verificationTone(
  outcome: VerificationOutcome
): "positive" | "negative" | "warning" {
  switch (outcome) {
    case "passed":
      return "positive";
    case "failed":
      return "negative";
    case "inconclusive":
      return "warning";
  }
}
