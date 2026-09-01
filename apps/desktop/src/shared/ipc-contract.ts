/**
 * Shared IPC contract for the Electron desktop shell.
 *
 * The Main process and the preload bridge share this module so that
 * channel names and request/response shapes are pinned at compile time.
 * Adding a new capability requires:
 *   1. Append the channel name to IPC_CHANNELS
 *   2. Define the request payload shape in IpcRequestByChannel
 *   3. Register a validator in ipcRequestSchema
 *
 * The Renderer can only reach the documented channels. The contract layer
 * rejects unknown channel names at the preload boundary so a compromised
 * Renderer cannot smuggle arbitrary IPC traffic through the bridge.
 */

import type {
  CreateRunInput,
  CreateRunResult,
  ProjectId,
  RunHistoryResult,
  RunId,
  RunView
} from "@lecoding/contracts";

export const IPC_CHANNELS = [
  "session.bootstrap",
  "session.logout",
  "devices.createCode",
  "devices.exchange",
  "devices.list",
  "devices.revoke",
  "runs.create",
  "runs.cancel",
  "runs.list",
  "runs.inspect",
  "runs.resolve"
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

export interface SessionBootstrapPayload {
  baseUrl: string;
  authToken?: string;
}

export interface SessionLogoutPayload {
  reason?: string;
}

export interface DevicesCreateCodePayload {
  projectId: ProjectId;
}

export interface DevicesExchangePayload {
  code: string;
  deviceLabel: string;
  platform: "darwin" | "win32" | "linux";
  projectId: ProjectId;
}

export interface DevicesListPayload {
  projectId: ProjectId;
}

export interface DevicesRevokePayload {
  deviceId: string;
  projectId: ProjectId;
}

export interface RunsCreatePayload {
  projectId: ProjectId;
  input: CreateRunInput;
}

export interface RunsCancelPayload {
  runId: RunId;
}

export interface RunsListPayload {
  projectId: ProjectId;
  limit?: number;
}

export interface RunsInspectPayload {
  runId: RunId;
}

export interface RunsResolvePayload {
  runId: RunId;
  outcome: "keep" | "discard";
}

export interface IpcRequestByChannel {
  "session.bootstrap": SessionBootstrapPayload;
  "session.logout": SessionLogoutPayload;
  "devices.createCode": DevicesCreateCodePayload;
  "devices.exchange": DevicesExchangePayload;
  "devices.list": DevicesListPayload;
  "devices.revoke": DevicesRevokePayload;
  "runs.create": RunsCreatePayload;
  "runs.cancel": RunsCancelPayload;
  "runs.list": RunsListPayload;
  "runs.inspect": RunsInspectPayload;
  "runs.resolve": RunsResolvePayload;
}

export type IpcRequestPayload = IpcRequestByChannel[IpcChannel];

export interface IpcRequest<C extends IpcChannel = IpcChannel> {
  channel: C;
  payload: IpcRequestByChannel[C];
}

export type IpcOkResponse<D = unknown> = { ok: true; data: D };
export type IpcErrorResponse = {
  ok: false;
  code: string;
  message: string;
};
export type IpcResponse<D = unknown> = IpcOkResponse<D> | IpcErrorResponse;

/** Stable error codes so the Renderer can branch on intent, not on messages. */
export type IpcErrorCode =
  | "unknown_channel"
  | "untrusted_sender"
  | "validation_failed"
  | "upstream_error"
  | "device_revoked"
  | "code_consumed"
  | "code_expired"
  | "session_missing";

export function isKnownChannel(channel: string): channel is IpcChannel {
  return (IPC_CHANNELS as readonly string[]).includes(channel);
}

/**
 * Schema lookup keyed by channel name. Each validator returns the
 * normalised payload or throws a `validation_failed` Error. The function
 * returns `null` for unknown channels so callers can branch explicitly.
 */
export function ipcRequestSchema(channel: IpcChannel): ChannelValidator | null {
  switch (channel) {
    case "session.bootstrap":
      return validateSessionBootstrap;
    case "session.logout":
      return validateSessionLogout;
    case "devices.createCode":
      return validateDevicesCreateCode;
    case "devices.exchange":
      return validateDevicesExchange;
    case "devices.list":
      return validateDevicesList;
    case "devices.revoke":
      return validateDevicesRevoke;
    case "runs.create":
      return validateRunsCreate;
    case "runs.cancel":
      return validateRunsCancel;
    case "runs.list":
      return validateRunsList;
    case "runs.inspect":
      return validateRunsInspect;
    case "runs.resolve":
      return validateRunsResolve;
    default:
      return null;
  }
}

export type ChannelValidator = (payload: unknown) => unknown;

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
    platform: platformRaw,
    projectId: requireProjectId(payload, "devices.exchange")
  };
}

function validateDevicesList(payload: unknown): DevicesListPayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: devices.list payload must be an object");
  }
  return { projectId: requireProjectId(payload, "devices.list") };
}

function validateDevicesRevoke(payload: unknown): DevicesRevokePayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: devices.revoke payload must be an object");
  }
  return {
    deviceId: requireString(payload, "deviceId"),
    projectId: requireProjectId(payload, "devices.revoke")
  };
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

function validateRunsCancel(payload: unknown): RunsCancelPayload {
  if (!isObject(payload)) {
    throw new Error("validation_failed: runs.cancel payload must be an object");
  }
  return { runId: requireRunId(payload, "runs.cancel") };
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

/**
 * Convenience: re-export Run shapes the Renderer cares about so the
 * preload side can refer to a single import path.
 */
export type RendererRunShape = {
  createResult: CreateRunResult;
  runView: RunView;
  runHistory: RunHistoryResult;
};