import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Refuses to read a file large enough to exhaust memory.
 *
 * Every secure-store file is a small JSON document of ciphertexts; a file
 * beyond this bound is corrupt or hostile, not a legitimate store.
 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Resolves and bounds a store path.
 *
 * Both backends write into a stable per-user data directory, so an absolute
 * path is required and pathological lengths are rejected rather than silently
 * truncated by the filesystem.
 */
export function normaliseFilePath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("Secure store path is required");
  }
  const resolved = resolve(input);
  if (!isAbsolute(resolved)) {
    throw new Error("Secure store path must be absolute");
  }
  if (resolved.length > 4096) {
    throw new Error("Secure store path is too long");
  }
  return resolved;
}

/** Reads a JSON document, returning undefined when the file does not exist. */
export function readJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  const size = statSync(filePath).size;
  if (size > MAX_FILE_BYTES) {
    throw new Error(
      `Secure store file is too large to trust (${size} bytes, limit ${MAX_FILE_BYTES})`
    );
  }
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Secure store file is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `Secure store file is corrupt: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Writes a JSON document atomically.
 *
 * A crash mid-write must never leave a half-written store, and the file holds
 * ciphertext derived from the user's credentials, so it is created 0o600.
 */
export function writeJsonFile(filePath: string, payload: unknown): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const tempPath = `${filePath}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tempPath, JSON.stringify(payload), { mode: 0o600 });
  renameSync(tempPath, filePath);
}
