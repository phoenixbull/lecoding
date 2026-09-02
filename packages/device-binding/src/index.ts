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
 *
 * M0.1 hardening: codes are generated from `node:crypto.randomBytes` (never
 * `Math.random`), the live-code budget is enforced inside the store as a
 * single atomic operation so concurrent issuers cannot exceed it, and all
 * expiry decisions flow through the service-injected clock.
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
 *
 * `reserveCodeSlot` is the single atomic seam used by the service for both
 * "is the user under the live-code budget?" and "insert this code". A
 * concurrent caller cannot exceed `maxLiveCodesPerUser` because the budget
 * check and the write happen inside the same storage operation; the
 * returned slot owns its expiry deadline so the storage layer never has to
 * reach for an internal wall clock.
 */
/** Candidate identity persisted when the store successfully reserves a code slot. */
export interface CodeReservationCandidate {
  codeHash: string;
  userId: string;
  email: string;
  projectId: string;
  projectName: string;
}

/** A successful candidate plus the exact caller-derived expiry deadline. */
export interface CodeReservation extends CodeReservationCandidate {
  expiresAt: string;
}

/** Limits and clock snapshot used by an atomic code-slot reservation. */
export interface ReserveCodeSlotOptions {
  /** Upper bound on currently-valid (not expired, not consumed) codes. */
  maxLiveCodesPerUser: number;
  /** Snapshot of "now" — the store must not fall back to `new Date()`. */
  now: Date;
  /** TTL for the freshly minted code in milliseconds. */
  ttlMs: number;
}

/** Returned by `reserveCodeSlot`; the service decides what to do next. */
export type ReserveCodeSlotResult =
  | { ok: true; reservation: CodeReservation }
  | { ok: false; reason: "too_many_codes" | "code_hash_conflict" };

export interface DeviceBindingStore {
  /**
   * Atomically checks the live-code budget and inserts the row.
   * Storage implementations must roll back on hash conflict and surface a
   * deterministic reason so the service can retry with a fresh code.
   */
  reserveCodeSlot(
    candidate: CodeReservationCandidate,
    options: ReserveCodeSlotOptions
  ): Promise<ReserveCodeSlotResult>;
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
}

export type DeviceBindingErrorCode =
  | "code_unknown"
  | "code_expired"
  | "code_consumed"
  | "device_unknown"
  | "device_expired"
  | "device_revoked"
  | "too_many_codes"
  | "code_collision_exhausted";

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
  /**
   * Maximum number of times the service will retry code generation if a
   * freshly minted value collides with an existing row. Default 4.
   */
  maxCodeGenerationRetries?: number;
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
const DEFAULT_CODE_GEN_RETRIES = 4;
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CODE_LENGTH = 9;
const ACCESS_TOKEN_BYTES = 32;

