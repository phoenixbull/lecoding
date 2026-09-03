import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createDeviceCredentialStore,
  type SafeStorageLike
} from "@lecoding/secure-store";
import { createDesktopCredentialStore } from "../src/main/secure-store-factory.js";

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

/** A device credential as the Worker's exchange endpoint returns it. */
function makeCredential(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: "device-1",
    accessToken: "device-access-token",
    userId: "user-1",
    email: "agent@example.com",
    projectId: "project-a",
    projectName: "Project A",
    deviceLabel: "office-mac",
    platform: "darwin",
    expiresAt: "2999-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("createDesktopCredentialStore", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "lecoding-desktop-credentials-"));
  });

  it("reports the keychain backend when the OS key is available", async () => {
    const store = await createDesktopCredentialStore({
      userDataPath,
      safeStorage: createFakeSafeStorage()
    });
    const status = await store.status();
    expect(status?.backend).toBe("safeStorage");
    expect(status?.degraded).toBe(false);
    // No device bound yet, so no identity is reported either.
    expect(status?.deviceId).toBeUndefined();
  });

  it("reports an explicit degradation when the keychain is unavailable", async () => {
    const store = await createDesktopCredentialStore({
      userDataPath,
      safeStorage: createFakeSafeStorage(false)
    });
    const status = await store.status();
    expect(status?.backend).toBe("encryptedFile");
    expect(status?.degraded).toBe(true);
    expect(status?.reason).toContain("系统安全存储不可用");
  });

  it("persists a credential and reports its identity without the token", async () => {
    const store = await createDesktopCredentialStore({
      userDataPath,
      safeStorage: createFakeSafeStorage()
    });
    // The client SDK persists exchanges through this very backend, so the
    // handle has to expose it rather than keep a private instance.
    await createDeviceCredentialStore({ backend: store.store }).save(
      makeCredential()
    );

    const status = await store.status();
    expect(status?.deviceId).toBe("device-1");
    expect(status?.expiresAt).toBe("2999-01-01T00:00:00.000Z");
    // The access token must never appear in anything the Renderer receives.
    expect(JSON.stringify(status)).not.toContain("device-access-token");
  });

  it("flags an expired credential instead of leaving a dead session", async () => {
    const store = await createDesktopCredentialStore({
      userDataPath,
      safeStorage: createFakeSafeStorage()
    });
    await createDeviceCredentialStore({ backend: store.store }).save(
      makeCredential({ expiresAt: "2020-01-01T00:00:00.000Z" })
    );

    const status = await store.status();
    expect(status?.degraded).toBe(true);
    expect(status?.reason).toContain("已过期");
  });

  it("purges an expired credential so it cannot be reused after a restart", async () => {
    const store = await createDesktopCredentialStore({
      userDataPath,
      safeStorage: createFakeSafeStorage()
    });
    const credentials = createDeviceCredentialStore({ backend: store.store });
    await credentials.save(makeCredential({ expiresAt: "2020-01-01T00:00:00.000Z" }));

    await store.purgeExpired();
    await expect(credentials.list()).resolves.toEqual([]);
  });

  it("keeps a valid credential when purging", async () => {
    const store = await createDesktopCredentialStore({
      userDataPath,
      safeStorage: createFakeSafeStorage()
    });
    const credentials = createDeviceCredentialStore({ backend: store.store });
    await credentials.save(makeCredential());

    await store.purgeExpired();
    await expect(credentials.list()).resolves.toEqual(["device-1"]);
  });

  it("fails closed when the OS key can no longer decrypt a stored credential", async () => {
    const safeStorage = createFakeSafeStorage();
    const store = await createDesktopCredentialStore({ userDataPath, safeStorage });
    await createDeviceCredentialStore({ backend: store.store }).save(makeCredential());
    safeStorage.keyId = "rotated-key";

    await expect(store.status()).rejects.toThrow(/decrypt|解密|credential/i);
    await expect(store.purgeExpired()).rejects.toThrow(/decrypt|解密|credential/i);
  });

  it("clears every credential on logout", async () => {
    const store = await createDesktopCredentialStore({
      userDataPath,
      safeStorage: createFakeSafeStorage()
    });
    const credentials = createDeviceCredentialStore({ backend: store.store });
    await credentials.save(makeCredential());

    await store.clear();
    await expect(credentials.list()).resolves.toEqual([]);
  });

  it("keeps every credential file inside the user data directory", async () => {
    const store = await createDesktopCredentialStore({
      userDataPath,
      safeStorage: createFakeSafeStorage()
    });
    await createDeviceCredentialStore({ backend: store.store }).save(
      makeCredential()
    );
    const files = readdirSync(join(userDataPath, "credentials")).sort();
    // The degraded backend's key file exists up-front; the ciphertext file
    // appears on first write. Either way nothing escapes userData.
    expect(files).toContain("fallback.key");
    expect(files).toContain("keychain.json");
  });
});
