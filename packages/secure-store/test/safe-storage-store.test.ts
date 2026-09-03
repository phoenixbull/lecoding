import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSafeStorageSecureStore,
  SecureStoreUnavailableError,
  type SafeStorageLike
} from "../src/index.js";

/**
 * In-memory stand-in for Electron's `safeStorage`.
 *
 * `available` drives `isEncryptionAvailable()`, and `keyId` lets a test
 * simulate an OS key change by rotating the id between construction and read.
 */
function createFakeSafeStorage(options: {
  available?: boolean;
  keyId?: string;
} = {}): SafeStorageLike & {
  available: boolean;
  keyId: string;
  failDecrypt: boolean;
} {
  return {
    available: options.available ?? true,
    keyId: options.keyId ?? "key-1",
    failDecrypt: false,
    isEncryptionAvailable() {
      return this.available;
    },
    encryptString(plaintext: string) {
      // The key id is part of the ciphertext so a rotation makes old values
      // undecryptable, exactly like a real keychain reset.
      return Buffer.from(`${this.keyId}|${plaintext}`, "utf8");
    },
    decryptString(encrypted: Buffer) {
      if (this.failDecrypt) {
        throw new Error("decryption failed");
      }
      const text = encrypted.toString("utf8");
      const separator = text.indexOf("|");
      const keyId = text.slice(0, separator);
      if (keyId !== this.keyId) {
        throw new Error("decryption failed");
      }
      return text.slice(separator + 1);
    }
  };
}

describe("createSafeStorageSecureStore", () => {
  let root: string;
  let filePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lecoding-safe-storage-"));
    filePath = join(root, "credentials.json");
  });

  afterEach(() => {
    // No teardown needed: each test gets its own temp directory.
  });

  it("refuses to start when the OS keychain is unavailable", () => {
    const safeStorage = createFakeSafeStorage({ available: false });
    expect(() =>
      createSafeStorageSecureStore({ filePath, safeStorage })
    ).toThrow(SecureStoreUnavailableError);
  });

  it("round-trips a value through the OS key", async () => {
    const store = createSafeStorageSecureStore({
      filePath,
      safeStorage: createFakeSafeStorage()
    });
    await store.setItem("device:device-1", "device-token");
    await expect(store.getItem("device:device-1")).resolves.toBe("device-token");
  });

  it("never writes the plaintext to disk", async () => {
    const store = createSafeStorageSecureStore({
      filePath,
      safeStorage: createFakeSafeStorage()
    });
    await store.setItem("device:device-1", "super-secret-token");
    const onDisk = readFileSync(filePath, "utf8");
    expect(onDisk).not.toContain("super-secret-token");
    // The ciphertext is base64 of `keyId|plaintext`; assert it is the wrapped
    // form rather than the credential itself.
    expect(Buffer.from(JSON.parse(onDisk).items["device:device-1"], "base64").toString())
      .toContain("super-secret-token");
  });

  it("creates the ciphertext file with owner-only permissions", async () => {
    const nested = join(root, "nested", "credentials.json");
    const store = createSafeStorageSecureStore({
      filePath: nested,
      safeStorage: createFakeSafeStorage()
    });
    await store.setItem("device:device-1", "token");
    // eslint-disable-next-line no-bitwise -- mode bits are the point of the assertion
    expect(statSync(nested).mode & 0o777).toBe(0o600);
  });

  it("lists and deletes under a namespace", async () => {
    const store = createSafeStorageSecureStore({
      filePath,
      safeStorage: createFakeSafeStorage()
    });
    await store.setItem("device:device-a", "a");
    await store.setItem("device:device-b", "b");
    await store.setItem("session:other", "c");
    await expect(store.listKeys("device:")).resolves.toEqual([
      "device:device-a",
      "device:device-b"
    ]);
    await store.deleteItem("device:device-a");
    await expect(store.getItem("device:device-a")).resolves.toBeUndefined();
    await expect(store.listKeys("device:")).resolves.toEqual(["device:device-b"]);
  });

  it("returns undefined for a key that was never written", async () => {
    const store = createSafeStorageSecureStore({
      filePath,
      safeStorage: createFakeSafeStorage()
    });
    await expect(store.getItem("device:missing")).resolves.toBeUndefined();
  });

  it("fails closed when the OS key rotated and old ciphertext is unreadable", async () => {
    const safeStorage = createFakeSafeStorage();
    const store = createSafeStorageSecureStore({ filePath, safeStorage });
    await store.setItem("device:device-1", "token");
    // Simulates a keychain reset: the OS key changed, so the stored value is
    // gone for good. Silently dropping it would hide a required re-bind.
    safeStorage.keyId = "key-2";
    await expect(store.getItem("device:device-1")).rejects.toThrow(
      SecureStoreUnavailableError
    );
  });

  it("fails closed on a decryption error from the OS layer", async () => {
    const safeStorage = createFakeSafeStorage();
    const store = createSafeStorageSecureStore({ filePath, safeStorage });
    await store.setItem("device:device-1", "token");
    safeStorage.failDecrypt = true;
    await expect(store.getItem("device:device-1")).rejects.toThrow(
      /OS key changed/
    );
  });

  it("refuses to start when the store file has an unexpected schema", () => {
    writeFileSync(filePath, JSON.stringify({ version: 1, items: {} }));
    expect(() =>
      createSafeStorageSecureStore({
        filePath,
        safeStorage: createFakeSafeStorage()
      })
    ).toThrow(/unexpected schema/);
  });

  it("refuses to start when the store file is not valid JSON", () => {
    writeFileSync(filePath, "not json at all");
    expect(() =>
      createSafeStorageSecureStore({
        filePath,
        safeStorage: createFakeSafeStorage()
      })
    ).toThrow(/corrupt/);
  });

  it("rejects the same key and value limits as every other backend", async () => {
    const store = createSafeStorageSecureStore({
      filePath,
      safeStorage: createFakeSafeStorage()
    });
    await expect(store.setItem("", "value")).rejects.toThrow(/key/);
    await expect(store.setItem("device-1", "x".repeat(65_537))).rejects.toThrow(
      /value/
    );
  });
});
