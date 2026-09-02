import type {
  CodeReservation,
  DeviceBindingStore,
  DeviceCodeRecord,
  DeviceRecord,
  ReserveCodeSlotOptions,
  ReserveCodeSlotResult
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

CREATE OR REPLACE FUNCTION lecoding_reserve_device_binding_code(
  p_code_hash text,
  p_user_id text,
  p_email text,
  p_project_id text,
  p_project_name text,
  p_now timestamptz,
  p_expires_at timestamptz,
  p_max_live_codes integer
) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize reservations for one user. READ COMMITTED takes a fresh
  -- snapshot after this lock is acquired, so a waiter observes the row
  -- committed by the previous holder before applying the capacity gate.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('lecoding:device-binding:code:' || p_user_id, 0)
  );

  IF (
    SELECT count(*) FROM device_binding_codes
     WHERE user_id = p_user_id
       AND consumed_at IS NULL
       AND expires_at > p_now
  ) >= p_max_live_codes THEN
    RETURN 'too_many_codes';
  END IF;

  BEGIN
    INSERT INTO device_binding_codes
      (code_hash, user_id, email, project_id, project_name, expires_at)
    VALUES
      (p_code_hash, p_user_id, p_email, p_project_id, p_project_name, p_expires_at);
  EXCEPTION WHEN unique_violation THEN
    RETURN 'code_hash_conflict';
  END;

  RETURN 'reserved';
END;
$$;

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

interface ReservationStatusRow extends Record<string, unknown> {
  status: "reserved" | "too_many_codes" | "code_hash_conflict";
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

/** Creates a PostgreSQL-backed store; callers must apply the exported schema first. */
export function createPostgresDeviceBindingStore(
  executor: PostgresExecutor
): DeviceBindingStore {
  return {
    async reserveCodeSlot(candidate, options): Promise<ReserveCodeSlotResult> {
      // The database function owns the per-user transaction lock and the
      // insert. This is stronger than a count-and-insert statement under
      // MVCC, where concurrent statements can all observe the same stale
      // count. Expiry still comes from the caller-injected clock.
      const suppliedNow = options.now.toISOString();
      const expiresAt = new Date(
        options.now.getTime() + options.ttlMs
      ).toISOString();
      const result = await executor.query<ReservationStatusRow>(
        `SELECT lecoding_reserve_device_binding_code(
           $1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8
         ) AS status`,
        [
          candidate.codeHash,
          candidate.userId,
          candidate.email,
          candidate.projectId,
          candidate.projectName,
          suppliedNow,
          expiresAt,
          options.maxLiveCodesPerUser
        ]
      );
      const status = result.rows[0]?.status;
      if (status === "reserved") {
        const reservation: CodeReservation = {
          codeHash: candidate.codeHash,
          userId: candidate.userId,
          email: candidate.email,
          projectId: candidate.projectId,
          projectName: candidate.projectName,
          expiresAt
        };
        return { ok: true, reservation };
      }
      if (status === "too_many_codes" || status === "code_hash_conflict") {
        return { ok: false, reason: status };
      }
      throw new Error("device binding reservation returned an unknown status");
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
    }
  };
}
