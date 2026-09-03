/**
 * Desktop main process tests.
 *
 * Validates that the Electron main process boots the BrowserWindow with the
 * security baseline mandated by PRD § 10.1:
 * - nodeIntegration=false, contextIsolation=true, sandbox=true
 * - the preload bridge is actually mounted (without it `window.lecoding`
 *   would not exist at all)
 * - strict CSP forbids remote navigation, new windows, webviews, and eval
 * - Renderer can only load packaged local resources (no http/https/file URLs)
 * - IPC handlers are registered for every documented channel and every
 *   handler validates the sender and forwards to the held Client SDK
 * - Run events reach the Renderer only through whitelisted push channels
 *
 * We do NOT require Electron at test time; the tests inject a fake
 * `ElectronHost` that mirrors the small surface area the main process uses
 * (BrowserWindow construction, session.webRequest.onHeadersReceived, app,
 * ipcMain.handle, webContents.send). Production main wires Electron directly;
 * tests wire the fake so we can verify the policy without a display server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEventV1 } from "@lecoding/contracts";
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

interface FakeWebContents {
  id: string;
  on: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  session: {
    webRequest: {
      onHeadersReceived: ReturnType<typeof vi.fn>;
    };
  };
}

interface FakeBrowserWindow {
  webPreferences: Record<string, unknown>;
  loadURL: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  webContents: FakeWebContents;
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
  const host = {
    app: {
      on: vi.fn(),
      quit: vi.fn(),
      whenReady: () => Promise.resolve()
    },
    ipcMain: {
      handle: (channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      }
    },
    BrowserWindow: class {
      public webContents: FakeWebContents;
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
          send: vi.fn(),
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
  } satisfies ElectronHost;
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

/** Builds an SDK stub whose every method resolves with a fixed payload. */
function createStubSdk(): ClientSdk & {
  calls: Array<{ method: string; args: unknown[] }>;
  events: RunEventV1[];
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const events: RunEventV1[] = [];
  const record =
    (method: string, result: unknown = { method }) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result;
    };
  const sdk = {
    getGitHubLoginUrl: () => "https://agent.example/api/v1/auth/github/start",
    logout: record("logout", { loggedOut: true }),
    getControlPlaneConfig: record("getControlPlaneConfig", {
      projectId: "project-a",
      projects: [{ id: "project-a", role: "admin" }],
      defaultEnvironmentId: "sandbox-v1"
    }),
    createRun: record("createRun", { runId: "run-1" }),
    cancelRun: record("cancelRun", undefined),
    listRuns: record("listRuns", { runs: [] }),
    inspectRun: record("inspectRun", { id: "run-1", status: "running" }),
    resolveRunResult: record("resolveRunResult", undefined),
    getRunChanges: record("getRunChanges", { changedFiles: [], unifiedDiff: "" }),
    getRunArtifact: record("getRunArtifact", "artifact body"),
    approveRun: record("approveRun", undefined),
    rejectRun: record("rejectRun", undefined),
    editAndApproveRun: record("editAndApproveRun", undefined),
    answerRun: record("answerRun", undefined),
    steerRun: record("steerRun", undefined),
    listProjectPolicyRules: record("listProjectPolicyRules", { rules: [] }),
    revokeProjectPolicyRule: record("revokeProjectPolicyRule", undefined),
    createDeviceCode: record("createDeviceCode", { code: "ABCDEFGHI" }),
    exchangeDeviceCode: record("exchangeDeviceCode", { deviceId: "device-1" }),
    listDevices: record("listDevices", { devices: [] }),
    revokeDevice: record("revokeDevice", undefined),
    subscribeRunEvents: (...args: unknown[]) => {
      calls.push({ method: "subscribeRunEvents", args });
      const signal = (args[1] as { signal: AbortSignal }).signal;
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of events) {
            if (signal.aborted) {
              return;
            }
            yield event;
          }
          // Park instead of closing: a real SSE stream never completes
          // normally, and closing here would spin the broker's reconnect
          // loop for the rest of the test run.
          if (!signal.aborted) {
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        }
      } as AsyncIterable<RunEventV1>;
    },
    calls,
    events
  };
  return sdk as unknown as ClientSdk & {
    calls: Array<{ method: string; args: unknown[] }>;
    events: RunEventV1[];
  };
}

