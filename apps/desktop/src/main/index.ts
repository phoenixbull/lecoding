/**
 * Desktop main process entry point.
 *
 * Boots the BrowserWindow with the security baseline mandated by PRD § 10.1
 * and registers a typed IPC handler for every channel in the shared
 * contract. The main process owns one Client SDK instance and forwards
 * every Renderer request to it; it also tags every IPC handler with the
 * active Renderer so other webContents cannot reach the bridge.
 *
 * The main process is the only side that ever holds a credential. It also owns
 * the durable Run event stream on the Renderer's behalf: the Renderer's CSP
 * forbids outbound traffic, so `RunStreamBroker` relays events through the
 * whitelisted `runs.event` push channel.
 *
 * The module is factory-shaped (`createDesktopMain`) so tests can inject a
 * fake `ElectronHost` and exercise the policy without spinning up a display.
 */

import {
  IPC_CHANNELS,
  ipcRequestSchema,
  isKnownChannel,
  validateIpcRequest,
  type CredentialStatePush,
  type IpcErrorCode,
  type IpcRequest,
  type IpcResponse,
  type PushChannel,
  type RunnerStatePush
} from "../shared/ipc-contract.js";
import type { SandboxCapabilityReport } from "@lecoding/host-sandbox";
import type {
  ClientSdk,
  ClientSdkFactory,
  CredentialStoreHandle,
  DangerConfirmationInput,
  DeviceExchangeInput,
  ElectronBrowserWindowInstance,
  ElectronHost,
  IpcHandler,
  IpcSenderContext
} from "./host.js";
import type { RunnerBrokerState } from "./runner-broker.js";
import { createRunStreamBroker, type RunStreamBroker } from "./stream-broker.js";

/**
 * Last path segment, for display across the IPC boundary.
 *
 * Deliberately lossy: the Renderer gets a folder name it can show the user,
 * never the absolute location. Handles both separators because the same
 * Renderer bundle runs on Windows and macOS.
 */
function basenameOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

/**
 * Channels the dispatch switch handles.
 *
 * `session.bootstrap` is excluded on purpose: it must run *before* the SDK
 * exists, so it is handled in its own branch above and can never reach here.
 * Naming that exclusion is what lets the switch's `default` be a `never`
 * check — without it the compiler would consider bootstrap unhandled forever.
 */
type DispatchChannel = Exclude<IpcChannel, "session.bootstrap">;

/** Wording for the `host_full` OS confirmation; shared by IPC and the grant service. */
const HOST_FULL_CONFIRMATION: DangerConfirmationInput = {
  title: "Allow this Run to access your whole computer?",
  message: "This Run is requesting full host file access.",
  detail:
    "Commands in this Run may read, modify or delete any file your account can " +
    "reach, including files outside this project. The local sandbox will not " +
    "restrict them.",
  acknowledgementLabel: "I understand this Run can modify files outside this project"
};

/** Isolation a server Docker sandbox provides that a local host cannot. */
const DOCKER_ISOLATION_GAPS = [
  "No CPU limit: a Run can use all cores on this machine.",
  "No memory limit: a Run can exhaust system memory.",
  "No process count limit: a Run can spawn unbounded processes."
];

/**
 * Derives the isolation gaps from what the sandbox actually enforces.
 *
 * Only a kernel-level tier approaches container isolation, so anything weaker
 * is reported as a gap rather than hidden behind a generic warning.
 */
function isolationGaps(report: SandboxCapabilityReport): string[] {
  const kernelEnforced = Object.values(report.tiers).every(
    (level) => level === "kernel" || level === "acknowledged_unrestricted"
  );
  const gaps = [...DOCKER_ISOLATION_GAPS];
  if (!kernelEnforced) {
    gaps.push(
      "File access is enforced when a command is created, not by the kernel: " +
        "the declared file access tier may be weaker than on the server."
    );
  }
  return gaps;
}

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
   * Absolute path to the compiled preload script. Without it the Renderer
   * would have no `window.lecoding` bridge at all.
   */
  preloadEntry?: string;
  /**
   * Optional override for the trusted webContents id. Tests pass the id of
   * their fake window so sender validation passes.
   */
  trustedSenderId?: string;
  /** Credential storage handle; enables `session.status` and local clearing. */
  credentialStore?: CredentialStoreHandle;
  /** Injectable reconnect delay keeps stream behaviour deterministic in tests. */
  waitBeforeReconnect?: (signal: AbortSignal) => Promise<void>;
  /**
   * Local Runner sandbox capability source; enables `runner.status`.
   *
   * Injected rather than constructed so Main never chooses a platform adapter
   * and the Renderer never receives anything but the reported levels.
   */
  sandbox?(): SandboxCapabilityReport;
  /** Current Local Runner state; enables `runner.status`. */
  runnerState?(): RunnerBrokerState | undefined;
}

