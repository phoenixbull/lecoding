/**
 * The narrow Electron surface the desktop main process uses.
 *
 * Production main wires the real Electron module here. Tests inject a fake
 * host that exposes the same minimal API so we can verify the policy
 * (sandbox flags, CSP, IPC handler registration) without spinning up a
 * display server.
 */

import type {
  CreateRunInput,
  CreateRunResult,
  ProjectId,
  RunHistoryResult,
  RunId,
  RunView
} from "@lecoding/contracts";
import type { LeCodingClient } from "@lecoding/client-sdk";
import type { IpcRequest, IpcResponse } from "../shared/ipc-contract.js";

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
  getControlPlaneConfig(): Promise<unknown>;
  createRun(projectId: ProjectId, input: CreateRunInput): Promise<CreateRunResult>;
  cancelRun(runId: RunId): Promise<void>;
  listRuns(projectId: ProjectId, limit?: number): Promise<RunHistoryResult>;
  inspectRun(runId: RunId): Promise<RunView>;
  resolveRunResult(runId: RunId, outcome: "keep" | "discard"): Promise<void>;
  createDeviceCode(projectId: ProjectId): Promise<unknown>;
  exchangeDeviceCode(input: unknown): Promise<unknown>;
  listDevices(projectId: ProjectId): Promise<unknown>;
  revokeDevice(deviceId: string): Promise<void>;
}

/** Factory keeps SDK construction out of main itself; main only orchestrates. */
export type ClientSdkFactory = (config: {
  baseUrl: string;
  authToken?: string;
}) => ClientSdk | Promise<ClientSdk>;

export type LeCodingClientLike = LeCodingClient;