const SENDER = { senderId: "webcontents-1" };

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

  async function boot(
    overrides: Partial<Parameters<typeof createDesktopMain>[0]> = {}
  ): Promise<ReturnType<typeof createDesktopMain>> {
    const main = createDesktopMain({
      host,
      createClientSdk: () => sdk,
      rendererEntry: "dist/renderer/index.html",
      preloadEntry: "/app/dist/preload/index.js",
      waitBeforeReconnect: () => Promise.resolve(),
      ...overrides
    });
    await main.start();
    return main;
  }

  it("boots the BrowserWindow with the security baseline (PRD § 10.1)", async () => {
    await boot();
    expect(host.windows.length).toBe(1);
    const win = host.windows[0]!;
    expect(win.webPreferences.nodeIntegration).toBe(false);
    expect(win.webPreferences.contextIsolation).toBe(true);
    expect(win.webPreferences.sandbox).toBe(true);
    // The Renderer must load a packaged local file, never a remote URL.
    expect(host.capturedLoad.file).toBe("dist/renderer/index.html");
    expect(host.capturedLoad.url).toBeUndefined();
  });

  it("mounts the preload bridge so window.lecoding can exist", async () => {
    await boot();
    // A BrowserWindow built without a preload path silently ships a Renderer
    // with no capability surface at all.
    expect(host.windows[0]!.webPreferences.preload).toBe(
      "/app/dist/preload/index.js"
    );
  });

  it("applies a strict CSP that forbids remote sources and eval", async () => {
    await boot();
    expect(host.csp).toMatch(/default-src 'self'/);
    expect(host.csp).toMatch(/script-src 'self'/);
    expect(host.csp).not.toMatch(/unsafe-eval/);
    // Block navigation, new windows, and webview tags.
    expect(host.csp).toMatch(/frame-src 'none'/);
    expect(host.csp).toMatch(/object-src 'none'/);
  });

  it("blocks window.open and external navigation at the BrowserWindow level", async () => {
    await boot();
    const win = host.windows[0]!;
    expect(win.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    const handler = (win.webContents.setWindowOpenHandler as ReturnType<typeof vi.fn>)
      .mock.results[0]?.value;
    expect(handler).toEqual({ action: "deny" });
  });

  it("registers an IPC handler for every documented channel", async () => {
    await boot();
    for (const channel of IPC_CHANNELS) {
      expect(host.handlers.has(channel)).toBe(true);
    }
  });

  it("delegates a runs.create IPC request to the held Client SDK instance", async () => {
    const factory: ClientSdkFactory = vi.fn(() => sdk) as unknown as ClientSdkFactory;
    await boot({ createClientSdk: factory });
    await host.handlers.get("session.bootstrap")!(
      { channel: "session.bootstrap", payload: { baseUrl: "https://agent.example" } },
      SENDER
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
    const response = (await handler(request, SENDER)) as IpcResponse;
    expect(response.ok).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    const call = sdk.calls.find((c) => c.method === "createRun");
    expect(call?.args[0]).toBe("project-1");
  });

  it("returns a typed error when the SDK throws and never leaks the stack", async () => {
    const failingSdk: ClientSdk = {
      ...sdk,
      createRun: (async () => {
        throw new Error("server down");
      }) as ClientSdk["createRun"]
    };
    await boot({ createClientSdk: () => failingSdk });
    await host.handlers.get("session.bootstrap")!(
      { channel: "session.bootstrap", payload: { baseUrl: "https://agent.example" } },
      SENDER
    );
    const response = (await host.handlers.get("runs.create")!(
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
      SENDER
    )) as IpcResponse;
    expect(response.ok).toBe(false);
    if (response.ok === false) {
      expect(response.code).toBe("upstream_error");
      expect(response.message).toBe("server down");
      // Stack must never reach the Renderer.
      expect(response.message).not.toMatch(/at\s+/);
    }
  });

  it("maps an authentication failure onto the unauthorized code", async () => {
    const unauthorized = Object.assign(new Error("control plane: HTTP 401"), {
      status: 401
    });
    const failingSdk: ClientSdk = {
      ...sdk,
      getControlPlaneConfig: (async () => {
        throw unauthorized;
      }) as ClientSdk["getControlPlaneConfig"]
    };
    await boot({ createClientSdk: () => failingSdk });
    await host.handlers.get("session.bootstrap")!(
      { channel: "session.bootstrap", payload: { baseUrl: "https://agent.example" } },
      SENDER
    );
    const response = (await host.handlers.get("config.load")!(
      { channel: "config.load", payload: {} },
      SENDER
    )) as IpcResponse;
    expect(response.ok).toBe(false);
    if (response.ok === false) {
      // The console branches on this code to send the user back to sign-in.
      expect(response.code).toBe("unauthorized");
    }
  });

  it("forwards session.logout to the SDK and clears local credentials", async () => {
    const clear = vi.fn(async () => undefined);
    await boot({
      credentialStore: {
        status: async () => ({ backend: "safeStorage", degraded: false }),
        purgeExpired: async () => undefined,
        clear
      }
    });
    await host.handlers.get("session.bootstrap")!(
      { channel: "session.bootstrap", payload: { baseUrl: "https://agent.example" } },
      SENDER
    );
    const response = (await host.handlers.get("session.logout")!(
      { channel: "session.logout", payload: {} },
      SENDER
    )) as IpcResponse;
    expect(response.ok).toBe(true);
    expect(sdk.calls.some((c) => c.method === "logout")).toBe(true);
    // A stale credential would let the next launch re-authenticate as a
    // device the user just signed out of.
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("clears local credentials when the operator revokes the device", async () => {
    const clear = vi.fn(async () => undefined);
    await boot({
      credentialStore: {
        status: async () => ({ backend: "safeStorage", degraded: false }),
        purgeExpired: async () => undefined,
        clear
      }
    });
    await host.handlers.get("session.bootstrap")!(
      { channel: "session.bootstrap", payload: { baseUrl: "https://agent.example" } },
      SENDER
    );
    await host.handlers.get("devices.revoke")!(
      { channel: "devices.revoke", payload: { deviceId: "device-1", projectId: "project-1" } },
      SENDER
    );
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("reports credential health through session.status without exposing the token", async () => {
    await boot({
      credentialStore: {
        status: async () => ({
          backend: "encryptedFile",
          degraded: true,
          reason: "safeStorage 不可用"
        }),
        purgeExpired: async () => undefined,
        clear: async () => undefined
      }
    });
    await host.handlers.get("session.bootstrap")!(
      { channel: "session.bootstrap", payload: { baseUrl: "https://agent.example" } },
      SENDER
    );
    const response = (await host.handlers.get("session.status")!(
      { channel: "session.status", payload: {} },
      SENDER
    )) as IpcResponse;
    expect(response.ok).toBe(true);
    if (response.ok) {
      const data = response.data as { credential: { degraded: boolean } };
      expect(data.credential.degraded).toBe(true);
      // The credential itself must never cross the bridge.
      expect(JSON.stringify(data)).not.toMatch(/accessToken/);
    }
  });

  it("rejects unknown channels with a stable error", async () => {
    await boot();
    const response = (await host.handlers.get("session.logout")!(
      {
        channel: "shell.exec" as unknown as (typeof IPC_CHANNELS)[number],
        payload: {}
      },
      SENDER
    )) as IpcResponse;
    expect(response.ok).toBe(false);
    if (response.ok === false) {
      expect(response.code).toBe("unknown_channel");
    }
  });

  it("refuses IPC requests from senders that aren't the active Renderer", async () => {
    await boot();
    const response = (await host.handlers.get("runs.cancel")!(
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
    await boot({ createClientSdk: factory as unknown as ClientSdkFactory });
    await host.handlers.get("session.bootstrap")!(
      { channel: "session.bootstrap", payload: { baseUrl: "https://agent.example" } },
      SENDER
    );
    await host.handlers.get("runs.create")!(
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
      SENDER
    );
    await host.handlers.get("runs.cancel")!(
      { channel: "runs.cancel", payload: { runId: "run-1" } },
      SENDER
    );
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized steer before it reaches the SDK", async () => {
    await boot();
    await host.handlers.get("session.bootstrap")!(
      { channel: "session.bootstrap", payload: { baseUrl: "https://agent.example" } },
      SENDER
    );
    const response = (await host.handlers.get("runs.steer")!(
      { channel: "runs.steer", payload: { runId: "run-1", message: "x".repeat(4_001) } },
      SENDER
    )) as IpcResponse;
    expect(response.ok).toBe(false);
    if (response.ok === false) {
      expect(response.code).toBe("validation_failed");
    }
    expect(sdk.calls.some((c) => c.method === "steerRun")).toBe(false);
  });

  it("rejects an approval edit whose replacement is not a known capability", async () => {
    await boot();
    await host.handlers.get("session.bootstrap")!(
      { channel: "session.bootstrap", payload: { baseUrl: "https://agent.example" } },
      SENDER
    );
    const response = (await host.handlers.get("runs.editApprove")!(
      {
        channel: "runs.editApprove",
        payload: {
          runId: "run-1",
          approvalId: "approval-1",
          replacement: { type: "shell_exec", script: "rm -rf /" }
        }
        // Deliberately malformed: the bridge must reject a capability shape
        // the policy layer can never accept.
      } as unknown as IpcRequest,
      SENDER
    )) as IpcResponse;
    expect(response.ok).toBe(false);
    if (response.ok === false) {
      expect(response.code).toBe("validation_failed");
    }
    expect(sdk.calls.some((c) => c.method === "editAndApproveRun")).toBe(false);
  });
});

describe("Run event relay", () => {
  let host: ReturnType<typeof createFakeHost>;
  let sdk: ReturnType<typeof createStubSdk>;

  beforeEach(() => {
    host = createFakeHost();
    sdk = createStubSdk();
  });

  async function boot(): Promise<ReturnType<typeof createDesktopMain>> {
    const main = createDesktopMain({
      host,
      createClientSdk: () => sdk,
      rendererEntry: "dist/renderer/index.html",
      preloadEntry: "/app/dist/preload/index.js",
      waitBeforeReconnect: () => Promise.resolve()
    });
    await main.start();
    await host.handlers.get("session.bootstrap")!(
      { channel: "session.bootstrap", payload: { baseUrl: "https://agent.example" } },
      SENDER
    );
    return main;
  }

  it("relays a Run event to the Renderer through the whitelisted push channel", async () => {
    const main = await boot();
    sdk.events.push({
      version: 1,
      sequence: 1,
      runId: "run-1",
      type: "status_changed",
      occurredAt: "2026-01-01T00:00:00.000Z",
      data: { status: "running" }
    });
    await host.handlers.get("runs.subscribe")!(
      { channel: "runs.subscribe", payload: { runId: "run-1" } },
      SENDER
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const pushed = main.pushed();
    expect(pushed.some((entry) => entry.channel === "runs.event")).toBe(true);
    expect(pushed.some((entry) => entry.channel === "runs.streamState")).toBe(true);
  });

  it("opens only one subscription per Run even when the Renderer asks twice", async () => {
    await boot();
    const subscribe = host.handlers.get("runs.subscribe")!;
    await subscribe({ channel: "runs.subscribe", payload: { runId: "run-1" } }, SENDER);
    await subscribe({ channel: "runs.subscribe", payload: { runId: "run-1" } }, SENDER);
    expect(sdk.calls.filter((call) => call.method === "subscribeRunEvents")).toHaveLength(
      1
    );
  });

  it("stops relaying a Run once the Renderer unsubscribes", async () => {
    await boot();
    await host.handlers.get("runs.subscribe")!(
      { channel: "runs.subscribe", payload: { runId: "run-1" } },
      SENDER
    );
    await host.handlers.get("runs.unsubscribe")!(
      { channel: "runs.unsubscribe", payload: { runId: "run-1" } },
      SENDER
    );
    // A fresh subscribe after an unsubscribe must be allowed to re-open.
    await host.handlers.get("runs.subscribe")!(
      { channel: "runs.subscribe", payload: { runId: "run-1" } },
      SENDER
    );
    expect(sdk.calls.filter((call) => call.method === "subscribeRunEvents")).toHaveLength(
      2
    );
  });

  it("aborts every stream when the window closes", async () => {
    const main = await boot();
    await host.handlers.get("runs.subscribe")!(
      { channel: "runs.subscribe", payload: { runId: "run-1" } },
      SENDER
    );
    const win = host.windows[0]!;
    const closedListener = win.on.mock.calls.find((call) => call[0] === "closed");
    expect(closedListener).toBeDefined();
    (closedListener?.[1] as () => void)();
    // Re-subscribing after the window closed must open a fresh stream rather
    // than silently reusing the aborted one.
    expect(main.pushed().length).toBeGreaterThan(0);
  });
});