export interface DesktopMain {
  start(): Promise<void>;
  /** Test-only accessor for registered handlers. */
  handlers(): ReadonlyMap<string, IpcHandler>;
  /** Test-only accessor for the held SDK instance. */
  sdk(): ClientSdk;
  /** Test-only accessor for push activity. */
  pushed(): ReadonlyArray<{ channel: string; payload: unknown }>;
}

/** Strict CSP forbids any resource from outside the packaged app. */
const CSP_HEADER =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Maps an SDK failure onto the coarse codes the Renderer is allowed to see.
 *
 * Device-binding failures are surfaced distinctly so the Renderer can return
 * the user to the binding screen (revoked / expired credential) instead of
 * showing a generic error and retrying forever against a dead device.
 */
function errorCodeFor(error: unknown): IpcErrorCode {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 403) {
    return "forbidden";
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "device_revoked" || code === "device_expired") {
    return "device_revoked";
  }
  if (code === "code_consumed") {
    return "code_consumed";
  }
  if (code === "code_expired") {
    return "code_expired";
  }
  return "upstream_error";
}

export function createDesktopMain(options: DesktopMainOptions): DesktopMain {
  const { host, createClientSdk, rendererEntry } = options;
  const handlerMap = new Map<string, IpcHandler>();
  const pushedEvents: Array<{ channel: string; payload: unknown }> = [];
  let sdk: ClientSdk | undefined;
  let window: ElectronBrowserWindowInstance | undefined;
  let broker: RunStreamBroker | undefined;
  let activeSenderId: string | undefined = options.trustedSenderId;
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

  /**
   * Projects runner status and sandbox capability *levels* for the Renderer.
   *
   * Deliberately omits the worktree path, the granted directory list and any
   * credential: the Renderer cannot enforce them, and a compromised Renderer
   * naming real host paths is exactly what the sandbox exists to contain.
   */
  function runnerStatus(): RunnerStatePush {
    const report = options.sandbox?.();
    return {
      state: options.runnerState?.() ?? "unavailable",
      sandbox: report
        ? {
            platform: report.platform,
            tiers: { ...report.tiers },
            detail: report.detail,
            isolationGaps: isolationGaps(report)
          }
        : {
            platform: "",
            tiers: {},
            detail: "No Local Runner sandbox is configured",
            isolationGaps: DOCKER_ISOLATION_GAPS
          }
    };
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
      const r = request as { channel: DispatchChannel; payload: unknown };
      switch (r.channel) {
        case "session.openGitHubLogin": {
          const loginUrl = sdkInstance.getGitHubLoginUrl();
          // The URL is created from Main-owned SDK configuration; Renderer
          // input never reaches `shell.openExternal`.
          await host.openExternal(loginUrl);
          return ok({ opened: true });
        }
        case "session.status": {
          const credential = await options.credentialStore?.status();
          return ok({
            bootstrapped: bootstrapConfig !== undefined,
            ...(bootstrapConfig ? { baseUrl: bootstrapConfig.baseUrl } : {}),
            ...(credential ? { credential } : {})
          });
        }
        case "session.logout": {
          await sdkInstance.logout();
          // Local credentials die with the session; leaving them behind would
          // let the next launch re-authenticate as a revoked device.
          await options.credentialStore?.clear();
          broker?.dispose();
          bootstrapConfig = undefined;
          return ok({ loggedOut: true });
        }
        case "config.load": {
          return ok(await sdkInstance.getControlPlaneConfig());
        }
        case "devices.createCode": {
          const payload = r.payload as { projectId: ProjectId };
          return ok(await sdkInstance.createDeviceCode(payload.projectId));
        }
        case "devices.exchange": {
          // The bridge already validated the payload shape, so the only work
          // left here is narrowing it to the typed exchange input. The SDK
          // persists the returned credential, but Main intentionally discards
          // the result so its access token never enters an IPC response.
          await sdkInstance.exchangeDeviceCode(r.payload as DeviceExchangeInput);
          return ok({ bound: true });
        }
        case "devices.list": {
          // The server scopes the listing to the authenticated user, so a
          // projectId is a client-side filter rather than an identity check —
          // the device manager only ever shows one project at a time.
          const payload = r.payload as { projectId?: ProjectId };
          const listing = await sdkInstance.listDevices();
          if (payload.projectId === undefined) {
            return ok(listing);
          }
          return ok({
            devices: listing.devices.filter(
              (device) => device.projectId === payload.projectId
            )
          });
        }
        case "devices.revoke": {
          const payload = r.payload as { deviceId: string };
          await sdkInstance.revokeDevice(payload.deviceId);
          // Revocation is server-side; dropping the local copy keeps a
          // re-launched client from presenting a dead device.
          await options.credentialStore?.clear();
          broker?.dispose();
          return ok({ revoked: true });
        }
        case "runs.create": {
          const payload = r.payload as { projectId: ProjectId; input: CreateRunInput };
          return ok(await sdkInstance.createRun(payload.projectId, payload.input));
        }
        case "runs.list": {
          const payload = r.payload as { projectId: ProjectId; limit?: number };
          return ok(await sdkInstance.listRuns(payload.projectId, payload.limit));
        }
        case "runs.inspect": {
          const payload = r.payload as { runId: RunId };
          return ok(await sdkInstance.inspectRun(payload.runId));
        }
        case "runs.cancel": {
          const payload = r.payload as { runId: RunId };
          await sdkInstance.cancelRun(payload.runId);
          return ok({ cancelled: true });
        }
        case "runs.resolve": {
          const payload = r.payload as { runId: RunId; outcome: "keep" | "discard" };
          await sdkInstance.resolveRunResult(payload.runId, payload.outcome);
          return ok({ resolved: true });
        }
        case "runs.changes": {
          const payload = r.payload as { runId: RunId };
          return ok(await sdkInstance.getRunChanges(payload.runId));
        }
        case "runs.artifact": {
          const payload = r.payload as { runId: RunId; artifactId: string };
          return ok(await sdkInstance.getRunArtifact(payload.runId, payload.artifactId));
        }
        case "runs.approve": {
          const payload = r.payload as {
            runId: RunId;
            approvalId: string;
            scope: ApprovalScope;
          };
          await sdkInstance.approveRun(payload.runId, payload.approvalId, payload.scope);
          return ok({ approved: true });
        }
        case "runs.reject": {
          const payload = r.payload as {
            runId: RunId;
            approvalId: string;
            scope: ApprovalScope;
          };
          await sdkInstance.rejectRun(payload.runId, payload.approvalId, payload.scope);
          return ok({ rejected: true });
        }
        case "runs.editApprove": {
          const payload = r.payload as {
            runId: RunId;
            approvalId: string;
            replacement: EditedApprovalCapability;
          };
          await sdkInstance.editAndApproveRun(
            payload.runId,
            payload.approvalId,
            payload.replacement
          );
          return ok({ approved: true });
        }
        case "runs.answer": {
          const payload = r.payload as {
            runId: RunId;
            requestId: string;
            value: string;
          };
          await sdkInstance.answerRun(payload.runId, payload.requestId, payload.value);
          return ok({ answered: true });
        }
        case "runs.steer": {
          const payload = r.payload as { runId: RunId; message: string };
          await sdkInstance.steerRun(payload.runId, payload.message);
          return ok({ steered: true });
        }
        case "runs.subscribe": {
          const payload = r.payload as { runId: RunId };
          broker?.subscribe(payload.runId);
          return ok({ subscribed: true });
        }
        case "runs.unsubscribe": {
          const payload = r.payload as { runId: RunId };
          broker?.unsubscribe(payload.runId);
          return ok({ unsubscribed: true });
        }
        case "policy.list": {
          const payload = r.payload as { projectId: ProjectId };
          return ok(await sdkInstance.listProjectPolicyRules(payload.projectId));
        }
        case "policy.revoke": {
          const payload = r.payload as { projectId: ProjectId; ruleId: string };
          await sdkInstance.revokeProjectPolicyRule(payload.projectId, payload.ruleId);
          return ok({ revoked: true });
        }
        case "host.selectDirectories": {
          // The paths come from the OS dialog, never from the Renderer, so the
          // payload is intentionally empty. Canonicalization happens in the
          // grant service before anything is stored.
          const selection = await host.selectDirectories?.({
            title: "Choose the folders this Run may access"
          });
          if (!selection || !selection.shown) {
            return err("upstream_error", "The folder picker is unavailable");
          }
          // Absolute paths do not cross the bridge. The Renderer only needs to
          // confirm how many folders were authorized and show their names, and
          // a compromised Renderer must not be handed real host locations to
          // name in later commands.
          return ok({
            count: selection.paths.length,
            labels: selection.paths.map((path) => basenameOf(path))
          });
        }
        case "host.confirmHostFull": {
          // Absence of the dialog must read as "no consent", never as approval.
          const confirmed = (await host.confirmDanger?.(HOST_FULL_CONFIRMATION)) ?? false;
          return ok({ confirmed });
        }
        case "runner.status": {
          return ok(runnerStatus());
        }
        default: {
          /*
           * Assigning to `never` makes the switch exhaustive at compile time.
           *
           * A plain `default: return unknown_channel` silently swallowed new
           * channels: the contract would register and validate them while the
           * dispatch fell through, producing a channel that compiles, passes
           * its tests and does nothing at runtime. Adding a name to
           * IPC_CHANNELS is now a type error here until a case exists.
           */
          const unhandled: never = r.channel;
          return err("unknown_channel", `Channel ${String(unhandled)} is not registered`);
        }
      }
    } catch (error) {
      // Strip stacks so the Renderer only sees the message — a leaked stack
      // would reveal internal types and file paths.
      const message = error instanceof Error ? error.message : "unknown error";
      const code = errorCodeFor(error);
      if (code === "unauthorized" || code === "device_revoked") {
        // A rejected bearer must not survive for the next request or restart.
        // Clearing failure is itself fail-closed: do not pretend rebind is safe
        // while an invalid credential remains durable.
        try {
          await options.credentialStore?.clear();
          broker?.dispose();
        } catch {
          return err("upstream_error", "Failed to clear the invalid credential");
        }
      }
      return err(code, message);
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
      const created = new host.BrowserWindow({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          // Disable remote module + spellchecker + webview tag entirely.
          enableRemoteModule: false,
          webviewTag: false,
          // The preload bridge is the Renderer's only capability surface.
          // Leaving it undefined would silently ship a window with no
          // `window.lecoding`, so production must always pass a real path.
          ...(options.preloadEntry ? { preload: options.preloadEntry } : {})
        }
      });
      window = created;
      activeSenderId = String(created.webContents.id);

      // 4. Deny all window.open attempts (new windows, navigations).
      created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

      // 5. Forbid every document-triggered navigation. Treating all file://
      //    URLs as trusted would let an arbitrary local HTML file inherit this
      //    window's preload bridge and trusted sender identity.
      created.webContents.on("will-navigate", (event: unknown, _url: unknown) => {
        (event as { preventDefault: () => void }).preventDefault?.();
      });

      // 6. Relay the durable Run event stream. The Renderer cannot reach the
      //    Worker itself, so the broker holds the subscription and pushes.
      broker = createRunStreamBroker({
        getWindow: () => window,
        getSdk: requireSdk,
        ...(options.waitBeforeReconnect
          ? { waitBeforeReconnect: options.waitBeforeReconnect }
          : {})
      });

      // Record pushes so tests can assert on what the Renderer would receive.
      const originalSend = created.webContents.send.bind(created.webContents);
      created.webContents.send = ((channel: PushChannel, payload: unknown) => {
        pushedEvents.push({ channel, payload });
        originalSend(channel, payload);
      }) as typeof created.webContents.send;

      // 7. Load the packaged Renderer. Never load a URL.
      await created.loadFile(rendererEntry);

      // 8. Stop every stream before the window disappears so a closed window
      //    cannot keep an authenticated SSE connection alive.
      created.on("closed", () => {
        broker?.dispose();
        window = undefined;
        activeSenderId = options.trustedSenderId;
      });

      // 9. Honour macOS convention: keep app open until user quits.
      host.app.on("window-all-closed", () => {
        host.app.quit();
      });
    },
    handlers(): ReadonlyMap<string, IpcHandler> {
      return handlerMap;
    },
    sdk(): ClientSdk {
      return requireSdk();
    },
    pushed(): ReadonlyArray<{ channel: string; payload: unknown }> {
      return pushedEvents;
    }
  };
}

type IpcChannel = import("../shared/ipc-contract.js").IpcChannel;
type ProjectId = import("@lecoding/contracts").ProjectId;
type RunId = import("@lecoding/contracts").RunId;
type CreateRunInput = import("@lecoding/contracts").CreateRunInput;
type ApprovalScope = import("@lecoding/contracts").ApprovalScope;
type EditedApprovalCapability =
  import("@lecoding/contracts").EditedApprovalCapability;
