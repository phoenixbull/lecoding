/**
 * Shared IPC contract for the Electron desktop shell.
 *
 * The Main process and the preload bridge share this module so that
 * channel names and request/response shapes are pinned at compile time.
 * Adding a new capability requires all FOUR edits — missing any one of them
 * produces a channel that compiles but silently does nothing at runtime:
 *   1. Append the channel name to IPC_CHANNELS
 *   2. Define the request payload shape in IpcRequestByChannel
 *   3. Register a validator in ipcRequestSchema
 *   4. Add a `case` to the dispatch switch in main/index.ts
 *
 * The Renderer can only reach the documented channels. The contract layer
 * rejects unknown channel names at the preload boundary so a compromised
 * Renderer cannot smuggle arbitrary IPC traffic through the bridge.
 *
 * Two kinds of channel exist and they are deliberately disjoint:
 *   - IPC_CHANNELS  : request/response, callable through `invoke`.
 *   - PUSH_CHANNELS : main-to-Renderer notifications. They are NOT in
 *                     IPC_CHANNELS, so a Renderer cannot invoke them, and the
 *                     preload exposes one named subscribe function per channel
 *                     instead of a generic `ipcRenderer.on`.
 */

import type {
  ApprovalScope,
  ControlPlaneConfig,
  CreateRunInput,
  CreateRunResult,
  EditedApprovalCapability,
  ProjectId,
  ProjectPolicyRuleResult,
  RunChanges,
  RunEventV1,
  RunHistoryResult,
  RunId,
  RunView
} from "@lecoding/contracts";

