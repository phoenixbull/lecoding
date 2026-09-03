import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearSecureStoreNamespace,
  createDeviceCredentialStore,
  selectSecureStore,
  type SafeStorageLike,
  type SecureStore
} from "@lecoding/secure-store";
import type { CredentialStoreHandle } from "./host.js";
import type { CredentialStatePush } from "../shared/ipc-contract.js";

export interface DesktopCredentialStoreOptions {
  /** Electron `app.getPath("userData")`; every credential file lives under it. */
  userDataPath: string;
  /** Electron `safeStorage`, or undefined when the OS keychain is unreachable. */
  safeStorage?: SafeStorageLike;
}

export interface DesktopCredentialStore extends CredentialStoreHandle {
  /**
   * The selected backend. Wire it into the client SDK so a device exchange is
   * persisted by the same store that reports its health.
   */
  store: SecureStore;
}

const CREDENTIAL_NAMESPACE = "device:";

/**
 * Wires the OS keychain (with a passphrase-encrypted fallback) to the main
 * process' credential handle.
 *
 * Only `backend`, `degraded`, `reason`, `deviceId`, and `expiresAt` ever leave
 * this module — the access token itself stays inside the store, so it can
 * never reach the Renderer, a log line, or a config file.
 */
export async function createDesktopCredentialStore(
  options: DesktopCredentialStoreOptions
): Promise<DesktopCredentialStore> {
  const directory = join(options.userDataPath, "credentials");
  mkdirSync(directory, { recursive: true });

  const selection = await selectSecureStore({
    safeStorageFilePath: join(directory, "keychain.json"),
    fallbackFilePath: join(directory, "fallback.json"),
    fallbackPassphrase: resolveFallbackPassphrase(directory),
    ...(options.safeStorage ? { safeStorage: options.safeStorage } : {})
  });
  const credentials = createDeviceCredentialStore({ backend: selection.store });

  async function storedCredential() {
    const [deviceId] = await credentials.list();
    if (deviceId === undefined) {
      return undefined;
    }
    return credentials.load(deviceId);
  }

  return {
    store: selection.store,
    async status(): Promise<CredentialStatePush | undefined> {
      // A decrypt/read failure is security-significant and must stop the
      // session instead of masquerading as an installation with no credential.
      const credential = await storedCredential();
      const expired =
        credential !== undefined && Date.parse(credential.expiresAt) <= Date.now();
      return {
        backend: selection.health.backend,
        degraded: selection.health.degraded,
        ...(selection.health.reason ? { reason: selection.health.reason } : {}),
        ...(credential ? { deviceId: credential.deviceId } : {}),
        ...(credential ? { expiresAt: credential.expiresAt } : {}),
        // An expired credential is reported as degraded so the UI escalates
        // it instead of leaving the user on a session that will 401.
        ...(expired ? { degraded: true, reason: "设备凭据已过期，请重新绑定" } : {})
      };
    },
    async clear(): Promise<void> {
      await clearSecureStoreNamespace(selection.store, CREDENTIAL_NAMESPACE);
    },
    async purgeExpired(now: Date = new Date()): Promise<void> {
      const credential = await storedCredential();
      if (credential && Date.parse(credential.expiresAt) <= now.getTime()) {
        // An expired token is unusable and must not survive a restart.
        await clearSecureStoreNamespace(selection.store, CREDENTIAL_NAMESPACE);
      }
    },
    async deviceAccessToken(): Promise<string | undefined> {
      // Returned to the main process only, for the Runner session's `hello`.
      // It is never placed in the health projection the Renderer receives.
      const credential = await storedCredential();
      return credential?.accessToken;
    }
  };
}

/**
 * Resolves the passphrase for the degraded backend.
 *
 * The fallback cannot be as strong as the OS keychain: there is nowhere else
 * on the machine to hide a key once the keychain is gone. So a random
 * per-install secret is kept in an owner-only file, which stops casual
 * inspection while remaining explicitly reported as degraded.
 */
function resolveFallbackPassphrase(directory: string): string {
  const keyPath = join(directory, "fallback.key");
  if (existsSync(keyPath)) {
    return readFileSync(keyPath, "utf8").trim();
  }
  const passphrase = randomBytes(32).toString("base64");
  writeFileSync(keyPath, passphrase, { mode: 0o600 });
  return passphrase;
}
