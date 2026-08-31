import { describe, expect, it } from "vitest";
import {
  createInMemorySecureStore,
  createDeviceCredentialStore,
  type ExchangedDeviceLike
} from "../src/index.js";

function makeCredential(overrides: Partial<ExchangedDeviceLike> = {}): ExchangedDeviceLike {
  return {
    deviceId: "device-1",
    accessToken: "x".repeat(64),
    userId: "user-1",
    email: "alice@example.com",
    projectId: "project-1",
    projectName: "Project One",
    deviceLabel: "Alice's laptop",
    platform: "darwin",
    expiresAt: "2026-09-01T10:00:00.000Z",
    createdAt: "2026-08-31T10:00:00.000Z",
    ...overrides
  };
}

describe("createDeviceCredentialStore", () => {
  it("saves and reloads a device credential", async () => {
    const backend = createInMemorySecureStore();
    const store = createDeviceCredentialStore({ backend });
    await store.save(makeCredential({ deviceId: "device-a" }));
    const loaded = await store.load("device-a");
    expect(loaded?.deviceId).toBe("device-a");
  });

  it("returns undefined for an unknown device", async () => {
    const store = createDeviceCredentialStore({
      backend: createInMemorySecureStore()
    });
    await expect(store.load("never")).resolves.toBeUndefined();
  });

  it("forgets a device through remove()", async () => {
    const backend = createInMemorySecureStore();
    const store = createDeviceCredentialStore({ backend });
    await store.save(makeCredential({ deviceId: "device-a" }));
    await store.remove("device-a");
    await expect(store.load("device-a")).resolves.toBeUndefined();
  });

  it("remove() is idempotent", async () => {
    const store = createDeviceCredentialStore({
      backend: createInMemorySecureStore()
    });
    await expect(store.remove("never")).resolves.toBeUndefined();
  });

  it("lists every persisted device key", async () => {
    const backend = createInMemorySecureStore();
    const store = createDeviceCredentialStore({
      backend,
      namespace: "device:"
    });
    await store.save(makeCredential({ deviceId: "device-a" }));
    await store.save(makeCredential({ deviceId: "device-b" }));
    const ids = await store.list();
    expect(ids.sort()).toEqual(["device-a", "device-b"]);
  });

  it("scopes listKeys through the configured namespace", async () => {
    const backend = createInMemorySecureStore();
    await backend.setItem("unrelated", "noise");
    const store = createDeviceCredentialStore({
      backend,
      namespace: "device:"
    });
    await store.save(makeCredential({ deviceId: "device-a" }));
    const ids = await store.list();
    expect(ids).toEqual(["device-a"]);
  });

  it("refuses to save an empty deviceId", async () => {
    const store = createDeviceCredentialStore({
      backend: createInMemorySecureStore()
    });
    await expect(store.save(makeCredential({ deviceId: "" }))).rejects.toThrow(
      /deviceId/
    );
  });

  it("refuses to load an empty deviceId", async () => {
    const store = createDeviceCredentialStore({
      backend: createInMemorySecureStore()
    });
    await expect(store.load("")).rejects.toThrow(/deviceId/);
  });

  it("rejects credentials that contain an invalid expiresAt", async () => {
    const store = createDeviceCredentialStore({
      backend: createInMemorySecureStore()
    });
    await expect(
      store.save(
        makeCredential({ deviceId: "device-a", expiresAt: "not-a-date" })
      )
    ).rejects.toThrow(/expiresAt/);
  });

  it("throws when the stored JSON is corrupt", async () => {
    const backend = createInMemorySecureStore();
    await backend.setItem("device:device-a", "this is not json");
    const store = createDeviceCredentialStore({ backend });
    await expect(store.load("device-a")).rejects.toThrow(/corrupt/);
  });

  it("rejects a credential whose deviceId does not match the key", async () => {
    const backend = createInMemorySecureStore();
    await backend.setItem(
      "device:device-a",
      JSON.stringify(makeCredential({ deviceId: "device-b" }))
    );
    const store = createDeviceCredentialStore({ backend });
    await expect(store.load("device-a")).rejects.toThrow(/mismatch/);
  });
});