export const IPC_CHANNELS = [
  "session.bootstrap",
  "session.openGitHubLogin",
  "session.status",
  "session.logout",
  "config.load",
  "devices.createCode",
  "devices.exchange",
  "devices.list",
  "devices.revoke",
  "runs.create",
  "runs.list",
  "runs.inspect",
  "runs.cancel",
  "runs.resolve",
  "runs.changes",
  "runs.artifact",
  "runs.approve",
  "runs.reject",
  "runs.editApprove",
  "runs.answer",
  "runs.steer",
  "runs.subscribe",
  "runs.unsubscribe",
  "policy.list",
  "policy.revoke",
  "host.selectDirectories",
  "host.confirmHostFull",
  "runner.status"
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

/**
 * Channels the main process pushes to the Renderer.
 *
 * They are intentionally excluded from IPC_CHANNELS so they can never be
 * invoked from Renderer code; the preload exposes one subscribe function per
 * entry and nothing else.
 */
export const PUSH_CHANNELS = [
  "runs.event",
  "runs.streamState",
  "session.credentialState",
  "runner.state"
] as const;

export type PushChannel = (typeof PUSH_CHANNELS)[number];

export function isKnownPushChannel(channel: string): channel is PushChannel {
  return (PUSH_CHANNELS as readonly string[]).includes(channel);
}

/** A Run event forwarded from the main process' durable SSE subscription. */
export interface RunEventPush {
  runId: RunId;
  event: RunEventV1;
}

/** Lifecycle of the main-process SSE subscription for one Run. */
export interface StreamStatePush {
  runId: RunId;
  phase: "connecting" | "live" | "reconnecting" | "closed" | "failed";
}

/** Credential storage health, so a degraded backend is never silent. */
export interface CredentialStatePush {
  backend: "safeStorage" | "encryptedFile";
  degraded: boolean;
  reason?: string;
  deviceId?: string;
  expiresAt?: string;
}

/**
 * Local Runner state and the sandbox's real enforcement levels.
 *
 * This is the only channel through which the Renderer learns anything about
 * local execution. It carries status and capability *levels* only — never a
 * worktree path, never a granted directory list, and never a credential. The
 * Renderer cannot enforce anything, so giving it paths would only widen what a
 * compromised Renderer can name.
 */
export interface RunnerStatePush {
  state: "idle" | "connecting" | "live" | "reconnecting" | "stopped" | "unavailable";
  /**
   * Real enforcement per file-access tier on this host, so the UI can show the
   * difference from the server sandbox rather than implying parity.
   */
  sandbox: {
    platform: string;
    tiers: Record<string, string>;
    detail: string;
    /**
     * What this host cannot provide compared with the server's Docker sandbox.
     *
     * Surfaced deliberately, because a local Run that *looks* as confined as a
     * server Run would be a false claim: without a container there is no
     * kernel-enforced CPU, memory or PID ceiling.
     */
    isolationGaps: string[];
  };
}

/**
 * Establishes the session before any other channel may be used.
 *
 * `authToken` is the operator's bearer token for the GitHub-free manual flow.
 * It is held by the main process only — it is never forwarded to the Renderer
 * and never appears in a push payload.
 */
export interface SessionBootstrapPayload {
  baseUrl: string;
  authToken?: string;
}

/** Opens the Main-owned GitHub login URL in the operating system browser. */
export interface SessionOpenGitHubLoginPayload {
  reason?: string;
}

/** Session probe; carries no input because the main process owns the state. */
export interface SessionStatusPayload {
  reason?: string;
}

/** Ends the session and clears locally persisted device credentials. */
export interface SessionLogoutPayload {
  reason?: string;
}

/** Loads the control-plane config (projects, roles, default environment). */
export interface ConfigLoadPayload {
  reason?: string;
}

/**
 * Mints a one-time device code for the given project.
 *
 * The caller must already be authenticated: the code is issued to the session
 * principal, not to whoever later redeems it.
 */
export interface DevicesCreateCodePayload {
  projectId: ProjectId;
}

/**
 * Redeems a one-time device code for a scoped device credential.
 *
 * `platform` must be the real host platform so the device list can distinguish
 * machines; the main process persists the result through the OS keychain.
 */
export interface DevicesExchangePayload {
  code: string;
  deviceLabel: string;
  platform: "darwin" | "win32" | "linux";
}

/**
 * Optional project filter for the device listing.
 *
 * The server scopes the listing to the authenticated user, so this narrows the
 * result client-side; it is never an authorization input.
 */
export interface DevicesListPayload {
  projectId?: ProjectId;
}

/**
 * Revocation targets one device by id.
 *
 * Device ids are globally unique, so no project scoping is accepted — carrying
 * one would imply a permission check that does not happen.
 */
export interface DevicesRevokePayload {
  deviceId: string;
}

/** Admits a new Run under the caller's project role. */
export interface RunsCreatePayload {
  projectId: ProjectId;
  input: CreateRunInput;
}

/** Recent Runs for one project, newest first; `limit` bounds the page size. */
export interface RunsListPayload {
  projectId: ProjectId;
  limit?: number;
}

/** Reads the authoritative Run view, including any pending approval. */
export interface RunsInspectPayload {
  runId: RunId;
}

/**
 * Requests cancellation.
 *
 * Cancellation is cooperative: the engine stops at the next safe boundary, so
 * a successful response means "accepted", not "already stopped".
 */
export interface RunsCancelPayload {
  runId: RunId;
}

/** Keeps or discards a finished Run's managed worktree. */
export interface RunsResolvePayload {
  runId: RunId;
  outcome: "keep" | "discard";
}

/** Reads the bounded diff of one Run's managed worktree. */
export interface RunsChangesPayload {
  runId: RunId;
}

/** Reads one retained command-output artifact by id. */
export interface RunsArtifactPayload {
  runId: RunId;
  artifactId: string;
}

/**
 * Approves a pending capability request.
 *
 * `scope` decides how long the decision sticks: `once` for a single call,
 * `run` for the rest of this Run, `project` as a durable project rule.
 */
export interface RunsApprovePayload {
  runId: RunId;
  approvalId: string;
  scope: ApprovalScope;
}

/**
 * Rejects a pending capability request.
 *
 * A rejection may also be remembered for the chosen scope, so `project` here
 * durably denies the capability — it is not merely "not now".
 */
export interface RunsRejectPayload {
  runId: RunId;
  approvalId: string;
  scope: ApprovalScope;
}

/**
 * Approves a narrowed replacement of the requested capability.
 *
 * The replacement may only reduce the original request; the server rejects
 * anything broader, and fixed-deny rules cannot be overridden this way.
 */
export interface RunsEditApprovePayload {
  runId: RunId;
  approvalId: string;
  replacement: EditedApprovalCapability;
}

/**
 * Answers a pending model-authored question.
 *
 * `value` is user text and is treated as untrusted everywhere downstream; the
 * Renderer must not render it as markup.
 */
export interface RunsAnswerPayload {
  runId: RunId;
  requestId: string;
  value: string;
}

/**
 * Appends a constraint that the Agent reads at its next safe model turn.
 *
 * Only valid while the Run is still live; the engine rejects a steer once the
 * Run reaches a terminal status.
 */
export interface RunsSteerPayload {
  runId: RunId;
  message: string;
}

/**
 * Starts the main-process SSE subscription for one Run.
 *
 * The Renderer cannot open the stream itself — its CSP forbids outbound
 * connections and it never holds a credential — so events arrive as
 * `runs.event` pushes afterwards.
 */
export interface RunsSubscribePayload {
  runId: RunId;
}

/** Stops one Run's subscription; no further `runs.event` pushes follow. */
export interface RunsUnsubscribePayload {
  runId: RunId;
}

/** Lists the project's durable approval rules (administrator surface). */
export interface PolicyListPayload {
  projectId: ProjectId;
}

/** Revokes one project approval rule so the capability is asked again. */
export interface PolicyRevokePayload {
  projectId: ProjectId;
  ruleId: string;
}

/**
 * Opens the OS-native directory picker.
 *
 * The selection comes from the operating system, not from the Renderer: a path
 * typed into a sandboxed web view is not an authorization.
 */
export interface HostSelectDirectoriesPayload {
  reason?: string;
}

/**
 * Shows the OS-native `host_full` danger confirmation.
 *
 * Returns whether the user ticked the acknowledgement. A host without the
 * dialog answers false, so consent can never be inferred from its absence.
 */
export interface HostConfirmHostFullPayload {
  reason?: string;
}

/** Reads the Local Runner state and sandbox capabilities. Carries no input. */
export interface RunnerStatusPayload {
  reason?: string;
}

export interface IpcRequestByChannel {
  "session.bootstrap": SessionBootstrapPayload;
  "session.openGitHubLogin": SessionOpenGitHubLoginPayload;
  "session.status": SessionStatusPayload;
  "session.logout": SessionLogoutPayload;
  "config.load": ConfigLoadPayload;
  "devices.createCode": DevicesCreateCodePayload;
  "devices.exchange": DevicesExchangePayload;
  "devices.list": DevicesListPayload;
  "devices.revoke": DevicesRevokePayload;
  "runs.create": RunsCreatePayload;
  "runs.list": RunsListPayload;
  "runs.inspect": RunsInspectPayload;
  "runs.cancel": RunsCancelPayload;
  "runs.resolve": RunsResolvePayload;
  "runs.changes": RunsChangesPayload;
  "runs.artifact": RunsArtifactPayload;
  "runs.approve": RunsApprovePayload;
  "runs.reject": RunsRejectPayload;
  "runs.editApprove": RunsEditApprovePayload;
  "runs.answer": RunsAnswerPayload;
  "runs.steer": RunsSteerPayload;
  "runs.subscribe": RunsSubscribePayload;
  "runs.unsubscribe": RunsUnsubscribePayload;
  "policy.list": PolicyListPayload;
  "policy.revoke": PolicyRevokePayload;
  "host.selectDirectories": HostSelectDirectoriesPayload;
  "host.confirmHostFull": HostConfirmHostFullPayload;
  "runner.status": RunnerStatusPayload;
}

export type IpcRequestPayload = IpcRequestByChannel[IpcChannel];

export interface IpcRequest<C extends IpcChannel = IpcChannel> {
  channel: C;
  payload: IpcRequestByChannel[C];
}

/** Successful response; `data` is whatever the channel documents. */
export type IpcOkResponse<D = unknown> = { ok: true; data: D };

/**
 * Failed response.
 *
 * `message` is always a human-readable string with any stack stripped: the
 * main process never forwards exception text that could reveal internal types
 * or file paths.
 */
export type IpcErrorResponse = {
  ok: false;
  code: IpcErrorCode;
  message: string;
};

export type IpcResponse<D = unknown> = IpcOkResponse<D> | IpcErrorResponse;

/**
 * Stable error codes so the Renderer can branch on intent, not on messages.
 *
 * `unauthorized` and `forbidden` are separated because the console has to
 * distinguish "log in again" from "this project is not yours"; collapsing them
 * would either trap the user on a dead session or leak membership existence.
 *
 * `device_revoked` covers a revoked *or* expired device: both mean the local
 * credential is dead and the user must rebind, so the Renderer treats them as
 * one outcome rather than showing two different dead ends.
 */
export type IpcErrorCode =
  | "unknown_channel"
  | "untrusted_sender"
  | "validation_failed"
  | "upstream_error"
  | "unauthorized"
  | "forbidden"
  | "device_revoked"
  | "code_consumed"
  | "code_expired"
  | "session_missing";

export function isKnownChannel(channel: string): channel is IpcChannel {
  return (IPC_CHANNELS as readonly string[]).includes(channel);
}

/**
 * Every channel with its payload validator, in one place.
 *
 * Typed as a total `Record` rather than a `switch`: adding a name to
 * `IPC_CHANNELS` without a validator is now a *compile* error instead of a
 * runtime `null`, which is how a channel used to end up registered but
 * silently unvalidated.
 */
const IPC_VALIDATORS: Record<IpcChannel, ChannelValidator> = {
  "session.bootstrap": validateSessionBootstrap,
  "session.openGitHubLogin": validateSessionOpenGitHubLogin,
  "session.status": validateSessionStatus,
  "session.logout": validateSessionLogout,
  "config.load": validateConfigLoad,
  "devices.createCode": validateDevicesCreateCode,
  "devices.exchange": validateDevicesExchange,
  "devices.list": validateDevicesList,
  "devices.revoke": validateDevicesRevoke,
  "runs.create": validateRunsCreate,
  "runs.list": validateRunsList,
  "runs.inspect": validateRunsInspect,
  "runs.cancel": validateRunsCancel,
  "runs.resolve": validateRunsResolve,
  "runs.changes": validateRunsChanges,
  "runs.artifact": validateRunsArtifact,
  "runs.approve": validateRunsApprove,
  "runs.reject": validateRunsReject,
  "runs.editApprove": validateRunsEditApprove,
  "runs.answer": validateRunsAnswer,
  "runs.steer": validateRunsSteer,
  "runs.subscribe": validateRunsSubscribe,
  "runs.unsubscribe": validateRunsUnsubscribe,
  "policy.list": validatePolicyList,
  "policy.revoke": validatePolicyRevoke,
  "host.selectDirectories": validateHostSelectDirectories,
  "host.confirmHostFull": validateHostConfirmHostFull,
  "runner.status": validateRunnerStatus
};

/**
 * Schema lookup keyed by channel name. Each validator returns the
 * normalised payload or throws a `validation_failed` Error.
 *
 * No longer returns `null`: the registry is total, so a known channel always
 * has a validator. Unknown names are rejected earlier by `isKnownChannel`.
 */
export function ipcRequestSchema(channel: IpcChannel): ChannelValidator {
  return IPC_VALIDATORS[channel];
}

/**
 * Normalises one payload or throws.
 *
 * Implementations must never mutate the input: the returned value is what the
 * bridge forwards, so normalisation is also the place unknown keys are dropped.
 */
export type ChannelValidator = (payload: unknown) => unknown;

/**
 * Validates a request against its channel schema.
 *
 * Throws on an unknown channel or an invalid payload; callers are expected to
 * turn that into a `validation_failed` response rather than letting it escape.
 */
export function validateIpcRequest(request: IpcRequest): IpcRequest {
  if (!isKnownChannel(request.channel)) {
    throw new Error(`validation_failed: unknown channel ${String(request.channel)}`);
  }
  const validator = ipcRequestSchema(request.channel);
  if (!validator) {
    throw new Error(`validation_failed: no schema for ${request.channel}`);
  }
  validator(request.payload);
  return request;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`validation_failed: ${key} must be a non-empty string`);
  }
  return value;
}

