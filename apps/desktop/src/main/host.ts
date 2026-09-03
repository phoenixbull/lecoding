/**
 * The narrow Electron surface the desktop main process uses.
 *
 * Production main wires the real Electron module here. Tests inject a fake
 * host that exposes the same minimal API so we can verify the policy
 * (sandbox flags, CSP, IPC handler registration) without spinning up a
 * display server.
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
import type { LeCodingClient } from "@lecoding/client-sdk";
import type {
  DeviceCodeResult,
  DeviceExchangeInput,
  DeviceListing
} from "@lecoding/run-controller";
import type {
  CredentialStatePush,
  IpcRequest,
  IpcResponse,
  PushChannel,
  RunEventPush,
  StreamStatePush
} from "../shared/ipc-contract.js";

export interface ElectronApp {
  on(event: "window-all-closed", listener: () => void): void;
  on(event: "before-quit", listener: () => void): void;
  on(event: "ready", listener: () => void): void;
  quit(): void;
  whenReady(): Promise<void>;
}

export interface ElectronIpcMain {
  handle(channel: string, handler: IpcHandler): void;
}

export interface ElectronWebContentsLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: "allow" | "deny" }
  ): void;
  /**
   * Pushes a main-process notification to this Renderer.
   *
   * This is the only direction the Renderer can receive Run events: its CSP
   * forbids outbound connections and it never holds the device credential, so
   * the main process must relay the durable SSE stream.
   */
  send(channel: PushChannel, payload: RunEventPush | StreamStatePush | unknown): void;
  session: {
    webRequest: {
      onHeadersReceived(
        listener: (
          details: unknown,
          callback: (response: { responseHeaders: Record<string, string[] | undefined> }) => void
        ) => void
      ): void;
    };
  };
  id: number;
}

export interface ElectronBrowserWindowCtor {
  new (options: {
    webPreferences: Record<string, unknown>;
  }): ElectronBrowserWindowInstance;
}

export interface ElectronBrowserWindowInstance {
  webContents: ElectronWebContentsLike;
  webPreferences: Record<string, unknown>;
  loadURL(url: string): Promise<void>;
  loadFile(path: string): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export interface IpcSenderContext {
  senderId: string;
}

/**
 * Main-process handler shape: receives a typed IPC request plus a sender
 * context (webContents id) so the policy can reject untrusted callers.
 */
export type IpcHandler = (
  request: IpcRequest,
  context: IpcSenderContext
) => Promise<IpcResponse>;

export interface ElectronHost {
  app: ElectronApp;
  ipcMain: ElectronIpcMain;
  BrowserWindow: ElectronBrowserWindowCtor;
  /**
   * Inject the current CSP into a per-window session. Production wires
   * `session.defaultSession.webRequest.onHeadersReceived`; tests substitute
   * an in-memory recorder.
   */
  setCspHeader(value: string | null): void;
}

/**
 * The subset of the client SDK the desktop main process depends on.
 * We re-declare the surface so tests can stub it without importing the
 * real SDK (which transitively pulls node-only modules).
 */
export interface ClientSdk {
  getGitHubLoginUrl(): string;
  logout(): Promise<void>;
  getControlPlaneConfig(): Promise<ControlPlaneConfig>;
  createRun(projectId: ProjectId, input: CreateRunInput): Promise<CreateRunResult>;
  cancelRun(runId: RunId): Promise<void>;
  listRuns(projectId: ProjectId, limit?: number): Promise<RunHistoryResult>;
  inspectRun(runId: RunId): Promise<RunView>;
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
  createDeviceCode(projectId: ProjectId): Promise<DeviceCodeResult>;
  exchangeDeviceCode(input: DeviceExchangeInput): Promise<unknown>;
  /** Scoped by the server to the authenticated device; no project needed. */
  listDevices(): Promise<DeviceListing>;
  revokeDevice(deviceId: string): Promise<void>;
  /**
   * Opens the durable Run event stream. The broker owns retry and cursor
   * bookkeeping; the SDK only supplies one subscription attempt.
   */
  subscribeRunEvents(
    runId: RunId,
    options: { lastEventId?: string; signal: AbortSignal }
  ): AsyncIterable<RunEventV1>;
}

/** Factory keeps SDK construction out of main itself; main only orchestrates. */
export type ClientSdkFactory = (config: {
  baseUrl: string;
  authToken?: string;
}) => ClientSdk | Promise<ClientSdk>;

/**
 * Credential-storage handle owned by the main process.
 *
 * The Renderer never receives the credential itself — only the health of the
 * backend holding it — so a degraded fallback stays visible to the user
 * without putting a device token anywhere near Renderer memory.
 */
export interface CredentialStoreHandle {
  /** Current backend health, or undefined when no store is wired yet. */
  status(): Promise<CredentialStatePush | undefined>;
  /** Drops every persisted credential; used on logout and device revocation. */
  clear(): Promise<void>;
  /** Drops a credential that passed its expiry. Idempotent. */
  purgeExpired(now?: Date): Promise<void>;
}

export type LeCodingClientLike = LeCodingClient;

export type {
  DeviceCodeResult,
  DeviceExchangeInput,
  DeviceListing,
  DeviceSummary
} from "@lecoding/run-controller";