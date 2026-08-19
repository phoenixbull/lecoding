export type RunId = string;
export type ProjectId = string;
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
  failure?: RunFailure;
  verification?: VerificationReport;
}

export interface RunFailure {
  code: "agent_loop_failed" | "policy_denied";
  message: string;
}

export interface PendingApproval {
  id: string;
  callId: string;
  summary: string;
}

export type RunCommand =
  | { type: "cancel" }
  | { type: "steer"; message: string }
  | { type: "answer"; requestId: string; value: unknown }
  | {
      type: "reject";
      approvalId: string;
      scope: "once" | "run";
    }
  | {
      type: "approve";
      approvalId: string;
      scope: "once" | "run";
    };

export interface RunEngine {
  start(input: StartRun): Promise<RunId>;
  command(runId: RunId, command: RunCommand): Promise<void>;
  inspect(runId: RunId): Promise<RunView>;
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