function requireProjectId(
  payload: Record<string, unknown>,
  channel: IpcChannel
): ProjectId {
  const value = payload["projectId"];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`validation_failed: ${channel} projectId must be a non-empty string`);
  }
  return value as ProjectId;
}

function requireRunId(payload: Record<string, unknown>, channel: IpcChannel): RunId {
  const value = payload["runId"];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`validation_failed: ${channel} runId must be a non-empty string`);
  }
  return value as RunId;
}

/** Approval decisions may only persist at once / run / project granularity. */
function requireScope(payload: Record<string, unknown>, channel: IpcChannel): ApprovalScope {
  const value = payload["scope"];
  if (value !== "once" && value !== "run" && value !== "project") {
    throw new Error(
      `validation_failed: ${channel} scope must be once|run|project`
    );
  }
  return value;
}

/**
 * Validates an operator-narrowed capability.
 *
 * Only the two shapes the policy layer can accept are allowed, and each field
 * is checked by type so a Renderer cannot smuggle a nested object or a
 * non-HTTPS scheme past the bridge.
 */
function requireEditedCapability(
  payload: Record<string, unknown>,
  channel: IpcChannel
): EditedApprovalCapability {
  const value = payload["replacement"];
  if (!isObject(value)) {
    throw new Error(`validation_failed: ${channel} replacement must be an object`);
  }
  if (value["type"] === "command_exec") {
    const argv = value["argv"];
    if (!Array.isArray(argv) || argv.some((entry) => typeof entry !== "string")) {
      throw new Error(
        `validation_failed: ${channel} command_exec argv must be an array of strings`
      );
    }
    return { type: "command_exec", argv: argv as string[] };
  }
  if (value["type"] === "network_egress") {
    const { scheme, domain, port } = value;
    if (scheme !== "https" || typeof domain !== "string" || domain.length === 0) {
      throw new Error(
        `validation_failed: ${channel} network_egress requires scheme https and a domain`
      );
    }
    if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
      throw new Error(
        `validation_failed: ${channel} network_egress port must be a positive integer`
      );
    }
    return { type: "network_egress", scheme: "https", domain, port };
  }
  throw new Error(
    `validation_failed: ${channel} replacement type must be command_exec|network_egress`
  );
}

