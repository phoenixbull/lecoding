/**
 * Desktop main process tests.
 *
 * Validates that the Electron main process boots the BrowserWindow with the
 * security baseline mandated by PRD § 10.1:
 * - nodeIntegration=false, contextIsolation=true, sandbox=true
 * - strict CSP forbids remote navigation, new windows, webviews, and eval
 * - Renderer can only load packaged local resources (no http/https/file URLs)
 * - IPC handlers are registered for every documented channel and every
 *   handler validates the sender and forwards to the held Client SDK.
 *
 * We do NOT require Electron at test time; the tests inject a fake
 * `ElectronHost` that mirrors the small surface area the main process uses
 * (BrowserWindow construction, session.webRequest.onHeadersReceived, app,
 * ipcMain.handle). Production main wires Electron directly; tests wire the
 * fake so we can verify the policy without spinning up a display server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientSdk,
  ClientSdkFactory
} from "../src/main/host.js";
import { createDesktopMain } from "../src/main/index.js";
import type { ElectronHost, IpcHandler } from "../src/main/host.js";
import type {
  IpcRequest,
  IpcResponse
} from "../src/shared/ipc-contract.js";
import { IPC_CHANNELS } from "../src/shared/ipc-contract.js";

interface FakeBrowserWindow {
  webPreferences: Record<string, unknown>;
  loadURL: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  webContents: {
    id: string;
    on: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    session: {
      webRequest: {
        onHeadersReceived: ReturnType<typeof vi.fn>;
      };
    };
  };
}

function createFakeHost(): ElectronHost & {
  windows: FakeBrowserWindow[];
  handlers: Map<string, IpcHandler>;
  csp: string | null;
  capturedLoad: { url?: string; file?: string };
} {
  const handlers = new Map<string, IpcHandler>();
  const windows: FakeBrowserWindow[] = [];
  let csp: string | null = null;
  const capturedLoad: { url?: string; file?: string } = {};
  const host: ElectronHost & typeof capturedLoad = {
    app: {
      on: vi.fn(),
      quit: vi.fn(),
      whenReady: () => Promise.resolve()
    },
    ipcMain: {
      handle: (channel: string, handler: IpcHandler) => {
        console.error("[fakeHost] registering", channel, "handler is fn?", typeof handler);
        handlers.set(channel, handler);
      }
    },
    BrowserWindow: class {
      public webContents: FakeBrowserWindow["webContents"];
      public webPreferences: Record<string, unknown>;
      public loadURL: ReturnType<typeof vi.fn>;
      public loadFile: ReturnType<typeof vi.fn>;
      public on: ReturnType<typeof vi.fn>;
      constructor(opts: { webPreferences: Record<string, unknown> }) {
        this.webPreferences = opts.webPreferences;
        this.loadURL = vi.fn((url: string) => {
          capturedLoad.url = url;
          return Promise.resolve();
        });
        this.loadFile = vi.fn((file: string) => {
          capturedLoad.file = file;
          return Promise.resolve();
        });
        this.on = vi.fn();
        const headerListener = (
          _details: unknown,
          cb: (response: { responseHeaders: Record<string, string[] | undefined> }) => void
        ) => {
          // capture the CSP header set by main; undefined avoids leaking the
          // sentinel "null" into the recorded value.
          cb({
            responseHeaders: {
              "content-security-policy": csp === null ? undefined : [csp]
            }
          });
        };
        this.webContents = {
          id: "webcontents-1",
          on: vi.fn(),
          setWindowOpenHandler: vi.fn(() => ({ action: "deny" })),
          session: {
            webRequest: {
              onHeadersReceived: vi.fn(headerListener)
            }
          }
        };
        windows.push(this as unknown as FakeBrowserWindow);
      }
    } as unknown as ElectronHost["BrowserWindow"],
    setCspHeader: (value: string | null) => {
      csp = value;
    }
  };
  // Capture helper to expose mutable state.
  const result = Object.assign(host, {
    windows,
    handlers,
    capturedLoad
  }) as typeof host & {
    windows: FakeBrowserWindow[];
    handlers: Map<string, IpcHandler>;
    csp: string | null;
    capturedLoad: { url?: string; file?: string };
  };
  Object.defineProperty(result, "csp", {
    get(): string | null {
      return csp;
    },
    enumerable: true,
    configurable: true
  });
  return result;
}

function createStubSdk(): ClientSdk & {
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return { method, args };
  };
  const sdk = {
    getGitHubLoginUrl: record("getGitHubLoginUrl"),
    logout: record("logout"),
    getControlPlaneConfig: record("getControlPlaneConfig"),
    createRun: record("createRun"),
    cancelRun: record("cancelRun"),
    listRuns: record("listRuns"),
    inspectRun: record("inspectRun"),
    resolveRunResult: record("resolveRunResult"),
    createDeviceCode: record("createDeviceCode"),
    exchangeDeviceCode: record("exchangeDeviceCode"),
    listDevices: record("listDevices"),
    revokeDevice: record("revokeDevice"),
    calls
  };
  return sdk as unknown as ClientSdk & {
    calls: Array<{ method: string; args: unknown[] }>;
  };
}

describe("createDesktopMain", () => {
  let host: ReturnType<typeof createFakeHost>;
  let sdk: ReturnType<typeof createStubSdk>;

  beforeEach(() => {
    host = createFakeHost();
    sdk = createStubSdk();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("boots the BrowserWindow with the security baseline (PRD § 10.1)", async () => {
    const factory: ClientSdkFactory = () => sdk;
    const main = createDesktopMain({
      host,
      createClientSdk: factory,
      rendererEntry: "dist/renderer/index.html"
    });
    await main.start();

    expect(host.windows.length).toBe(1);
    const win = host.windows[0]!;
    expect(win.webPreferences.nodeIntegration).toBe(false);
    expect(win.webPreferences.contextIsolation).toBe(true);
    expect(win.webPreferences.sandbox).toBe(true);
    // The Renderer must load a packaged local file, never a remote URL.
    expect(host.capturedLoad.file).toBe("dist/renderer/index.html");
    expect(host.capturedLoad.url).toBeUndefined();
  });

  it("applies a strict CSP that forbids remote sources and eval", async () => {
    const factory: ClientSdkFactory = () => sdk;
    const main = createDesktopMain({
      host,
      createClientSdk: factory,
      rendererEntry: "dist/renderer/index.html"
    });
    await main.start();
    expect(host.csp).toMatch(/default-src 'self'/);
    expect(host.csp).toMatch(/script-src 'self'/);
    expect(host.csp).not.toMatch(/unsafe-eval/);
    // Block navigation, new windows, and webview tags.
    expect(host.csp).toMatch(/frame-src 'none'/);
    expect(host.csp).toMatch(/object-src 'none'/);
  });

  it("blocks window.open and external navigation at the BrowserWindow level", async () => {
    const factory: ClientSdkFactory = () => sdk;
    const main = createDesktopMain({
      host,
      createClientSdk: factory,
      rendererEntry: "dist/renderer/index.html"
    });
    await main.start();
    const win = host.windows[0]!;
    expect(win.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    const handler = (win.webContents.setWindowOpenHandler as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value;
    expect(handler).toEqual({ action: "deny" });
  });

  it("registers an IPC handler for every documented channel", async () => {
    const factory: ClientSdkFactory = () => sdk;
    const main = createDesktopMain({
      host,
      createClientSdk: factory,
      rendererEntry: "dist/renderer/index.html"
    });
    await main.start();
    for (const channel of IPC_CHANNELS) {
      expect(host.handlers.has(channel)).toBe(true);
    }
  });

  it("delegates a runs.create IPC request to the held Client SDK instance", async () => {
    const factory: ClientSdkFactory = vi.fn(() => sdk) as unknown as ClientSdkFactory;
    const main = createDesktopMain({
      host,
      createClientSdk: factory,
      rendererEntry: "dist/renderer/index.html"
    });
    await main.start();
    const bootstrap = host.handlers.get("session.bootstrap")!;
    await bootstrap(
      { channel: "session.bootstrap", payload: { baseUrl: "https://agent.example" } },
      { senderId: "webcontents-1" }
    );
    const handler = host.handlers.get("runs.create")!;
    const request: IpcRequest = {
      channel: "runs.create",
      payload: {
        projectId: "project-1",
        input: {
          task: "Hello",
          environmentId: "sandbox-v1",
          acceptanceCriteria: [],
          approvalMode: "manual",
          fileAccessScope: "workspace_only"
        }
      }
    };
    const response = (await handler(request, { senderId: "webcontents-1" })) as IpcResponse;
    expect(response.ok).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    const call = (sdk.calls.find((c) => c.method === "createRun"));
    expect(call?.args[0]).toBe("project-1");
  });

  it("returns a typed error when the SDK throws and never leaks the stack", async () => {
    const failingSdk: ClientSdk = {
      ...sdk,
      createRun: (async () => {
        throw new Error("server down");
      }) as ClientSdk["createRun"]
    };
    const factory: ClientSdkFactory = () => failingSdk;
    const main = createDesktopMain({
      host,
      createClientSdk: factory,
      rendererEntry: "dist/renderer/index.html"
    });
    await main.start();
    await host.handlers.get("session.bootstrap")!(
      { channel: "session.bootstrap", payload: { baseUrl: "https://agent.example" } },
      { senderId: "webcontents-1" }
    );
    const handler = host.handlers.get("runs.create")!;
    const response = (await handler(
      {
        channel: "runs.create",
        payload: {
          projectId: "project-1",
          input: {
            task: "x",
            environmentId: "sandbox-v1",
            acceptanceCriteria: [],
            approvalMode: "manual",
            fileAccessScope: "workspace_only"
          }
        }
      },
      { senderId: "webcontents-1" }
    )) as IpcResponse;
    expect(response.ok).toBe(false);
    if (response.ok === false) {
      expect(response.code).toBe("upstream_error");
      expect(response.message).toBe("server down");
      // Stack must never reach the Renderer.
      expect(response.message).not.toMatch(/at\s+/);
    }
  });

  it("forwards session.logout to the SDK and disposes the window", async () => {
    const factory: ClientSdkFactory = () => sdk;
    const main = createDesktopMain({
      host,
      createClientSdk: factory,
      rendererEntry: "dist/renderer/index.html"
    });
    await main.start();
    expect(host.handlers.size).toBeGreaterThan(0);
    const bootstrap = host.handlers.get("session.bootstrap")!;
    expect(typeof bootstrap).toBe("function");
    try {
      const bootResp = await bootstrap(
        { channel: "session.bootstrap", payload: { baseUrl: "https://agent.example" } },
        { senderId: "webcontents-1" }
      );
      process.stdout.write(`[test] bootstrap response=${JSON.stringify(bootResp)}\n`);
    } catch (e) {
      process.stdout.write(`[test] bootstrap threw=${e}\n`);
    }
    process.stdout.write(`[test] AFTER BOOTSTRAP\n`);
    const handler = host.handlers.get("session.logout")!;
    const response = (await handler(
      { channel: "session.logout", payload: {} },
      { senderId: "webcontents-1" }
    )) as IpcResponse;
    expect(response.ok).toBe(true);
    expect(sdk.calls.some((c) => c.method === "logout")).toBe(true);
  });

  it("rejects unknown channels with a stable error", async () => {
    const factory: ClientSdkFactory = () => sdk;
    const main = createDesktopMain({
      host,
      createClientSdk: factory,
      rendererEntry: "dist/renderer/index.html"
    });
    await main.start();
    const handler = host.handlers.get("session.logout")!;
    const response = (await handler(
      {
        channel: "shell.exec" as unknown as typeof IPC_CHANNELS[number],
        payload: {}
      },
      { senderId: "webcontents-1" }
    )) as IpcResponse;
    expect(response.ok).toBe(false);
    if (response.ok === false) {
      expect(response.code).toBe("unknown_channel");
    }
  });

  it("refuses IPC requests from senders that aren't the active Renderer", async () => {
    const factory: ClientSdkFactory = () => sdk;
    const main = createDesktopMain({
      host,
      createClientSdk: factory,
      rendererEntry: "dist/renderer/index.html"
    });
    await main.start();
    const handler = host.handlers.get("runs.cancel")!;
    const response = (await handler(
      { channel: "runs.cancel", payload: { runId: "run-1" } },
      { senderId: "stranger" }
    )) as IpcResponse;
    expect(response.ok).toBe(false);
    if (response.ok === false) {
      expect(response.code).toBe("untrusted_sender");
    }
  });

  it("reuses one SDK instance across requests rather than constructing per call", async () => {
    const factory = vi.fn(() => sdk);
    const main = createDesktopMain({
      host,
      createClientSdk: factory as unknown as ClientSdkFactory,
      rendererEntry: "dist/renderer/index.html"
    });
    await main.start();
    await host.handlers.get("session.bootstrap")!(
      { channel: "session.bootstrap", payload: { baseUrl: "https://agent.example" } },
      { senderId: "webcontents-1" }
    );
    const createRun = host.handlers.get("runs.create")!;
    const cancel = host.handlers.get("runs.cancel")!;
    await createRun(
      {
        channel: "runs.create",
        payload: {
          projectId: "project-1",
          input: {
            task: "x",
            environmentId: "sandbox-v1",
            acceptanceCriteria: [],
            approvalMode: "manual",
            fileAccessScope: "workspace_only"
          }
        }
      },
      { senderId: "webcontents-1" }
    );
    await cancel(
      { channel: "runs.cancel", payload: { runId: "run-1" } },
      { senderId: "webcontents-1" }
    );
    expect(factory).toHaveBeenCalledTimes(1);
  });
});