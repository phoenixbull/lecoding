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
import { app, BrowserWindow, ipcMain, safeStorage, session, shell } from "electron";
import { createClient } from "@lecoding/client-sdk";
import { createDesktopMain } from "./index.js";
import { createDesktopCredentialStore } from "./secure-store-factory.js";
import type { ClientSdk, ElectronHost } from "./host.js";

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
    credentialStore
  });
  await main.start();
}

void app.whenReady().then(bootstrap);