function validateSessionBootstrap(payload: unknown): SessionBootstrapPayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: session.bootstrap payload must be an object");
  }
  const baseUrl = requireString(payload, "baseUrl");
  const authTokenRaw = payload["authToken"];
  if (authTokenRaw !== undefined && typeof authTokenRaw !== "string") {
    throw new Error("validation_failed: session.bootstrap authToken must be a string");
  }
  const result: SessionBootstrapPayload = { baseUrl };
  if (typeof authTokenRaw === "string") {
    result.authToken = authTokenRaw;
  }
  return result;
}

/** `session.status` and `config.load` take no input; a non-object is still rejected. */
function validateEmptyPayload(payload: unknown, channel: IpcChannel): undefined {
  if (!isObject(payload)) {
    throw new Error(`validation_failed: ${channel} payload must be an object`);
  }
  return undefined;
}

function validateSessionStatus(payload: unknown): SessionStatusPayload {
  validateEmptyPayload(payload, "session.status");
  return {};
}

function validateSessionOpenGitHubLogin(
  payload: unknown
): SessionOpenGitHubLoginPayload {
  validateEmptyPayload(payload, "session.openGitHubLogin");
  return {};
}

function validateConfigLoad(payload: unknown): ConfigLoadPayload {
  validateEmptyPayload(payload, "config.load");
  return {};
}

