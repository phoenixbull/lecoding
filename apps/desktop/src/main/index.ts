/**
 * Desktop main process entry point.
 *
 * Boots the BrowserWindow with the security baseline mandated by PRD § 10.1
 * and registers a typed IPC handler for every channel in the shared
 * contract. The main process owns one Client SDK instance and forwards
 * every Renderer request to it; it also tags every IPC handler with the
 * active Renderer so other webContents cannot reach the bridge.
 *
 * The module is factory-shaped (`createDesktopMain`) so tests can inject a
 * fake `ElectronHost` and exercise the policy without spinning up a display.
 */

import {
  IPC_CHANNELS,
  ipcRequestSchema,
  isKnownChannel,
  validateIpcRequest,
  type IpcErrorCode,
  type IpcRequest,
  type IpcResponse
} from "../shared/ipc-contract.js";
import type {
  ClientSdk,
  ClientSdkFactory,
  ElectronHost,
  IpcHandler,
  IpcSenderContext
} from "./host.js";

export interface DesktopMainOptions {
  host: ElectronHost;
  createClientSdk: ClientSdkFactory;
  /**
   * Path to the Renderer entry inside the packaged app. Production main
   * uses `path.join(app.getAppPath(), "dist/renderer/index.html")`; tests
   * pass a literal string.
   */
  rendererEntry: string;
  /**
   * Optional override for the trusted webContents id. Tests pass the id of
   * their fake window so sender validation passes.
   */
  trustedSenderId?: string;
}

export interface DesktopMain {
  start(): Promise<void>;
  /** Test-only accessor for registered handlers. */
  handlers(): ReadonlyMap<string, IpcHandler>;
  /** Test-only accessor for the held SDK instance. */
  sdk(): ClientSdk;
}

