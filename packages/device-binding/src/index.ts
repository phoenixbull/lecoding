/**
 * Server-only device binding service.
 *
 * The control plane lets a logged-in browser user mint a one-time code that
 * a headless PC client redeems for a short-lived device credential. The
 * code itself is short (8–12 base32 characters) so it can be typed by hand
 * or copied from a QR code; the credential returned at exchange is a 32-byte
 * random secret that only the client sees in clear text.
 *
 * Storage is abstracted through `DeviceBindingStore` so production can plug
 * in PostgreSQL while tests (and the harness) keep an in-memory adapter.
 * The store owns the durability of codes and devices; the service owns the
 * formatting, validation, and lifetime rules.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";

export {
  createPostgresDeviceBindingStore,
  DEVICE_BINDING_SCHEMA_SQL,
  type PostgresExecutor
} from "./postgres.js";

export {
  createDeviceBindingHttpHandler,
  type DeviceBindingHttpHandler,
  type DeviceBindingHttpOptions,
  type DeviceBindingPrincipal,
  type DeviceBindingPrincipalResolver
} from "./http.js";

/** A code as printed for the user and as accepted back from the device. */
export interface DeviceCodeRecord {
  /** Hash of the code (servers never store the clear text). */
  codeHash: string;
  /** User that minted the code. */
  userId: string;
  email: string;
  projectId: string;
  projectName: string;
  /** ISO-8601 expiry timestamp. */
  expiresAt: string;
  /** Set when the code has been redeemed; consumed codes cannot be replayed. */
  consumedAt?: string;
}

/** A device credential row. */
export interface DeviceRecord {
  deviceId: string;
  userId: string;
  email: string;
  projectId: string;
  projectName: string;
  deviceLabel: string;
  platform: string;
  /** SHA-256 hash of the clear-text access token. */
  accessTokenHash: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  /** Set when the user has revoked the device. */
  revokedAt?: string;
}

/**
 * Storage interface. The in-memory adapter used by tests is exported as
 * `createInMemoryDeviceBindingStore`; production wires the PostgreSQL
 * adapter that ships with the package.
 */
export interface DeviceBindingStore {
  insertCode(record: DeviceCodeRecord): Promise<void>;
  findCode(codeHash: string): Promise<DeviceCodeRecord | undefined>;
  markCodeConsumed(codeHash: string, consumedAt: string): Promise<void>;
  insertDevice(record: DeviceRecord): Promise<void>;
  findDevice(deviceId: string): Promise<DeviceRecord | undefined>;
  findDeviceByAccessTokenHash(
    accessTokenHash: string
  ): Promise<DeviceRecord | undefined>;
  listDevicesForUser(userId: string): Promise<DeviceRecord[]>;
  markDeviceLastUsed(deviceId: string, lastUsedAt: string): Promise<void>;
  revokeDevice(deviceId: string, revokedAt: string): Promise<void>;
  countLiveCodesForUser(userId: string): Promise<number>;
}

export type DeviceBindingErrorCode =
  | "code_unknown"
  | "code_expired"
  | "code_consumed"
  | "device_unknown"
  | "device_expired"
  | "device_revoked"
  | "too_many_codes";

export class DeviceBindingError extends Error {
  readonly code: DeviceBindingErrorCode;

  constructor(code: DeviceBindingErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "DeviceBindingError";
  }
}

export interface DeviceBindingServiceOptions {
  store: DeviceBindingStore;
  now?: () => Date;
  /** Maximum codes a single user may have live at any moment. Default 16. */
  maxLiveCodesPerUser?: number;
  /** TTL applied to issued device credentials. Default 24 hours. */
  deviceTtlMs?: number;
}

export interface IssueCodeInput {
  userId: string;
  email: string;
  projectId: string;
  projectName: string;
  ttlMs?: number;
}

export interface IssuedCode {
  code: string;
  payload: string;
  expiresAt: string;
}

export interface ExchangeCodeInput {
  code: string;
  deviceLabel?: string;
  platform?: string;
}