function validateSessionLogout(payload: unknown): SessionLogoutPayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: session.logout payload must be an object");
  }
  const result: SessionLogoutPayload = {};
  const reason = payload["reason"];
  if (reason !== undefined) {
    if (typeof reason !== "string") {
      throw new Error("validation_failed: session.logout reason must be a string");
    }
    result.reason = reason;
  }
  return result;
}

function validateDevicesCreateCode(payload: unknown): DevicesCreateCodePayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: devices.createCode payload must be an object");
  }
  return { projectId: requireProjectId(payload, "devices.createCode") };
}

function validateDevicesExchange(payload: unknown): DevicesExchangePayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: devices.exchange payload must be an object");
  }
  const code = requireString(payload, "code");
  const deviceLabel = requireString(payload, "deviceLabel");
  const platformRaw = payload["platform"];
  if (platformRaw !== "darwin" && platformRaw !== "win32" && platformRaw !== "linux") {
    throw new Error("validation_failed: devices.exchange platform must be darwin|win32|linux");
  }
  return {
    code,
    deviceLabel,
    platform: platformRaw
  };
}

function validateDevicesList(payload: unknown): DevicesListPayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: devices.list payload must be an object");
  }
  const projectId = payload["projectId"];
  if (projectId === undefined) {
    return {};
  }
  return { projectId: requireProjectId(payload, "devices.list") };
}

