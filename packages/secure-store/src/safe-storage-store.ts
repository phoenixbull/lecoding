import {
  MAX_KEY_BYTES,
  MAX_VALUE_BYTES,
  SecureStoreUnavailableError,
  validateKey,
  validateValue,
  type SecureStore
} from "./index.js";
import { normaliseFilePath, readJsonFile, writeJsonFile } from "./atomic-json.js";

/**
 * The slice of Electron's `safeStorage` this adapter needs.
 *
 * `safeStorage` is a cipher, not a store: it encrypts with an OS-protected
 * key (Keychain on macOS, DPAPI on Windows, libsecret on Linux) but has no
 * persistence. The ciphertext therefore still lands in a 0o600 JSON file,
 * while the key never leaves the OS.
 *
 * Caller obligations:
 *   - Call `isEncryptionAvailable()` before constructing; the constructor
 *     throws when it is false, because silently persisting plaintext would be
 *     worse than refusing to start.
 *   - Treat a decrypt failure as unrecoverable. It means the OS key changed
 *     (keychain reset, user profile migration), so every existing ciphertext
 *     is permanently unreadable.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SafeStorageSecureStoreOptions {
  /** Ciphertext file. Parent directories are created on first write. */
  filePath: string;
  safeStorage: SafeStorageLike;
}

const FILE_FORMAT_VERSION = 1;

interface SafeStoragePayload {
  version: 1;
  backend: "safeStorage";
  items: Record<string, string>;
}

export function createSafeStorageSecureStore(
  options: SafeStorageSecureStoreOptions
): SecureStore {
  if (!options.safeStorage.isEncryptionAvailable()) {
    throw new SecureStoreUnavailableError(
      "safeStorage encryption is unavailable on this system"
    );
  }
  const filePath = normaliseFilePath(options.filePath);
  const initial = readJsonFile<SafeStoragePayload>(filePath);
  if (initial !== undefined && !isValidPayload(initial)) {
    // A wrong schema means either corruption or tampering; refusing to start
    // keeps the console from overwriting evidence the operator may need.
    throw new SecureStoreUnavailableError(
      "safeStorage store file has an unexpected schema"
    );
  }
  let payload: SafeStoragePayload = initial ?? createEmptyPayload();

  function persist(next: SafeStoragePayload): void {
    writeJsonFile(filePath, next);
    payload = next;
  }

  return {
    async getItem(key) {
      validateKey(key);
      const item = payload.items[key];
      if (item === undefined) {
        return undefined;
      }
      try {
        return options.safeStorage.decryptString(Buffer.from(item, "base64"));
      } catch {
        throw new SecureStoreUnavailableError(
          "safeStorage cannot decrypt the stored value (the OS key changed)"
        );
      }
    },
    async setItem(key, value) {
      validateKey(key);
      validateValue(value);
      if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
        throw new Error(
          `SecureStore value must be at most ${MAX_VALUE_BYTES} UTF-8 bytes`
        );
      }
      const ciphertext = options.safeStorage.encryptString(value).toString("base64");
      persist({
        version: FILE_FORMAT_VERSION,
        backend: "safeStorage",
        items: { ...payload.items, [key]: ciphertext }
      });
    },
    async deleteItem(key) {
      validateKey(key);
      if (!(key in payload.items)) {
        return;
      }
      const nextItems = { ...payload.items };
      delete nextItems[key];
      persist({
        version: FILE_FORMAT_VERSION,
        backend: "safeStorage",
        items: nextItems
      });
    },
    async listKeys(namespace) {
      if (namespace !== undefined && namespace.length === 0) {
        throw new Error("namespace must not be empty");
      }
      const keys: string[] = [];
      for (const key of Object.keys(payload.items)) {
        if (namespace === undefined || key.startsWith(namespace)) {
          keys.push(key);
        }
      }
      return keys.sort();
    }
  };
}

function createEmptyPayload(): SafeStoragePayload {
  return { version: FILE_FORMAT_VERSION, backend: "safeStorage", items: {} };
}

function isValidPayload(value: unknown): value is SafeStoragePayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SafeStoragePayload>;
  if (candidate.version !== FILE_FORMAT_VERSION || candidate.backend !== "safeStorage") {
    return false;
  }
  if (!candidate.items || typeof candidate.items !== "object") {
    return false;
  }
  for (const [key, value] of Object.entries(candidate.items)) {
    if (
      key.length === 0 ||
      key.length > MAX_KEY_BYTES ||
      typeof value !== "string"
    ) {
      return false;
    }
  }
  return true;
}
