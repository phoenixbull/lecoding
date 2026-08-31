import type { SecureStore } from "./index.js";

/**
 * Minimal subset of the worker-issued exchange credential that the
 * `DeviceCredentialStore` accepts. The shape matches the SDK's
 * `ExchangedDevice`; we re-declare the fields we actually persist so this
 * package does not need to depend on the SDK or the contracts package.
 */
export interface ExchangedDeviceLike {
  deviceId: string;
  accessToken: string;
  userId: string;
  email: string;
  projectId: string;
  projectName: string;
  deviceLabel: string;
  platform: string;
  expiresAt: string;
  createdAt: string;
}

export interface DeviceCredentialStoreOptions {
  /** Underlying SecureStore that persists the JSON-serialised credential. */
  backend: SecureStore;
  /** Key prefix the store uses to keep device credentials distinct from
   *  unrelated secure-store entries. Default `"device:"`. */
  namespace?: string;
}

export interface DeviceCredentialStore {
  save(credential: ExchangedDeviceLike): Promise<void>;
  load(deviceId: string): Promise<ExchangedDeviceLike | undefined>;
  remove(deviceId: string): Promise<void>;
  /** Lists every device id currently persisted under the namespace. */
  list(): Promise<string[]>;
}

const DEVICE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function createDeviceCredentialStore(
  options: DeviceCredentialStoreOptions
): DeviceCredentialStore {
  const namespace = options.namespace ?? "device:";
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new Error("DeviceCredentialStore namespace must be a non-empty string");
  }

  function key(deviceId: string): string {
    return `${namespace}${deviceId}`;
  }

  function parse(raw: string): ExchangedDeviceLike {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("DeviceCredentialStore entry is corrupt JSON");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("DeviceCredentialStore entry is not an object");
    }
    const record = parsed as Partial<ExchangedDeviceLike> & {
      deviceId?: unknown;
    };
    if (
      typeof record.deviceId !== "string" ||
      typeof record.accessToken !== "string" ||
      typeof record.userId !== "string" ||
      typeof record.email !== "string" ||
      typeof record.projectId !== "string" ||
      typeof record.projectName !== "string" ||
      typeof record.deviceLabel !== "string" ||
      typeof record.platform !== "string" ||
      typeof record.expiresAt !== "string" ||
      typeof record.createdAt !== "string"
    ) {
      throw new Error("DeviceCredentialStore entry has missing fields");
    }
    if (Number.isNaN(Date.parse(record.expiresAt))) {
      throw new Error("DeviceCredentialStore entry expiresAt is invalid");
    }
    if (Number.isNaN(Date.parse(record.createdAt))) {
      throw new Error("DeviceCredentialStore entry createdAt is invalid");
    }
    return record as ExchangedDeviceLike;
  }

  return {
    async save(credential) {
      if (
        typeof credential.deviceId !== "string" ||
        !DEVICE_ID_PATTERN.test(credential.deviceId)
      ) {
        throw new Error(
          "DeviceCredentialStore.deviceId must match [A-Za-z0-9_-]+"
        );
      }
      if (Number.isNaN(Date.parse(credential.expiresAt))) {
        throw new Error("DeviceCredentialStore.expiresAt is invalid");
      }
      if (Number.isNaN(Date.parse(credential.createdAt))) {
        throw new Error("DeviceCredentialStore.createdAt is invalid");
      }
      await options.backend.setItem(
        key(credential.deviceId),
        JSON.stringify(credential)
      );
    },
    async load(deviceId) {
      if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) {
        throw new Error(
          "DeviceCredentialStore.load deviceId must match [A-Za-z0-9_-]+"
        );
      }
      const raw = await options.backend.getItem(key(deviceId));
      if (raw === undefined) {
        return undefined;
      }
      const credential = parse(raw);
      if (credential.deviceId !== deviceId) {
        // The store caught a credential that was originally written under a
        // different id; refuse to surface the wrong key rather than silently
        // handing the wrong deviceId to the caller.
        throw new Error(
          "DeviceCredentialStore entry deviceId mismatch with key"
        );
      }
      return credential;
    },
    async remove(deviceId) {
      if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) {
        throw new Error(
          "DeviceCredentialStore.remove deviceId must match [A-Za-z0-9_-]+"
        );
      }
      await options.backend.deleteItem(key(deviceId));
    },
    async list() {
      const keys = await options.backend.listKeys(namespace);
      return keys
        .map((entry) => entry.slice(namespace.length))
        .filter((deviceId) => DEVICE_ID_PATTERN.test(deviceId))
        .sort();
    }
  };
}