function validateDevicesRevoke(payload: unknown): DevicesRevokePayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: devices.revoke payload must be an object");
  }
  return { deviceId: requireString(payload, "deviceId") };
}

function validateRunsCreate(payload: unknown): RunsCreatePayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: runs.create payload must be an object");
  }
  const projectId = requireProjectId(payload, "runs.create");
  const inputRaw = payload["input"];
  if (!isObject(inputRaw)) {
    throw new Error("validation_failed: runs.create input must be an object");
  }
  return { projectId, input: inputRaw as unknown as CreateRunInput };
}

function validateRunsList(payload: unknown): RunsListPayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: runs.list payload must be an object");
  }
  const result: RunsListPayload = { projectId: requireProjectId(payload, "runs.list") };
  const limitRaw = payload["limit"];
  if (limitRaw !== undefined) {
    if (typeof limitRaw !== "number" || !Number.isInteger(limitRaw) || limitRaw <= 0) {
      throw new Error("validation_failed: runs.list limit must be a positive integer");
    }
    result.limit = limitRaw;
  }
  return result;
}

function validateRunsInspect(payload: unknown): RunsInspectPayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: runs.inspect payload must be an object");
  }
  return { runId: requireRunId(payload, "runs.inspect") };
}

function validateRunsCancel(payload: unknown): RunsCancelPayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: runs.cancel payload must be an object");
  }
  return { runId: requireRunId(payload, "runs.cancel") };
}

function validateRunsResolve(payload: unknown): RunsResolvePayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: runs.resolve payload must be an object");
  }
  const outcomeRaw = payload["outcome"];
  if (outcomeRaw !== "keep" && outcomeRaw !== "discard") {
    throw new Error("validation_failed: runs.resolve outcome must be keep|discard");
  }
  return { runId: requireRunId(payload, "runs.resolve"), outcome: outcomeRaw };
}

function validateRunsChanges(payload: unknown): RunsChangesPayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: runs.changes payload must be an object");
  }
  return { runId: requireRunId(payload, "runs.changes") };
}