export interface ExchangedDevice {
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

export interface DeviceView {
  deviceId: string;
  userId: string;
  email: string;
  projectId: string;
  projectName: string;
  deviceLabel: string;
  platform: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export interface AuthenticatedDevice {
  deviceId: string;
  userId: string;
  email: string;
  projectId: string;
  projectName: string;
}

export interface AuthenticateInput {
  accessToken: string;
}

const DEFAULT_MAX_LIVE_CODES = 16;
const DEFAULT_DEVICE_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_CODE_TTL_MS = 10 * 60_000;
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CODE_LENGTH = 9;
const ACCESS_TOKEN_BYTES = 32;

export function createDeviceBindingService(
  options: DeviceBindingServiceOptions
): DeviceBindingService {
  const resolveNow = () => (options.now ? options.now() : new Date());
  const maxLiveCodesPerUser =
    options.maxLiveCodesPerUser ?? DEFAULT_MAX_LIVE_CODES;
  const deviceTtlMs = options.deviceTtlMs ?? DEFAULT_DEVICE_TTL_MS;

  return {
    issueCode(input) {
      return issueCode(options.store, resolveNow, maxLiveCodesPerUser, input);
    },
    exchangeCode(input) {
      return exchangeCode(options.store, resolveNow, deviceTtlMs, input);
    },
    authenticate(input) {
      return authenticate(options.store, resolveNow, input);
    },
    touchDevice(deviceId) {
      return touchDevice(options.store, resolveNow, deviceId);
    },
    revokeDevice(input) {
      return revokeDevice(options.store, resolveNow, input);
    },
    listDevicesForUser(userId) {
      return listDevicesForUser(options.store, userId);
    }
  };
}

export interface DeviceBindingService {
  issueCode(input: IssueCodeInput): Promise<IssuedCode>;
  exchangeCode(input: ExchangeCodeInput): Promise<ExchangedDevice>;
  authenticate(input: AuthenticateInput): Promise<AuthenticatedDevice>;
  touchDevice(deviceId: string): Promise<void>;
  revokeDevice(input: {
    userId: string;
    deviceId: string;
  }): Promise<void>;
  listDevicesForUser(userId: string): Promise<DeviceView[]>;
}

async function issueCode(
  store: DeviceBindingStore,
  now: () => Date,
  maxLiveCodesPerUser: number,
  input: IssueCodeInput
): Promise<IssuedCode> {
  validateIssueInput(input);
  const live = await store.countLiveCodesForUser(input.userId);
  if (live >= maxLiveCodesPerUser) {
    throw new DeviceBindingError(
      "too_many_codes",
      "Too many live device codes for this user"
    );
  }
  const code = generateCode();
  const ttlMs = input.ttlMs ?? DEFAULT_CODE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new DeviceBindingError("too_many_codes", "ttlMs must be positive");
  }
  const expiresAt = new Date(now().getTime() + ttlMs).toISOString();
  await store.insertCode({
    codeHash: hashSecret(code),
    userId: input.userId,
    email: input.email,
    projectId: input.projectId,
    projectName: input.projectName,
    expiresAt
  });
  const payload = `lecoding://device-binding?code=${code}&project=${encodeURIComponent(
    input.projectId
  )}`;
  return { code, payload, expiresAt };
}

async function exchangeCode(
  store: DeviceBindingStore,
  now: () => Date,
  deviceTtlMs: number,
  input: ExchangeCodeInput
): Promise<ExchangedDevice> {
  if (typeof input.code !== "string" || input.code.trim().length === 0) {
    throw new DeviceBindingError("code_unknown", "Device code is missing");
  }
  const codeHash = hashSecret(input.code);
  const record = await store.findCode(codeHash);
  if (!record) {
    throw new DeviceBindingError("code_unknown", "Device code is unknown");
  }
  if (record.consumedAt !== undefined) {
    throw new DeviceBindingError("code_consumed", "Device code already used");
  }
  const expiresMs = Date.parse(record.expiresAt);
  const nowMs = now().getTime();
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
    throw new DeviceBindingError("code_expired", "Device code has expired");
  }
  const accessToken = generateAccessToken();
  const deviceId = randomUUID();
  const createdAt = now().toISOString();
  const expiresAt = new Date(now().getTime() + deviceTtlMs).toISOString();
  const device: DeviceRecord = {
    deviceId,
    userId: record.userId,
    email: record.email,
    projectId: record.projectId,
    projectName: record.projectName,
    deviceLabel: sanitiseLabel(input.deviceLabel),
    platform: sanitisePlatform(input.platform),
    accessTokenHash: hashSecret(accessToken),
    createdAt,
    lastUsedAt: createdAt,
    expiresAt
  };
  await store.markCodeConsumed(codeHash, createdAt);
  await store.insertDevice(device);
  return {
    deviceId,
    accessToken,
    userId: device.userId,
    email: device.email,
    projectId: device.projectId,
    projectName: device.projectName,
    deviceLabel: device.deviceLabel,
    platform: device.platform,
    expiresAt: device.expiresAt,
    createdAt: device.createdAt
  };
}

async function authenticate(
  store: DeviceBindingStore,
  now: () => Date,
  input: AuthenticateInput
): Promise<AuthenticatedDevice> {
  if (typeof input.accessToken !== "string" || input.accessToken.length === 0) {
    throw new DeviceBindingError("device_unknown", "Device token missing");
  }
  const record = await store.findDeviceByAccessTokenHash(
    hashSecret(input.accessToken)
  );
  if (!record || record.revokedAt !== undefined) {
    throw new DeviceBindingError("device_unknown", "Device token invalid");
  }
  if (Date.parse(record.expiresAt) <= now().getTime()) {
    throw new DeviceBindingError("device_expired", "Device token expired");
  }
  return {
    deviceId: record.deviceId,
    userId: record.userId,
    email: record.email,
    projectId: record.projectId,
    projectName: record.projectName
  };
}

