/**
 * Cross-platform secure storage contract.
 *
 * The contract is intentionally small (key/value, single namespace at a time)
 * so adapters can map onto Windows DPAPI / macOS Keychain / Linux libsecret /
 * Electron safeStorage without leaking native details into call sites. The
 * Electron desktop wires a real keychain-backed adapter; this package ships
 * an in-memory test adapter and an encrypted-file adapter that doubles as a
 * portable fallback in CI.
 *
 * The contract deliberately stores UTF-8 strings: callers are responsible for
 * `JSON.stringify` and `JSON.parse`. This avoids leaking the credential shape
 * into the secure-store contract and keeps the encrypted-file format a single
 * documented wire schema.
 */

export interface SecureStore {
  getItem(key: string): Promise<string | undefined>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
  /** Returns keys that begin with the supplied namespace prefix (or all if unset). */
  listKeys(namespace?: string): Promise<string[]>;
}

/** Maximum number of UTF-8 bytes a single key may contain. */
export const MAX_KEY_BYTES = 512;
/** Maximum number of UTF-8 bytes a single value may contain. */
export const MAX_VALUE_BYTES = 64 * 1024;

export class SecureStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecureStoreUnavailableError";
  }
}

/**
 * In-memory adapter; intended for tests, CLI helpers, and the local-runner
 * pre-bootstrap state. Persists nothing across restarts.
 */
export function createInMemorySecureStore(): SecureStore {
  const values = new Map<string, string>();
  return {
    async getItem(key) {
      validateKey(key);
      return values.get(key);
    },
    async setItem(key, value) {
      validateKey(key);
      validateValue(value);
      values.set(key, value);
    },
    async deleteItem(key) {
      validateKey(key);
      values.delete(key);
    },
    async listKeys(namespace) {
      if (namespace !== undefined && namespace.length === 0) {
        throw new Error("namespace must not be empty");
      }
      const keys: string[] = [];
      for (const key of values.keys()) {
        if (namespace === undefined || key.startsWith(namespace)) {
          keys.push(key);
        }
      }
      return keys.sort();
    }
  };
}

export function validateKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("SecureStore key must be a non-empty string");
  }
  if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
    throw new Error(
      `SecureStore key must be at most ${MAX_KEY_BYTES} UTF-8 bytes`
    );
  }
  if (key.includes("\u0000")) {
    throw new Error("SecureStore key must not contain a null byte");
  }
}

export function validateValue(value: string): void {
  if (typeof value !== "string") {
    throw new Error("SecureStore value must be a string");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
    throw new Error(
      `SecureStore value must be at most ${MAX_VALUE_BYTES} UTF-8 bytes`
    );
  }
  if (value.includes("\u0000")) {
    throw new Error("SecureStore value must not contain a null byte");
  }
}

// Re-export the encrypted-file adapter; the implementation lives in
// encrypted-file-store.ts to keep the contract document short.
export {
  createEncryptedFileSecureStore,
  type EncryptedFileSecureStoreOptions
} from "./encrypted-file-store.js";

// Re-export the device-credential helper that wires the contract to the
// exchange shape produced by the Worker's device-binding API.
export {
  createDeviceCredentialStore,
  type DeviceCredentialStore,
  type DeviceCredentialStoreOptions,
  type ExchangedDeviceLike
} from "./device-credential-store.js";