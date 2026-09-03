import { SecureStoreUnavailableError, type SecureStore } from "./index.js";
import { createEncryptedFileSecureStore } from "./encrypted-file-store.js";
import {
  createSafeStorageSecureStore,
  type SafeStorageLike
} from "./safe-storage-store.js";

/** Backends the console will actually report to the user. */
export type SecureStoreBackend = "safeStorage" | "encryptedFile";

export interface SecureStoreHealth {
  backend: SecureStoreBackend;
  /**
   * True when the OS keychain was unreachable and a weaker backend took over.
   * The UI must keep this visible for as long as the session lasts.
   */
  degraded: boolean;
  reason?: string;
}

export interface SecureStoreSelection {
  store: SecureStore;
  health: SecureStoreHealth;
}

export interface SelectSecureStoreOptions {
  /** Ciphertext file for the keychain-backed backend. */
  safeStorageFilePath: string;
  /** Ciphertext file for the passphrase-encrypted fallback. */
  fallbackFilePath: string;
  fallbackPassphrase: string;
  /** Omitted (or unavailable) means an immediate, explicit degradation. */
  safeStorage?: SafeStorageLike;
  /** Namespace whose entries are migrated when the keychain becomes available. */
  namespace?: string;
}

/**
 * Chooses the strongest credential backend that actually works.
 *
 * The rules are deliberately fail-closed:
 *   - No keychain  -> degrade to the encrypted file, but report it. The user
 *     must see that their device token is protected by a passphrase and not
 *     by the OS.
 *   - Keychain present but unreadable -> refuse. The OS key changed, so the
 *     stored credential is gone; starting anyway would silently drop it.
 *   - In-memory is never selected. It would lose the credential on quit while
 *     looking identical to a healthy session.
 */
export async function selectSecureStore(
  options: SelectSecureStoreOptions
): Promise<SecureStoreSelection> {
  const namespace = options.namespace ?? "device:";
  const fallback = createEncryptedFileSecureStore({
    filePath: options.fallbackFilePath,
    passphrase: options.fallbackPassphrase
  });
  const safeStorage = options.safeStorage;

  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    return {
      store: fallback,
      health: {
        backend: "encryptedFile",
        degraded: true,
        reason: "系统安全存储不可用，已降级为加密文件"
      }
    };
  }

  let primary: SecureStore;
  try {
    primary = createSafeStorageSecureStore({
      filePath: options.safeStorageFilePath,
      safeStorage
    });
    await assertEntriesReadable(primary, namespace);
  } catch (error) {
    throw new SecureStoreUnavailableError(
      `系统安全存储无法读取已保存的凭据：${describe(error)}`
    );
  }

  await migrateLegacyEntries(fallback, primary, namespace);
  return { store: primary, health: { backend: "safeStorage", degraded: false } };
}

/**
 * Proves the selected backend can actually decrypt what it already holds.
 *
 * Listing keys only reads the index. A rotated OS key leaves the index
 * perfectly readable while every ciphertext becomes garbage, so the probe has
 * to attempt a real decrypt before the console trusts the backend.
 */
async function assertEntriesReadable(
  store: SecureStore,
  namespace: string
): Promise<void> {
  for (const key of await store.listKeys(namespace)) {
    await store.getItem(key);
  }
}

/**
 * Moves credentials from the passphrase file into the keychain the first time
 * the keychain becomes available.
 *
 * The weak copy is deleted only after every entry survived the move, so a
 * partial failure leaves the credential readable rather than lost.
 */
async function migrateLegacyEntries(
  from: SecureStore,
  to: SecureStore,
  namespace: string
): Promise<void> {
  const existing = await to.listKeys(namespace);
  if (existing.length > 0) {
    return;
  }
  const legacy = await from.listKeys(namespace);
  if (legacy.length === 0) {
    return;
  }
  try {
    for (const key of legacy) {
      const value = await from.getItem(key);
      if (value !== undefined) {
        await to.setItem(key, value);
      }
    }
    for (const key of legacy) {
      await from.deleteItem(key);
    }
  } catch (error) {
    throw new SecureStoreUnavailableError(`凭据迁移失败：${describe(error)}`);
  }
}

/**
 * Deletes every credential under a namespace.
 *
 * Logout, device revocation, and expiry all funnel through here so a stale
 * credential can never re-authenticate on the next launch.
 */
export async function clearSecureStoreNamespace(
  store: SecureStore,
  namespace = "device:"
): Promise<void> {
  for (const key of await store.listKeys(namespace)) {
    await store.deleteItem(key);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
