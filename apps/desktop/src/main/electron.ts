/**
 * Production Electron bootstrap.
 *
 * This is the only module allowed to import Electron. Every other piece of
 * the main process depends on the narrow `ElectronHost` port instead, which
 * is what lets the security policy (sandbox flags, CSP, sender validation)
 * be verified in tests without a display server.
 *
 * The entry points are derived from the packaged layout:
 *   - main    : dist/main/electron.js   (package.json `main`)
 *   - preload : dist/preload/index.js
 *   - renderer: <app>/dist/renderer/index.html
 *
 * `import.meta.dirname` is used instead of `__dirname` because the package is
 * ESM (`"type": "module"`).
 */

import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell
} from "electron";
import { createClient } from "@lecoding/client-sdk";
import { selectHostSandbox, type FileAccessGrant } from "@lecoding/host-sandbox";
import { createRunJournal } from "@lecoding/local-runner";
import { createGitRunResultManager } from "@lecoding/workspace";
import { createLocalRunnerHost, type LocalRunnerHost } from "./local-runner-host.js";
import { createDesktopMain } from "./index.js";
import { createFileAccessGrantService } from "./file-access-grant-service.js";
import { createLocalRunnerHandlers } from "./local-runner-handlers.js";
import { createRunnerBroker } from "./runner-broker.js";
import { createRunnerWebSocket, runnerWebSocketUrl } from "./runner-ws-client.js";
import { createDesktopCredentialStore } from "./secure-store-factory.js";
import type { ClientSdk, ElectronHost } from "./host.js";

/** Set once the Local Runner is assembled; needed by the cancellation path. */
let activeHost: LocalRunnerHost | undefined;

/** Packaged Renderer entry; resolved at runtime because asar changes the root. */
function rendererEntry(): string {
  return join(app.getAppPath(), "dist", "renderer", "index.html");
}

/** Compiled preload sitting next to this file inside the same dist tree. */
function preloadEntry(): string {
  return join(import.meta.dirname, "..", "preload", "index.js");
}

/**
 * Adapts the real Electron modules to the `ElectronHost` port.
 *
 * The IPC adapter is where sender identity is established: every handler
 * receives the originating webContents id so the main process can reject
 * requests from any window other than the active Renderer.
 */
function createElectronHost(): ElectronHost {
  return {
    app: {
      // Electron overloads `app.on` per event name while the port takes a
      // union, so each case is registered with the exact literal Electron
      // expects — no cast, no silently dropped listener.
      on(event, listener) {
        switch (event) {
          case "window-all-closed":
            app.on("window-all-closed", listener);
            return;
          case "before-quit":
            app.on("before-quit", listener);
            return;
          case "ready":
            app.on("ready", listener);
            return;
        }
      },
      quit() {
        app.quit();
      },
      whenReady() {
        return app.whenReady().then(() => undefined);
      }
    },
    ipcMain: {
      handle(channel, handler) {
        ipcMain.handle(channel, (event, request) =>
          handler(request, { senderId: String(event.sender.id) })
        );
      }
    },
    BrowserWindow: BrowserWindow as unknown as ElectronHost["BrowserWindow"],
    setCspHeader(value) {
      // Applying the CSP at the session level makes every navigation inherit
      // it, including windows created after startup.
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const headers = { ...details.responseHeaders };
        if (value === null) {
          delete headers["content-security-policy"];
        } else {
          headers["content-security-policy"] = [value];
        }
        callback({ responseHeaders: headers });
      });
    },
    openExternal(url) {
      return shell.openExternal(url);
    },
    async selectDirectories({ title }) {
      // The OS file dialog is the authorization. A path typed into the Renderer
      // is not, so there is deliberately no text-entry fallback.
      const result = await dialog.showOpenDialog({
        title,
        properties: ["openDirectory", "multiSelections", "showHiddenFiles"]
      });
      return {
        // `filePaths` is empty when the user cancels, which the caller reads as
        // a refusal rather than as "no restriction".
        paths: result.filePaths,
        // A dialog that could not be shown is indistinguishable from a
        // cancellation at this level, so it is reported as not shown.
        shown: true
      };
    },
    async confirmDanger({ title, message, detail, acknowledgementLabel }) {
      const result = await dialog.showMessageBox({
        type: "warning",
        title,
        message,
        detail,
        buttons: ["Cancel", "Allow full access"],
        defaultId: 0,
        cancelId: 0,
        // Requires an explicit tick rather than a bare OK, so consent is a
        // deliberate act and not the default path through the dialog.
        checkboxLabel: acknowledgementLabel,
        checkboxChecked: false
      });
      return result.response === 1 && result.checkboxChecked === true;
    }
  };
}

/**
 * Boots the app.
 *
 * The credential store is resolved before the window opens: a keychain that
 * cannot be read is a hard stop, because starting anyway would leave the user
 * on a session whose device token is silently gone.
 */