/** Creates the service while keeping time, limits, and persistence injectable. */
export function createDeviceBindingService(
  options: DeviceBindingServiceOptions
): DeviceBindingService {
  const resolveNow = () => (options.now ? options.now() : new Date());
  const maxLiveCodesPerUser =
    options.maxLiveCodesPerUser ?? DEFAULT_MAX_LIVE_CODES;
  const deviceTtlMs = options.deviceTtlMs ?? DEFAULT_DEVICE_TTL_MS;
  const maxCodeGenerationRetries =
    options.maxCodeGenerationRetries ?? DEFAULT_CODE_GEN_RETRIES;

  return {
    issueCode(input) {
      return issueCode(
        options.store,
        resolveNow,
        maxLiveCodesPerUser,
        maxCodeGenerationRetries,
        input
      );
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
  maxCodeGenerationRetries: number,
  input: IssueCodeInput
): Promise<IssuedCode> {
  validateIssueInput(input);
  const ttlMs = input.ttlMs ?? DEFAULT_CODE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new DeviceBindingError("too_many_codes", "ttlMs must be positive");
  }
  // The store decides whether the budget allows a new slot; we only need to
  // retry when the candidate hash collides with a pre-existing row. The
  // budget check and insert are atomic inside the store so concurrent
  // issuers cannot collectively exceed `maxLiveCodesPerUser`.
  for (let attempt = 0; attempt <= maxCodeGenerationRetries; attempt += 1) {
    const code = generateCode();
    const result = await store.reserveCodeSlot(
      {
        codeHash: hashSecret(code),
        userId: input.userId,
        email: input.email,
        projectId: input.projectId,
        projectName: input.projectName
      },
      {
        maxLiveCodesPerUser,
        now: now(),
        ttlMs
      }
    );
    if (result.ok) {
      const payload = `lecoding://device-binding?code=${code}&project=${encodeURIComponent(
        input.projectId
      )}`;
      return {
        code,
        payload,
        expiresAt: result.reservation.expiresAt
      };
    }
    if (result.reason === "too_many_codes") {
      throw new DeviceBindingError(
        "too_many_codes",
        "Too many live device codes for this user"
      );
    }
    // result.reason === "code_hash_conflict": retry with a fresh code.
  }
  throw new DeviceBindingError(
    "code_collision_exhausted",
    "Could not generate a unique device code after retries"
  );
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
  // 5 bits per base32 char × 9 chars = 45 bits of entropy, drawn from a
  // CSPRNG. `Math.random()` is not safe for security tokens.
  const out: string[] = [];
  const bytes = randomBytes(CODE_LENGTH);
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    // Mask off any high bits so each byte selects uniformly from the 32
    // character alphabet even though 256 % 32 !== 0.
    const alphabetIndex = (bytes[index] ?? 0) & 31;
    out.push(CODE_ALPHABET.charAt(alphabetIndex));
  }
  return out.join("");
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

/** Creates a process-local store whose reservation seam is synchronously atomic. */
export function createInMemoryDeviceBindingStore(): DeviceBindingStore {
  // `now` is provided by the service on every call so we never reach for
  // `new Date()` from inside the store. Concurrent calls in tests are
  // serialised by the JS event loop, but the implementation must still
  // behave atomically with respect to `reserveCodeSlot`.
  const codes = new Map<string, DeviceCodeRecord>();
  const devices = new Map<string, DeviceRecord>();
  const tokenIndex = new Map<string, string>();

  function isLive(record: DeviceCodeRecord, now: Date): boolean {
    if (record.consumedAt !== undefined) {
      return false;
    }
    const expiresMs = Date.parse(record.expiresAt);
    return Number.isFinite(expiresMs) && expiresMs > now.getTime();
  }

  function liveCountFor(userId: string, now: Date): number {
    let count = 0;
    for (const record of codes.values()) {
      if (record.userId === userId && isLive(record, now)) {
        count += 1;
      }
    }
    return count;
  }

  return {
    async reserveCodeSlot(candidate, options) {
      // Atomic with respect to JS callers because we never yield control
      // between the budget check and the insert. The hash map's primary-key
      // semantics guarantee the unique-constraint contract.
      if (codes.has(candidate.codeHash)) {
        return { ok: false, reason: "code_hash_conflict" };
      }
      if (liveCountFor(candidate.userId, options.now) >= options.maxLiveCodesPerUser) {
        return { ok: false, reason: "too_many_codes" };
      }
      const expiresAt = new Date(options.now.getTime() + options.ttlMs).toISOString();
      codes.set(candidate.codeHash, {
        codeHash: candidate.codeHash,
        userId: candidate.userId,
        email: candidate.email,
        projectId: candidate.projectId,
        projectName: candidate.projectName,
        expiresAt
      });
      return {
        ok: true,
        reservation: {
          codeHash: candidate.codeHash,
          userId: candidate.userId,
          email: candidate.email,
          projectId: candidate.projectId,
          projectName: candidate.projectName,
          expiresAt
        }
      };
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
    }
  };
}
