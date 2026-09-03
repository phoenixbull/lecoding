import type {
  ApprovalScope,
  ControlPlaneConfig,
  CreateRunInput,
  CreateRunResult,
  EditedApprovalCapability,
  ProjectId,
  ProjectPolicyRuleResult,
  RunChanges,
  RunHistoryResult,
  RunId,
  RunView
} from "@lecoding/contracts";

/**
 * The single capability port the Run console controller depends on.
 *
 * Two adapters satisfy it — the Web page's client-sdk adapter and the
 * Electron Renderer's IPC adapter — so every Run-management behaviour is
 * defined exactly once and both surfaces stay semantically identical.
 *
 * Adapter obligations:
 *   - Normalise an authenticated-but-rejected request to an object carrying
 *     `status === 401` so `isUnauthorized` can classify it and the controller
 *     can move to the `needs_auth` phase instead of a generic failure.
 *   - Let every other error propagate unchanged; the controller attaches the
 *     user-facing copy and never inspects transport internals.
 *   - Never return credentials, raw provider bodies, or unredacted paths.
 */
export interface RunGateway {
  getControlPlaneConfig(): Promise<ControlPlaneConfig>;
  logout(): Promise<void>;
  createRun(projectId: ProjectId, input: CreateRunInput): Promise<CreateRunResult>;
  inspectRun(runId: RunId): Promise<RunView>;
  listRuns(projectId: ProjectId, limit?: number): Promise<RunHistoryResult>;
  cancelRun(runId: RunId): Promise<void>;
  resolveRunResult(runId: RunId, outcome: "keep" | "discard"): Promise<void>;
  getRunChanges(runId: RunId): Promise<RunChanges>;
  getRunArtifact(runId: RunId, artifactId: string): Promise<string>;
  approveRun(runId: RunId, approvalId: string, scope: ApprovalScope): Promise<void>;
  rejectRun(runId: RunId, approvalId: string, scope: ApprovalScope): Promise<void>;
  editAndApproveRun(
    runId: RunId,
    approvalId: string,
    replacement: EditedApprovalCapability
  ): Promise<void>;
  answerRun(runId: RunId, requestId: string, value: string): Promise<void>;
  steerRun(runId: RunId, message: string): Promise<void>;
  listProjectPolicyRules(projectId: ProjectId): Promise<ProjectPolicyRuleResult>;
  revokeProjectPolicyRule(projectId: ProjectId, ruleId: string): Promise<void>;
  /**
   * Mints a one-time device code for the selected project. The code is shown
   * to the operator on this machine and exchanged here — it never travels to
   * another surface.
   */
  createDeviceCode(projectId: ProjectId): Promise<DeviceCodeResult>;
  exchangeDeviceCode(input: DeviceExchangeInput): Promise<void>;
  listDevices(): Promise<DeviceListing>;
  revokeDevice(deviceId: string): Promise<void>;
}

/** Issued one-time code, mirroring the worker's device-binding response. */
export interface DeviceCodeResult {
  code: string;
  expiresAt: string;
}

/** Non-secret operator input required to redeem a Web-issued one-time code. */
export interface DeviceExchangeInput {
  code: string;
  deviceLabel: string;
  platform: string;
}

/** Non-secret projection of one bound device. */
export interface DeviceSummary {
  deviceId: string;
  deviceLabel: string;
  platform: string;
  projectId: string;
  projectName: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

/** Server-scoped device inventory; adapters must not include access tokens. */
export interface DeviceListing {
  devices: DeviceSummary[];
}

/**
 * Classifies a rejected request as an authentication problem.
 *
 * The controller must be able to distinguish "your session expired" from "the
 * Worker is down" without depending on the client-sdk, so adapters are
 * required to surface HTTP 401 on the thrown error.
 */
export function isUnauthorized(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 401
  );
}

/**
 * Classifies an admin-only surface that the server hides with 404.
 *
 * The project policy-rule endpoint deliberately answers 404 for non-
 * administrators, so hiding the panel on 404 and surfacing a failure on any
 * other error keeps authorization and availability distinct.
 */
export function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 404
  );
}
