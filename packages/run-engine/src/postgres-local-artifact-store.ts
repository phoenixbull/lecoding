import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ArtifactReference } from "@lecoding/contracts";
import type { ArtifactStore } from "./index.js";
import type { PostgresExecutor } from "./postgres-run-lease.js";

/** PostgreSQL metadata schema; command bytes intentionally have no database column. */
export const ARTIFACT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_engine_artifacts (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  project_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('command_stdout', 'command_stderr')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  storage_key text NOT NULL UNIQUE,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  created_at timestamptz NOT NULL
);
`;

const ARTIFACT_RUN_INDEX_SQL = `CREATE INDEX IF NOT EXISTS run_engine_artifacts_run_idx
  ON run_engine_artifacts (run_id, created_at, id);`;

/** Immutable Artifact metadata used by authorized API readers and retention jobs. */
export interface ArtifactMetadata extends ArtifactReference {
  runId: string;
  projectId: string;
  storageKey: string;
  createdAt: string;
}

/** Production Artifact boundary with hash-verifying read seams. */
export interface PostgresLocalArtifactStore extends ArtifactStore {
  get(id: string): Promise<ArtifactMetadata | undefined>;
  read(id: string): Promise<string | undefined>;
  /** Removes an operationally bounded batch and reports every residual path. */
  pruneExpired(input: {
    before: string;
    limit?: number;
  }): Promise<ArtifactPruneResult>;
}

/** Auditable retention result suitable for one fixed structured log record. */
export interface ArtifactPruneResult {
  deletedIds: string[];
  failures: Array<{ id: string; storageKey: string }>;
}

/** Creates a local content store whose PostgreSQL rows contain metadata only. */
export async function createPostgresLocalArtifactStore(
  database: PostgresExecutor,
  options: { root: string; now?: () => string }
): Promise<PostgresLocalArtifactStore> {
  if (resolve(options.root) !== options.root) {
    throw new Error("Artifact root must be an absolute normalized path");
  }
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const root = await realpath(options.root);
  await database.query(ARTIFACT_SCHEMA_SQL);
  await database.query(ARTIFACT_RUN_INDEX_SQL);
  const now = options.now ?? (() => new Date().toISOString());

  const get = async (id: string): Promise<ArtifactMetadata | undefined> => {
    validateIdentifier(id, "Artifact ID");
    const result = await database.query<ArtifactRow>(
      `SELECT id, run_id, project_id, kind, content_hash, storage_key,
              byte_size, created_at
         FROM run_engine_artifacts
        WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  };

  return {
    async write(input) {
      validateIdentifier(input.runId, "Run ID");
      validateIdentifier(input.projectId, "Project ID");
      const bytes = Buffer.from(input.content);
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      const identityHash = createHash("sha256")
        .update(`${input.runId}\0${input.kind}\0${contentHash}`)
        .digest("hex");
      const id = `artifact_${identityHash}`;
      const storageKey = join(
        input.projectId,
        input.runId,
        `${input.kind}-${contentHash}.txt`
      );
      const target = confinedPath(root, storageKey);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      try {
        // Exclusive creation makes exact retry idempotent without replacing evidence.
        await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error;
        }
        const existingHash = createHash("sha256")
          .update(await readFile(target))
          .digest("hex");
        if (existingHash !== contentHash) {
          throw new Error("Existing Artifact content failed its hash check");
        }
      }

      const createdAt = requireTimestamp(now());
      await database.query(
        `INSERT INTO run_engine_artifacts
           (id, run_id, project_id, kind, content_hash, storage_key, byte_size, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        [
          id,
          input.runId,
          input.projectId,
          input.kind,
          contentHash,
          storageKey,
          bytes.byteLength,
          createdAt
        ]
      );
      const metadata = await get(id);
      if (
        !metadata ||
        metadata.runId !== input.runId ||
        metadata.projectId !== input.projectId ||
        metadata.kind !== input.kind ||
        metadata.contentHash !== contentHash ||
        metadata.storageKey !== storageKey ||
        metadata.byteSize !== bytes.byteLength
      ) {
        throw new Error("Artifact metadata changed after persistence");
      }
      return {
        id,
        kind: input.kind,
        contentHash,
        byteSize: bytes.byteLength
      };
    },

    get,

    async read(id) {
      const metadata = await get(id);
      if (!metadata) {
        return undefined;
      }
      const content = await readFile(confinedPath(root, metadata.storageKey));
      const actualHash = createHash("sha256").update(content).digest("hex");
      if (actualHash !== metadata.contentHash) {
        throw new Error("Artifact content failed its hash check");
      }
      return content.toString("utf8");
    },

    async pruneExpired(input) {
      const before = requireTimestamp(input.before);
      const limit = input.limit ?? 1_000;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
        throw new Error("Artifact retention limit must be from 1 to 10000");
      }
      const candidates = await database.query<ArtifactRow>(
        `SELECT id, run_id, project_id, kind, content_hash, storage_key,
                byte_size, created_at
           FROM run_engine_artifacts
          WHERE created_at < $1::timestamptz
          ORDER BY created_at, id
          LIMIT $2::integer`,
        [before, limit]
      );
      const deletedIds: string[] = [];
      const failures: Array<{ id: string; storageKey: string }> = [];
      for (const row of candidates.rows) {
        try {
          await unlink(confinedPath(root, row.storage_key)).catch((error) => {
            if (!isMissing(error)) {
              throw error;
            }
          });
          /* Delete the exact selected row only after bytes are absent, so a failed
           * filesystem cleanup remains discoverable for the next daily retry. */
          await database.query(
            `DELETE FROM run_engine_artifacts
              WHERE id = $1 AND storage_key = $2`,
            [row.id, row.storage_key]
          );
          deletedIds.push(row.id);
        } catch {
          failures.push({ id: row.id, storageKey: row.storage_key });
        }
      }
      return { deletedIds, failures };
    }
  };
}

interface ArtifactRow extends Record<string, unknown> {
  id: string;
  run_id: string;
  project_id: string;
  kind: ArtifactReference["kind"];
  content_hash: string;
  storage_key: string;
  byte_size: string | number;
  created_at: string | Date;
}

function mapRow(row: ArtifactRow): ArtifactMetadata {
  const byteSize = Number(row.byte_size);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw new Error("PostgreSQL returned an invalid Artifact byte size");
  }
  return {
    id: row.id,
    runId: row.run_id,
    projectId: row.project_id,
    kind: row.kind,
    contentHash: row.content_hash,
    storageKey: row.storage_key,
    byteSize,
    createdAt: new Date(row.created_at).toISOString()
  };
}

function confinedPath(root: string, storageKey: string): string {
  const target = resolve(root, storageKey);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error("Artifact storage key escaped its configured root");
  }
  // The relative check rejects platform-specific absolute storage keys as well.
  if (relative(root, target).startsWith("..")) {
    throw new Error("Artifact storage key escaped its configured root");
  }
  return target;
}

function validateIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function requireTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("Artifact clock must return an ISO timestamp");
  }
  return value;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