async function bootstrap(): Promise<void> {
  const credentialStore = await createDesktopCredentialStore({
    userDataPath: app.getPath("userData"),
    safeStorage
  });
  // Drop a credential that passed its expiry while the app was closed.
  await credentialStore.purgeExpired();

  /*
   * Local execution stack. The broker owns the Runner session, the grant
   * service issues file access from OS dialogs, and the sandbox enforces it at
   * process creation. All three are wired here — the production entry point —
   * so that local execution is real rather than only reachable from tests.
   */
  const sandbox = selectHostSandbox();
  const grantService = createFileAccessGrantService({
    host: createElectronHost(),
    now: () => new Date().toISOString()
  });
  const userData = app.getPath("userData");
  const runnerRoot = join(userData, "local-runner");
  const worktreeRoot = join(runnerRoot, "worktrees");
  const sourceRepoPath = localSourceRepo();
  const gitResults = createGitRunResultManager({
    sourceRepo: sourceRepoPath,
    worktreeRoot
  });

  const runnerHost = createLocalRunnerHost({
    journal: createRunJournal({
      filePath: join(runnerRoot, "run-journal.jsonl"),
      now: () => new Date().toISOString()
    }),
    now: () => new Date().toISOString(),
    resolveRunOutcome: async (runId, outcome) => {
      await gitResults.resolve(runId, outcome);
    },
    cancelRun: (runId) => {
      // Re-entered through the host so a Run waiting on approval is cancelled
      // by the same path as one mid-command.
      activeHost?.cancel(runId);
    }
  });
  // Recovery runs before the session opens, so a Run left prepared by a
  // previous launch is still resolvable instead of stranded.
  await runnerHost.recover();

  /** Grants the user has issued, keyed by Run; the desktop is the issuer. */
  const grants = new Map<string, FileAccessGrant>();
  const handlers = createLocalRunnerHandlers({
    sandbox,
    host: runnerHost,
    resolveGrant: async ({ runId, scope, worktreePath }) => {
      const existing = grants.get(runId);
      if (existing) {
        return existing;
      }
      // Issues the grant through an OS dialog. A declined or unavailable
      // dialog yields no grant, and the handler then refuses the command.
      const outcome = await grantService.issue({
        runId,
        scope,
        worktreePath
      });
      if (!outcome.granted) {
        return undefined;
      }
      grants.set(runId, outcome.grant);
      return outcome.grant;
    },
    sourceRepo: sourceRepoPath,
    worktreeRoot,
    worktreePathFor: (runId) => join(worktreeRoot, runId),
    auditLogPath: join(runnerRoot, "host-access.jsonl"),
    now: () => new Date().toISOString()
  });
  activeHost = runnerHost;

  const broker = createRunnerBroker({
    connect: () => createRunnerWebSocket(runnerWebSocketUrl(baseUrl())),
    credential: async () => credentialStore.deviceAccessToken?.(),
    capabilities: {
      // Reported from what the sandbox can actually enforce, so the server
      // refuses a Run asking for more isolation than this host provides
      // instead of discovering it after the Run started.
      maxFileAccessScope: sandbox.capabilities().tiers.host_full === "unsupported"
        ? "workspace_only"
        : "host_full",
      kernelEnforced:
        sandbox.capabilities().tiers.workspace_only === "kernel",
      platform:
        process.platform === "darwin" || process.platform === "win32"
          ? process.platform
          : "linux"
    },
    handlers
  });

  const main = createDesktopMain({
    host: createElectronHost(),
    // Passing the same store the handle reports on means an exchange is
    // persisted by the OS keychain (or the reported fallback) rather than
    // sitting only in memory for one session.
    createClientSdk: (config) =>
      createClient({
        ...config,
        secureStore: credentialStore.store
      }) as unknown as ClientSdk,
    rendererEntry: rendererEntry(),
    preloadEntry: preloadEntry(),
    credentialStore,
    sandbox: () => sandbox.capabilities(),
    runnerState: () => broker.state()
  });
  await main.start();
}

/** Base URL the desktop client is configured against. */
function baseUrl(): string {
  const configured = process.env["LECODING_BASE_URL"]?.trim();
  return configured !== undefined && configured.length > 0
    ? configured
    : "http://127.0.0.1:8787";
}

/**
 * Local Git repository Runs are prepared from.
 *
 * Required rather than defaulted: a Local Runner with no source repository
 * cannot prepare a worktree, and silently falling back to the app directory
 * would put Run worktrees somewhere neither the user nor the cleanup path
 * expects.
 */
function localSourceRepo(): string {
  const configured = process.env["LECODING_LOCAL_SOURCE_REPO"]?.trim();
  if (configured === undefined || configured.length === 0) {
    throw new Error(
      "LECODING_LOCAL_SOURCE_REPO must name the local Git repository Runs execute against"
    );
  }
  return configured;
}

void app.whenReady().then(bootstrap);

void app.whenReady().then(bootstrap);
