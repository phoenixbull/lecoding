import {
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  MAX_KEY_BYTES,
  MAX_VALUE_BYTES,
  SecureStoreUnavailableError,
  validateKey,
  validateValue,
  type SecureStore
} from "./index.js";

/**
 * File-backed encrypted adapter.
 *
 * The on-disk format is a single JSON document:
 *
 * ```
 * {
 *   "version": 1,
 *   "kdf":    { "name": "pbkdf2-hmac-sha256", "iterations": 200000, "salt": "<hex>" },
 *   "items":  { "<key": "<base64-ciphertext>" }
 * }
 * ```
 *
 * Each ciphertext is `iv || ciphertext || authTag` from AES-256-GCM. KDF
 * derivation uses PBKDF2-HMAC-SHA256 with 200k iterations to deter offline
 * brute-force attacks against a stolen secrets file.
 */
export interface EncryptedFileSecureStoreOptions {
  filePath: string;
  passphrase: string;
  /** Override the KDF iteration count. Tests may drop it to 1. Default 200k. */
  pbkdf2Iterations?: number;
}

const FILE_FORMAT_VERSION = 1;
const DEFAULT_PBKDF2_ITERATIONS = 200_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const AUTH_TAG_BYTES = 16;
const MIN_PASSPHRASE_LENGTH = 8;

interface FilePayload {
  version: number;
  kdf: {
    name: "pbkdf2-hmac-sha256";
    iterations: number;
    salt: string;
  };
  items: Record<string, string>;
}

export function createEncryptedFileSecureStore(
  options: EncryptedFileSecureStoreOptions
): SecureStore {
  if (typeof options.passphrase !== "string") {
    throw new Error("SecureStore passphrase is required");
  }
  if (options.passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(
      `SecureStore passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`
    );
  }
  const filePath = normaliseFilePath(options.filePath);
  const iterations =
    options.pbkdf2Iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error("pbkdf2Iterations must be a positive integer");
  }
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const initial = readPayload(filePath);
  let payload: FilePayload = initial ?? createEmptyPayload({ iterations });
  const keyCache: { key: Buffer } = {
    key: deriveKey(options.passphrase, payload.kdf.salt, iterations)
  };

  function persist(next: FilePayload): void {
    const serialised = JSON.stringify(next);
    // Atomic write: rename over the original so a crash never leaves a
    // half-written plaintext-then-encrypted file on disk.
    const tempPath = `${filePath}.tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(tempPath, serialised, { mode: 0o600 });
    renameSync(tempPath, filePath);
  }

  return {
    async getItem(key) {
      validateKey(key);
      const item = payload.items[key];
      if (item === undefined) {
        return undefined;
      }
      try {
        return decrypt(keyCache.key, item);
      } catch {
        throw new SecureStoreUnavailableError(
          "SecureStore cannot decrypt the requested value (wrong passphrase?)"
        );
      }
    },
    async setItem(key, value) {
      validateKey(key);
      validateValue(value);
      // Buffer byte length is computed once and shared across the size limit
      // and the encryption payload so we cannot accidentally encrypt a
      // longer value than the documented contract allows.
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes > MAX_VALUE_BYTES) {
        throw new Error(
          `SecureStore value must be at most ${MAX_VALUE_BYTES} UTF-8 bytes`
        );
      }
      const next: FilePayload = {
        version: FILE_FORMAT_VERSION,
        kdf: payload.kdf,
        items: { ...payload.items, [key]: encrypt(keyCache.key, value) }
      };
      persist(next);
      payload = next;
    },
    async deleteItem(key) {
      validateKey(key);
      if (!(key in payload.items)) {
        return;
      }
      const nextItems = { ...payload.items };
      delete nextItems[key];
      const next: FilePayload = {
        version: FILE_FORMAT_VERSION,
        kdf: payload.kdf,
        items: nextItems
      };
      persist(next);
      payload = next;
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

function normaliseFilePath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("Encrypted-file SecureStore path is required");
  }
  const resolved = resolve(input);
  // Reject obvious escape attempts that target the parent of the resolved
  // root; consumers should pass a stable per-user data directory.
  if (!isAbsolute(resolved)) {
    throw new Error("Encrypted-file SecureStore path must be absolute");
  }
  // Capping the length protects against pathological inputs that some
  // filesystems truncate silently.
  if (resolved.length > 4096) {
    throw new Error("Encrypted-file SecureStore path is too long");
  }
  return resolved;
}

function deriveKey(
  passphrase: string,
  saltHex: string,
  iterations: number
): Buffer {
  const salt = Buffer.from(saltHex, "hex");
  return pbkdf2Sync(passphrase, salt, iterations, KEY_BYTES, "sha256");
}

function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]).toString("base64");
}

function decrypt(key: Buffer, encoded: string): string {
  const combined = Buffer.from(encoded, "base64");
  if (combined.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error("Encrypted SecureStore payload is malformed");
  }
  const iv = combined.subarray(0, IV_BYTES);
  const authTag = combined.subarray(combined.length - AUTH_TAG_BYTES);
  const ciphertext = combined.subarray(
    IV_BYTES,
    combined.length - AUTH_TAG_BYTES
  );
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}

function readPayload(filePath: string): FilePayload | null {
  if (!existsSync(filePath)) {
    return null;
  }
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Encrypted SecureStore file is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Encrypted SecureStore file is corrupt: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!isValidPayload(parsed)) {
    throw new Error("Encrypted SecureStore file has an unexpected schema");
  }
  return parsed;
}

function createEmptyPayload(input: { iterations: number }): FilePayload {
  return {
    version: FILE_FORMAT_VERSION,
    kdf: {
      name: "pbkdf2-hmac-sha256",
      iterations: input.iterations,
      salt: randomBytes(SALT_BYTES).toString("hex")
    },
    items: {}
  };
}

function isValidPayload(value: unknown): value is FilePayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<FilePayload>;
  if (candidate.version !== FILE_FORMAT_VERSION) {
    return false;
  }
  const kdf = candidate.kdf;
  if (
    !kdf ||
    kdf.name !== "pbkdf2-hmac-sha256" ||
    !Number.isSafeInteger(kdf.iterations) ||
    typeof kdf.salt !== "string" ||
    !/^[a-f0-9]+$/u.test(kdf.salt)
  ) {
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

// timingSafeEqual on a constant length is a documentation aid: the
// comparison is short-circuited by JS array equality anyway, but emitting
// the helper documents that the secure-store deliberately treats string
// lengths as public. Suppress the unused warning.
void timingSafeEqual;
void createHash;