import type {
  DeviceBindingStore,
  DeviceCodeRecord,
  DeviceRecord
} from "./index.js";

/**
 * Minimum query interface implemented by pg Pool/Client and the PGlite test
 * adapter used by other Worker-owned stores.
 */
export interface PostgresExecutor {
  query<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: unknown[]
  ): Promise<{ rows: Row[] }>;
}

/** Worker-owned schema applied at startup; idempotent CREATE IF NOT EXISTS. */
export const DEVICE_BINDING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS device_binding_codes (
  code_hash text PRIMARY KEY,
  user_id text NOT NULL,
  email text NOT NULL,
  project_id text NOT NULL,
  project_name text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS device_binding_codes_user_idx
  ON device_binding_codes (user_id, expires_at);

CREATE TABLE IF NOT EXISTS device_binding_devices (
  device_id text PRIMARY KEY,
  user_id text NOT NULL,
  email text NOT NULL,
  project_id text NOT NULL,
  project_name text NOT NULL,
  device_label text NOT NULL,
  platform text NOT NULL,
  access_token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS device_binding_devices_user_idx
  ON device_binding_devices (user_id, last_used_at DESC);
`;

interface CodeRow extends Record<string, unknown> {
  code_hash: string;
  user_id: string;
  email: string;
  project_id: string;
  project_name: string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
}

interface DeviceRow extends Record<string, unknown> {
  device_id: string;
  user_id: string;
  email: string;
  project_id: string;
  project_name: string;
  device_label: string;
  platform: string;
  access_token_hash: string;
  created_at: Date | string;
  last_used_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
}

function toIso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  // pg returns timestamptz as ISO-shaped strings; pass through if already ISO.
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function rowToCode(row: CodeRow): DeviceCodeRecord {
  const expiresAt = toIso(row.expires_at);
  if (!expiresAt) {
    throw new Error("device_binding_codes.expires_at is not a valid timestamp");
  }
  const consumedAt = toIso(row.consumed_at);
  const record: DeviceCodeRecord = {
    codeHash: row.code_hash,
    userId: row.user_id,
    email: row.email,
    projectId: row.project_id,
    projectName: row.project_name,
    expiresAt
  };
  if (consumedAt !== undefined) {
    record.consumedAt = consumedAt;
  }
  return record;
}

function rowToDevice(row: DeviceRow): DeviceRecord {
  const createdAt = toIso(row.created_at);
  const lastUsedAt = toIso(row.last_used_at);
  const expiresAt = toIso(row.expires_at);
  if (!createdAt || !lastUsedAt || !expiresAt) {
    throw new Error("device_binding_devices has an invalid timestamp");
  }
  const revokedAt = toIso(row.revoked_at);
  const record: DeviceRecord = {
    deviceId: row.device_id,
    userId: row.user_id,
    email: row.email,
    projectId: row.project_id,
    projectName: row.project_name,
    deviceLabel: row.device_label,
    platform: row.platform,
    accessTokenHash: row.access_token_hash,
    createdAt,
    lastUsedAt,
    expiresAt
  };
  if (revokedAt !== undefined) {
    record.revokedAt = revokedAt;
  }
  return record;
}

export function createPostgresDeviceBindingStore(
  executor: PostgresExecutor
): DeviceBindingStore {
  return {
    async insertCode(record) {
      await executor.query(
        `INSERT INTO device_binding_codes
           (code_hash, user_id, email, project_id, project_name, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
        [
          record.codeHash,
          record.userId,
          record.email,
          record.projectId,
          record.projectName,
          record.expiresAt
        ]
      );
    },
    async findCode(codeHash) {
      const result = await executor.query<CodeRow>(
        `SELECT code_hash, user_id, email, project_id, project_name,
                expires_at, consumed_at
           FROM device_binding_codes
          WHERE code_hash = $1`,
        [codeHash]
      );
      const row = result.rows[0];
      return row ? rowToCode(row) : undefined;
    },
    async markCodeConsumed(codeHash, consumedAt) {
      await executor.query(
        `UPDATE device_binding_codes
            SET consumed_at = $2::timestamptz
          WHERE code_hash = $1`,
        [codeHash, consumedAt]
      );
    },
    async insertDevice(record) {
      await executor.query(
        `INSERT INTO device_binding_devices
           (device_id, user_id, email, project_id, project_name,
            device_label, platform, access_token_hash,
            created_at, last_used_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::timestamptz)`,
        [
          record.deviceId,
          record.userId,
          record.email,
          record.projectId,
          record.projectName,
          record.deviceLabel,
          record.platform,
          record.accessTokenHash,
          record.createdAt,
          record.lastUsedAt,
          record.expiresAt
        ]
      );
    },
    async findDevice(deviceId) {
      const result = await executor.query<DeviceRow>(
        `SELECT device_id, user_id, email, project_id, project_name,
                device_label, platform, access_token_hash,
                created_at, last_used_at, expires_at, revoked_at
           FROM device_binding_devices
          WHERE device_id = $1`,
        [deviceId]
      );
      const row = result.rows[0];
      return row ? rowToDevice(row) : undefined;
    },
    async findDeviceByAccessTokenHash(accessTokenHash) {
      const result = await executor.query<DeviceRow>(
        `SELECT device_id, user_id, email, project_id, project_name,
                device_label, platform, access_token_hash,
                created_at, last_used_at, expires_at, revoked_at
           FROM device_binding_devices
          WHERE access_token_hash = $1`,
        [accessTokenHash]
      );
      const row = result.rows[0];
      return row ? rowToDevice(row) : undefined;
    },
    async listDevicesForUser(userId) {
      const result = await executor.query<DeviceRow>(
        `SELECT device_id, user_id, email, project_id, project_name,
                device_label, platform, access_token_hash,
                created_at, last_used_at, expires_at, revoked_at
           FROM device_binding_devices
          WHERE user_id = $1
          ORDER BY last_used_at DESC`,
        [userId]
      );
      return result.rows.map(rowToDevice);
    },
    async markDeviceLastUsed(deviceId, lastUsedAt) {
      await executor.query(
        `UPDATE device_binding_devices
            SET last_used_at = $2::timestamptz
          WHERE device_id = $1`,
        [deviceId, lastUsedAt]
      );
    },
    async revokeDevice(deviceId, revokedAt) {
      await executor.query(
        `UPDATE device_binding_devices
            SET revoked_at = $2::timestamptz
          WHERE device_id = $1`,
        [deviceId, revokedAt]
      );
    },
    async countLiveCodesForUser(userId) {
      const result = await executor.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM device_binding_codes
          WHERE user_id = $1
            AND consumed_at IS NULL
            AND expires_at > now()`,
        [userId]
      );
      const row = result.rows[0];
      return row ? Number.parseInt(row.count, 10) : 0;
    }
  };
}