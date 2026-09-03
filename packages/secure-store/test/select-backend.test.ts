import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSecureStoreNamespace,
  createEncryptedFileSecureStore,
  SecureStoreUnavailableError,
  selectSecureStore,
  type SafeStorageLike
} from "../src/index.js";

const PASSPHRASE = "fallback-passphrase";

function createFakeSafeStorage(available = true): SafeStorageLike & {
  available: boolean;
  keyId: string;
} {
  return {
    available,
    keyId: "key-1",
    isEncryptionAvailable() {
      return this.available;
    },
    encryptString(plaintext: string) {
      return Buffer.from(`${this.keyId}|${plaintext}`, "utf8");
    },
    decryptString(encrypted: Buffer) {
      const text = encrypted.toString("utf8");
      const separator = text.indexOf("|");
      if (text.slice(0, separator) !== this.keyId) {
        throw new Error("decryption failed");
      }
      return text.slice(separator + 1);
    }
  };
}

describe("selectSecureStore", () => {
  let root: string;
  let safeStorageFilePath: string;
  let fallbackFilePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lecoding-select-backend-"));
    safeStorageFilePath = join(root, "keychain.json");
    fallbackFilePath = join(root, "fallback.json");
  });

  it("selects the OS keychain when it is available", async () => {
    const { store, health } = await selectSecureStore({
      safeStorageFilePath,
      fallbackFilePath,
      fallbackPassphrase: PASSPHRASE,
      safeStorage: createFakeSafeStorage()
    });
    expect(health).toEqual({ backend: "safeStorage", degraded: false });
    await store.setItem("device:device-1", "token");
    // The keychain file proves which backend actually holds the credential.
    expect(existsSync(safeStorageFilePath)).toBe(true);
  });

  it("degrades to the encrypted file and reports why", async () => {
    const { health } = await selectSecureStore({
      safeStorageFilePath,
      fallbackFilePath,
      fallbackPassphrase: PASSPHRASE,
      safeStorage: createFakeSafeStorage(false)
    });
    expect(health.backend).toBe("encryptedFile");
    expect(health.degraded).toBe(true);
    expect(health.reason).toContain("系统安全存储不可用");
  });

  it("degrades when no safeStorage is injected at all", async () => {
    const { health } = await selectSecureStore({
      safeStorageFilePath,
      fallbackFilePath,
      fallbackPassphrase: PASSPHRASE
    });
    expect(health).toEqual({
      backend: "encryptedFile",
      degraded: true,
      reason: "系统安全存储不可用，已降级为加密文件"
    });
  });

  it("never degrades silently to an in-memory store", async () => {
    const { store } = await selectSecureStore({
      safeStorageFilePath,
      fallbackFilePath,
      fallbackPassphrase: PASSPHRASE,
      safeStorage: createFakeSafeStorage(false)
    });
    await store.setItem("device:device-1", "token");
    // A memory backend would lose the credential on quit while looking
    // identical to a healthy session, so it must never be selected.
    expect(existsSync(fallbackFilePath)).toBe(true);
  });

  it("refuses to start when the keychain changed and stored credentials are unreadable", async () => {
    const safeStorage = createFakeSafeStorage();
    const first = await selectSecureStore({
      safeStorageFilePath,
      fallbackFilePath,
      fallbackPassphrase: PASSPHRASE,
      safeStorage
    });
    await first.store.setItem("device:device-1", "token");

    safeStorage.keyId = "key-2";
    await expect(
      selectSecureStore({
        safeStorageFilePath,
        fallbackFilePath,
        fallbackPassphrase: PASSPHRASE,
        safeStorage
      })
    ).rejects.toThrow(SecureStoreUnavailableError);
  });

  it("fails closed when the keychain file itself is corrupt", async () => {
    writeFileSync(safeStorageFilePath, "{ not json");
    await expect(
      selectSecureStore({
        safeStorageFilePath,
        fallbackFilePath,
        fallbackPassphrase: PASSPHRASE,
        safeStorage: createFakeSafeStorage()
      })
    ).rejects.toThrow(/无法读取已保存的凭据/);
  });

  it("migrates credentials from the fallback file once the keychain appears", async () => {
    // Seed the weaker backend: this is what a first launch without a
    // keychain (or a locked session) leaves behind.
    const fallback = createEncryptedFileSecureStore({
      filePath: fallbackFilePath,
      passphrase: PASSPHRASE,
      pbkdf2Iterations: 1
    });
    await fallback.setItem("device:device-1", "migrated-token");

    const { store, health } = await selectSecureStore({
      safeStorageFilePath,
      fallbackFilePath,
      fallbackPassphrase: PASSPHRASE,
      safeStorage: createFakeSafeStorage()
    });
    expect(health.backend).toBe("safeStorage");
    await expect(store.getItem("device:device-1")).resolves.toBe("migrated-token");
    // The weaker copy is removed once every entry survived the move. Re-read
    // from disk: the seeding store above still holds a stale in-memory copy.
    // Opening without `pbkdf2Iterations` also proves the recorded KDF cost is
    // honoured instead of the default.
    const reloaded = createEncryptedFileSecureStore({
      filePath: fallbackFilePath,
      passphrase: PASSPHRASE
    });
    await expect(reloaded.getItem("device:device-1")).resolves.toBeUndefined();
  });

  it("keeps the fallback file when a migration cannot be completed", async () => {
    const fallback = createEncryptedFileSecureStore({
      filePath: fallbackFilePath,
      passphrase: PASSPHRASE,
      pbkdf2Iterations: 1
    });
    await fallback.setItem("device:device-1", "migrated-token");

    const safeStorage = createFakeSafeStorage();
    // Rotating mid-write makes the second entry impossible to re-encrypt, so
    // the migration must abort rather than half-move the credential.
    const throwing: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plaintext: string) => {
        if (safeStorage.encryptString(plaintext).length > 0) {
          throw new Error("keychain write failed");
        }
        return Buffer.from("unreachable");
      },
      decryptString: (encrypted: Buffer) => safeStorage.decryptString(encrypted)
    };
    await expect(
      selectSecureStore({
        safeStorageFilePath,
        fallbackFilePath,
        fallbackPassphrase: PASSPHRASE,
        safeStorage: throwing
      })
    ).rejects.toThrow(/迁移失败/);
    // Losing the only readable copy would strand the user without credentials.
    await expect(fallback.getItem("device:device-1")).resolves.toBe(
      "migrated-token"
    );
  });

  it("does not overwrite credentials the keychain already holds", async () => {
    const fallback = createEncryptedFileSecureStore({
      filePath: fallbackFilePath,
      passphrase: PASSPHRASE,
      pbkdf2Iterations: 1
    });
    await fallback.setItem("device:device-1", "stale-token");

    const first = await selectSecureStore({
      safeStorageFilePath,
      fallbackFilePath,
      fallbackPassphrase: PASSPHRASE,
      safeStorage: createFakeSafeStorage()
    });
    await first.store.setItem("device:device-1", "authoritative-token");

    const second = await selectSecureStore({
      safeStorageFilePath,
      fallbackFilePath,
      fallbackPassphrase: PASSPHRASE,
      safeStorage: createFakeSafeStorage()
    });
    await expect(second.store.getItem("device:device-1")).resolves.toBe(
      "authoritative-token"
    );
  });
});

describe("clearSecureStoreNamespace", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lecoding-clear-namespace-"));
  });

  it("removes every credential under the namespace and nothing else", async () => {
    const store = createEncryptedFileSecureStore({
      filePath: join(root, "secrets.json"),
      passphrase: PASSPHRASE,
      pbkdf2Iterations: 1
    });
    await store.setItem("device:device-a", "a");
    await store.setItem("device:device-b", "b");
    await store.setItem("session:csrf", "keep-me");

    await clearSecureStoreNamespace(store, "device:");
    await expect(store.listKeys("device:")).resolves.toEqual([]);
    await expect(store.getItem("session:csrf")).resolves.toBe("keep-me");
  });

  it("is a no-op when the namespace holds nothing", async () => {
    const store = createEncryptedFileSecureStore({
      filePath: join(root, "empty.json"),
      passphrase: PASSPHRASE,
      pbkdf2Iterations: 1
    });
    await expect(clearSecureStoreNamespace(store, "device:")).resolves.toBeUndefined();
  });
});