async function touchDevice(
  store: DeviceBindingStore,
  now: () => Date,
  deviceId: string
): Promise<void> {
  const record = await store.findDevice(deviceId);
  if (!record || record.revokedAt !== undefined) {
    throw new DeviceBindingError("device_unknown", "Device unknown");
  }
  await store.markDeviceLastUsed(deviceId, now().toISOString());
}

async function revokeDevice(
  store: DeviceBindingStore,
  now: () => Date,
  input: { userId: string; deviceId: string }
): Promise<void> {
  const record = await store.findDevice(input.deviceId);
  if (!record || record.userId !== input.userId) {
    throw new DeviceBindingError("device_unknown", "Device unknown");
  }
  await store.revokeDevice(input.deviceId, now().toISOString());
}

async function listDevicesForUser(
  store: DeviceBindingStore,
  userId: string
): Promise<DeviceView[]> {
  const records = await store.listDevicesForUser(userId);
  return records
    .filter((record) => record.revokedAt === undefined)
    .map(toDeviceView)
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

function toDeviceView(record: DeviceRecord): DeviceView {
  return {
    deviceId: record.deviceId,
    userId: record.userId,
    email: record.email,
    projectId: record.projectId,
    projectName: record.projectName,
    deviceLabel: record.deviceLabel,
    platform: record.platform,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt
  };
}

function validateIssueInput(input: IssueCodeInput): void {
  if (
    typeof input.userId !== "string" ||
    typeof input.email !== "string" ||
    typeof input.projectId !== "string" ||
    typeof input.projectName !== "string"
  ) {
    throw new DeviceBindingError("code_unknown", "Code issuance inputs invalid");
  }
}

function generateCode(): string {
  // Base32 without confusing characters; deterministic length for typing.
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function generateAccessToken(): string {
  return randomBytes(ACCESS_TOKEN_BYTES).toString("hex");
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function sanitiseLabel(value: string | undefined): string {
  const fallback = "Unnamed device";
  if (typeof value !== "string") {
    return fallback;
  }
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 64);
  return cleaned.length === 0 ? fallback : cleaned;
}

function sanitisePlatform(value: string | undefined): string {
  if (typeof value !== "string") {
    return "unknown";
  }
  const trimmed = value.trim().toLowerCase().slice(0, 32);
  return trimmed.length === 0 ? "unknown" : trimmed;
}

export function createInMemoryDeviceBindingStore(): DeviceBindingStore {
  const codes = new Map<string, DeviceCodeRecord>();
  const devices = new Map<string, DeviceRecord>();
  const tokenIndex = new Map<string, string>();

  function purgeExpired(now: () => Date): void {
    const cutoff = now().getTime();
    for (const [hash, record] of codes) {
      if (Date.parse(record.expiresAt) <= cutoff) {
        codes.delete(hash);
      }
    }
  }

  return {
    async insertCode(record) {
      codes.set(record.codeHash, record);
    },
    async findCode(codeHash) {
      return codes.get(codeHash);
    },
    async markCodeConsumed(codeHash, consumedAt) {
      const record = codes.get(codeHash);
      if (!record) {
        return;
      }
      record.consumedAt = consumedAt;
      codes.set(codeHash, record);
    },
    async insertDevice(record) {
      devices.set(record.deviceId, record);
      tokenIndex.set(record.accessTokenHash, record.deviceId);
    },
    async findDevice(deviceId) {
      return devices.get(deviceId);
    },
    async findDeviceByAccessTokenHash(accessTokenHash) {
      const deviceId = tokenIndex.get(accessTokenHash);
      if (!deviceId) {
        return undefined;
      }
      return devices.get(deviceId);
    },
    async listDevicesForUser(userId) {
      const out: DeviceRecord[] = [];
      for (const record of devices.values()) {
        if (record.userId === userId) {
          out.push(record);
        }
      }
      return out;
    },
    async markDeviceLastUsed(deviceId, lastUsedAt) {
      const record = devices.get(deviceId);
      if (!record) {
        return;
      }
      record.lastUsedAt = lastUsedAt;
      devices.set(deviceId, record);
    },
    async revokeDevice(deviceId, revokedAt) {
      const record = devices.get(deviceId);
      if (!record) {
        return;
      }
      record.revokedAt = revokedAt;
      devices.set(deviceId, record);
    },
    async countLiveCodesForUser(userId) {
      const now = new Date();
      purgeExpired(() => now);
      let count = 0;
      for (const record of codes.values()) {
        if (record.userId === userId && record.consumedAt === undefined) {
          count += 1;
        }
      }
      return count;
    }
  };
}