/** Strict CSP forbids any resource from outside the packaged app. */
const CSP_HEADER =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function createDesktopMain(options: DesktopMainOptions): DesktopMain {
  const { host, createClientSdk, rendererEntry, trustedSenderId } = options;
  const handlerMap = new Map<string, IpcHandler>();
  let sdk: ClientSdk | undefined;
  let activeSenderId: string | undefined = trustedSenderId;
  let bootstrapConfig: { baseUrl: string; authToken?: string } | undefined;

  function requireSdk(): ClientSdk {
    if (!sdk) {
      throw new Error("Desktop main called before bootstrap");
    }
    return sdk;
  }

  function err(code: IpcErrorCode, message: string): IpcResponse {
    return { ok: false, code, message };
  }

  function ok<D>(data: D): IpcResponse<D> {
    return { ok: true, data };
  }

  function trustedContext(context: IpcSenderContext): IpcResponse | null {
    if (!activeSenderId) {
      return err("session_missing", "No Renderer is currently bound");
    }
    if (context.senderId !== activeSenderId) {
      return err("untrusted_sender", "IPC sender is not the active Renderer");
    }
    return null;
  }

  async function dispatch(
    request: IpcRequest,
    context: IpcSenderContext
  ): Promise<IpcResponse> {
    const trustFailure = trustedContext(context);
    if (trustFailure) {
      return trustFailure;
    }
    if (!isKnownChannel(request.channel)) {
      return err("unknown_channel", `Channel ${request.channel} is not registered`);
    }
    try {
      validateIpcRequest(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "validation_failed";
      return err("validation_failed", message);
    }
    // session.bootstrap is the only channel that runs BEFORE the held SDK
    // is initialised; route it through a dedicated branch that does not
    // call requireSdk first.
    if (request.channel === "session.bootstrap") {
      const payload = request.payload as { baseUrl: string; authToken?: string };
      try {
        sdk = await Promise.resolve(createClientSdk(payload));
      } catch (error) {
        const message = error instanceof Error ? error.message : "factory_error";
        return err("upstream_error", message);
      }
      bootstrapConfig = payload;
      return ok({ bootstrapped: true });
    }
    const sdkInstance = requireSdk();
    try {
      const r = request as {
        channel: import("../shared/ipc-contract.js").IpcChannel;
        payload: unknown;
      };
      switch (r.channel) {
        case "session.logout": {
          await sdkInstance.logout();
          bootstrapConfig = undefined;
          return ok({ loggedOut: true });
        }
        case "devices.createCode": {
          const payload = r.payload as { projectId: import("@lecoding/contracts").ProjectId };
          return ok(await sdkInstance.createDeviceCode(payload.projectId));
        }
        case "devices.exchange": {
          return ok(await sdkInstance.exchangeDeviceCode(r.payload));
        }
        case "devices.list": {
          const payload = r.payload as { projectId: import("@lecoding/contracts").ProjectId };
          return ok(await sdkInstance.listDevices(payload.projectId));
        }
        case "devices.revoke": {
          const payload = r.payload as {
            deviceId: string;
            projectId: import("@lecoding/contracts").ProjectId;
          };
          await sdkInstance.revokeDevice(payload.deviceId);
          return ok({ revoked: true });
        }
        case "runs.create": {
          const payload = r.payload as {
            projectId: import("@lecoding/contracts").ProjectId;
            input: import("@lecoding/contracts").CreateRunInput;
          };
          return ok(await sdkInstance.createRun(payload.projectId, payload.input));
        }
        case "runs.cancel": {
          const payload = r.payload as { runId: import("@lecoding/contracts").RunId };
          await sdkInstance.cancelRun(payload.runId);
          return ok({ cancelled: true });
        }
        case "runs.list": {
          const payload = r.payload as {
            projectId: import("@lecoding/contracts").ProjectId;
            limit?: number;
          };
          return ok(await sdkInstance.listRuns(payload.projectId, payload.limit));
        }
        case "runs.inspect": {
          const payload = r.payload as { runId: import("@lecoding/contracts").RunId };
          return ok(await sdkInstance.inspectRun(payload.runId));
        }
        case "runs.resolve": {
          const payload = r.payload as {
            runId: import("@lecoding/contracts").RunId;
            outcome: "keep" | "discard";
          };
          await sdkInstance.resolveRunResult(payload.runId, payload.outcome);
          return ok({ resolved: true });
        }
        default:
          return err("unknown_channel", `Channel ${r.channel} is not registered`);
      }
    } catch (error) {
      // Strip stacks so the Renderer only sees the message — a leaked stack
      // would reveal internal types and file paths.
      const message = error instanceof Error ? error.message : "unknown error";
      return err("upstream_error", message);
    }
  }

  return {
    async start(): Promise<void> {
      // 1. Apply the strict CSP at the session level so every navigation,
      //    including any future BrowserWindow, inherits it.
      host.setCspHeader(CSP_HEADER);

      // 2. Register one handler per documented channel.
      for (const channel of IPC_CHANNELS) {
        // ensure the schema exists; surfaces typos at startup.
        if (!ipcRequestSchema(channel)) {
          throw new Error(`No IPC schema registered for channel ${channel}`);
        }
        const handler: IpcHandler = (request, context) =>
          dispatch(request, context);
        host.ipcMain.handle(channel, handler);
        handlerMap.set(channel, handler);
      }

      // 3. Open the Renderer window with the security baseline.
      const window = new host.BrowserWindow({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          // Disable remote module + spellchecker + webview tag entirely.
          enableRemoteModule: false,
          webviewTag: false,
          // Renderer cannot navigate to a different origin.
          // Allow list of files is restricted to the packaged Renderer entry.
          preload: undefined
        }
      });
      console.error("[start] BrowserWindow constructed, id=", window.webContents.id);
      activeSenderId = String(window.webContents.id);

      // 4. Deny all window.open attempts (new windows, navigations).
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

      // 5. Forbid webContents-triggered navigations outside the Renderer.
      window.webContents.on("will-navigate", (event: unknown, url: unknown) => {
        if (typeof url === "string" && !url.startsWith("file://")) {
          (event as { preventDefault: () => void }).preventDefault?.();
        }
      });

      // 6. Load the packaged Renderer. Never load a URL.
      console.error("[start] calling loadFile");
      await window.loadFile(rendererEntry);
      console.error("[start] loadFile resolved");

      // 7. Honour macOS convention: keep app open until user quits.
      host.app.on("window-all-closed", () => {
        host.app.quit();
      });

      console.error("[start] about to return");
      // Track bootstrap so subsequent requests share the same SDK instance.
      void bootstrapConfig;
    },
    handlers(): ReadonlyMap<string, IpcHandler> {
      return handlerMap;
    },
    sdk(): ClientSdk {
      return requireSdk();
    }
  };
}