function validateRunsArtifact(payload: unknown): RunsArtifactPayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: runs.artifact payload must be an object");
  }
  return {
    runId: requireRunId(payload, "runs.artifact"),
    artifactId: requireString(payload, "artifactId")
  };
}

function validateRunsApprove(payload: unknown): RunsApprovePayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: runs.approve payload must be an object");
  }
  return {
    runId: requireRunId(payload, "runs.approve"),
    approvalId: requireString(payload, "approvalId"),
    scope: requireScope(payload, "runs.approve")
  };
}

function validateRunsReject(payload: unknown): RunsRejectPayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: runs.reject payload must be an object");
  }
  return {
    runId: requireRunId(payload, "runs.reject"),
    approvalId: requireString(payload, "approvalId"),
    scope: requireScope(payload, "runs.reject")
  };
}

function validateRunsEditApprove(payload: unknown): RunsEditApprovePayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: runs.editApprove payload must be an object");
  }
  return {
    runId: requireRunId(payload, "runs.editApprove"),
    approvalId: requireString(payload, "approvalId"),
    replacement: requireEditedCapability(payload, "runs.editApprove")
  };
}

function validateRunsAnswer(payload: unknown): RunsAnswerPayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: runs.answer payload must be an object");
  }
  return {
    runId: requireRunId(payload, "runs.answer"),
    requestId: requireString(payload, "requestId"),
    // 4000 characters is the same bound the server enforces, so an oversized
    // answer is rejected at the bridge before it consumes a round trip.
    value: boundedString(payload, "value", 4_000, "runs.answer")
  };
}

function validateRunsSteer(payload: unknown): RunsSteerPayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: runs.steer payload must be an object");
  }
  return {
    runId: requireRunId(payload, "runs.steer"),
    message: boundedString(payload, "message", 4_000, "runs.steer")
  };
}

function validateRunsSubscribe(payload: unknown): RunsSubscribePayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: runs.subscribe payload must be an object");
  }
  return { runId: requireRunId(payload, "runs.subscribe") };
}

function validateRunsUnsubscribe(payload: unknown): RunsUnsubscribePayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: runs.unsubscribe payload must be an object");
  }
  return { runId: requireRunId(payload, "runs.unsubscribe") };
}

function validatePolicyList(payload: unknown): PolicyListPayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: policy.list payload must be an object");
  }
  return { projectId: requireProjectId(payload, "policy.list") };
}

function validatePolicyRevoke(payload: unknown): PolicyRevokePayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: policy.revoke payload must be an object");
  }
  return {
    projectId: requireProjectId(payload, "policy.revoke"),
    ruleId: requireString(payload, "ruleId")
  };
}

/** The native affordances take no meaningful input; a non-object is still rejected. */
function validateHostSelectDirectories(payload: unknown): HostSelectDirectoriesPayload {
  validateEmptyPayload(payload, "host.selectDirectories");
  return {};
}

function validateHostConfirmHostFull(payload: unknown): HostConfirmHostFullPayload {
  validateEmptyPayload(payload, "host.confirmHostFull");
  return {};
}

function validateRunnerStatus(payload: unknown): RunnerStatusPayload {
  validateEmptyPayload(payload, "runner.status");
  return {};
}

/** Requires a non-empty string no longer than `max` characters. */
function boundedString(
  payload: Record<string, unknown>,
  key: string,
  max: number,
  channel: IpcChannel
): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`validation_failed: ${channel} ${key} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new Error(
      `validation_failed: ${channel} ${key} must be at most ${max} characters`
    );
  }
  return value;
}

/**
 * Convenience: re-export Run shapes the Renderer cares about so the
 * preload side can refer to a single import path.
 */
export type RendererRunShape = {
  createResult: CreateRunResult;
  config: ControlPlaneConfig;
  runView: RunView;
  runHistory: RunHistoryResult;
  runChanges: RunChanges;
  policyRules: ProjectPolicyRuleResult;
};
