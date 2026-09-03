import { createHash, randomBytes } from "node:crypto";
import type { PostgresExecutor } from "@lecoding/run-engine";
import type {
  RunApiAccessControl,
  RunApiPrincipal,
  RunApiProjectMembership,
  RunApiProjectRole
} from "./api.js";

/** Stable user attributes accepted only from the trusted login callback. */
export interface ProvisionUserInput {
  id: string;
  email: string;
  providerAccountId: string;
}

/** Administrator-owned project metadata associated with repository registration. */
export interface ProvisionProjectInput {
  id: string;
  name: string;
  repository: string;
  defaultBranch: string;
}

/** Exact membership assignment; absence of a row means no project visibility. */
export interface SetProjectMembershipInput {
  userId: string;
  projectId: string;
  role: RunApiProjectRole;
}

/** Short-lived login session input; expiry is fixed before issuing the secret. */
export interface IssueSessionInput {
  userId: string;
  expiresAt: string;
}

/** Raw session credential returned once to the trusted login flow. */
export interface IssuedSession {
  accessToken: string;
}

/** Persistent multi-user authority used by the versioned control plane. */
export interface PostgresRunApiAccessControl extends RunApiAccessControl {
  provisionUser(input: ProvisionUserInput): Promise<void>;
  provisionProject(input: ProvisionProjectInput): Promise<void>;
  setMembership(input: SetProjectMembershipInput): Promise<void>;
  listMemberships(projectId: string): Promise<RunApiProjectMembership[]>;
  removeMembership(projectId: string, userId: string): Promise<void>;
  /** Atomically claims the one-time empty-project administrator bootstrap. */
  bootstrapProjectAdmin(projectId: string, userId: string): Promise<boolean>;
  issueSession(input: IssueSessionInput): Promise<IssuedSession>;
  /** Idempotently invalidates a presented credential without revealing its existence. */
  revokeSession(accessToken: string): Promise<void>;
  /** Revokes the bearer or cookie credential presented by an HTTP logout request. */
  revokeRequestSession(request: Request): Promise<void>;
  issueLoginState(expiresAt: string): Promise<string>;
  consumeLoginState(state: string): Promise<boolean>;
}

/** Deterministic seams for expiry and one-time credential generation. */
export interface PostgresRunApiAccessControlOptions {
  now?: () => string;
  createToken?: () => string;
  createLoginState?: () => string;
}

/**
 * Creates the durable login/membership boundary. Session secrets are hashed
 * before persistence; every project decision reads the membership table.
 */
export async function createPostgresRunApiAccessControl(
  executor: PostgresExecutor,
  options: PostgresRunApiAccessControlOptions = {}
): Promise<PostgresRunApiAccessControl> {
  await initializeAccessSchema(executor);
  const now = options.now ?? (() => new Date().toISOString());
  const createToken =
    options.createToken ?? (() => randomBytes(32).toString("base64url"));
  const createLoginState =
    options.createLoginState ?? (() => randomBytes(32).toString("base64url"));

  return {
    async authenticate(request): Promise<RunApiPrincipal | undefined> {
      const token = readSessionToken(request);
      if (!token) {
        return undefined;
      }
      // Joining users yields the account email device binding records; the
      // session row alone only identifies the user.
      const result = await executor.query<{ user_id: string; email: string | null }>(
        `SELECT s.user_id, u.email
           FROM auth_sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1
            AND s.revoked_at IS NULL
            AND s.expires_at > $2::timestamptz`,
        [hashToken(token), requireTimestamp(now(), "current time")]
      );
      const row = result.rows[0];
      if (!row) {
        return undefined;
      }
      return row.email ? { userId: row.user_id, email: row.email } : { userId: row.user_id };
    },

    async roleFor(userId, projectId): Promise<RunApiProjectRole | undefined> {
      const result = await executor.query<{ role: RunApiProjectRole }>(
        `SELECT role
           FROM project_memberships
          WHERE user_id = $1 AND project_id = $2`,
        [userId, projectId]
      );
      return result.rows[0]?.role;
    },

    async provisionUser(input) {
      requireIdentifier(input.id, "User ID");
      requireBoundedText(input.email, "User email", 320);
      requireBoundedText(input.providerAccountId, "Provider account ID", 512);
      await executor.query(
        `INSERT INTO users (id, email, provider_account_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE
         SET email = EXCLUDED.email,
             provider_account_id = EXCLUDED.provider_account_id`,
        [input.id, input.email, input.providerAccountId]
      );
    },

    async provisionProject(input) {
      requireIdentifier(input.id, "Project ID");
      requireBoundedText(input.name, "Project name", 256);
      requireBoundedText(input.repository, "Project repository", 2_048);
      requireBoundedText(input.defaultBranch, "Default branch", 256);
      await executor.query(
        `INSERT INTO projects (id, name, repo_url, default_branch)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             repo_url = EXCLUDED.repo_url,
             default_branch = EXCLUDED.default_branch`,
        [input.id, input.name, input.repository, input.defaultBranch]
      );
    },

    async setMembership(input) {
      requireIdentifier(input.userId, "User ID");
      requireIdentifier(input.projectId, "Project ID");
      if (!isProjectRole(input.role)) {
        throw new Error("Project role is invalid");
      }
      await executor.query(
        `INSERT INTO project_memberships (project_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, user_id) DO UPDATE
         SET role = EXCLUDED.role`,
        [input.projectId, input.userId, input.role]
      );
    },

    async listMemberships(projectId) {
      requireIdentifier(projectId, "Project ID");
      const result = await executor.query<{
        user_id: string;
        role: RunApiProjectRole;
      }>(
        `SELECT user_id, role
           FROM project_memberships
          WHERE project_id = $1
          ORDER BY user_id ASC`,
        [projectId]
      );
      return result.rows.map((row) => ({ userId: row.user_id, role: row.role }));
    },

    async removeMembership(projectId, userId) {
      requireIdentifier(projectId, "Project ID");
      requireIdentifier(userId, "User ID");
      await executor.query(
        `DELETE FROM project_memberships
          WHERE project_id = $1 AND user_id = $2`,
        [projectId, userId]
      );
    },

    async bootstrapProjectAdmin(projectId, userId) {
      requireIdentifier(projectId, "Project ID");
      requireIdentifier(userId, "User ID");
      const result = await executor.query<{ project_id: string }>(
        `WITH claimed_project AS (
           UPDATE projects
              SET bootstrap_admin_assigned = TRUE
            WHERE id = $1 AND bootstrap_admin_assigned = FALSE
          RETURNING id
         )
         INSERT INTO project_memberships (project_id, user_id, role)
         SELECT id, $2, 'admin' FROM claimed_project
         RETURNING project_id`,
        [projectId, userId]
      );
      return result.rows.length === 1;
    },

    async issueSession(input) {
      requireIdentifier(input.userId, "User ID");
      const currentTime = requireTimestamp(now(), "current time");
      const expiresAt = requireTimestamp(input.expiresAt, "Session expiry");
      if (Date.parse(expiresAt) <= Date.parse(currentTime)) {
        throw new Error("Session expiry must be in the future");
      }
      const accessToken = createToken();
      if (!isValidToken(accessToken)) {
        throw new Error("Generated session token is invalid");
      }
      // Persist only the one-way digest so a database read cannot recover a login secret.
      await executor.query(
        `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
         VALUES ($1, $2, $3::timestamptz)`,
        [hashToken(accessToken), input.userId, expiresAt]
      );
      return { accessToken };
    },

    async revokeSession(accessToken) {
      if (!isValidToken(accessToken)) {
        return;
      }
      // Updating zero rows intentionally has the same observable result as revocation.
      await executor.query(
        `UPDATE auth_sessions
            SET revoked_at = $2::timestamptz
          WHERE token_hash = $1 AND revoked_at IS NULL`,
        [hashToken(accessToken), requireTimestamp(now(), "current time")]
      );
    },

    async revokeRequestSession(request) {
      const accessToken = readSessionToken(request);
      if (!accessToken) {
        return;
      }
      await executor.query(
        `UPDATE auth_sessions
            SET revoked_at = $2::timestamptz
          WHERE token_hash = $1 AND revoked_at IS NULL`,
        [hashToken(accessToken), requireTimestamp(now(), "current time")]
      );
    },

    async issueLoginState(expiresAt) {
      const currentTime = requireTimestamp(now(), "current time");
      const expiry = requireTimestamp(expiresAt, "OAuth state expiry");
      if (Date.parse(expiry) <= Date.parse(currentTime)) {
        throw new Error("OAuth state expiry must be in the future");
      }
      const state = createLoginState();
      if (!isValidToken(state)) {
        throw new Error("Generated OAuth state is invalid");
      }
      await executor.query(
        `INSERT INTO oauth_login_states (state_hash, expires_at)
         VALUES ($1, $2::timestamptz)`,
        [hashToken(state), expiry]
      );
      return state;
    },

    async consumeLoginState(state) {
      if (!isValidToken(state)) {
        return false;
      }
      const result = await executor.query<{ state_hash: string }>(
        `UPDATE oauth_login_states
            SET consumed_at = $2::timestamptz
          WHERE state_hash = $1
            AND consumed_at IS NULL
            AND expires_at > $2::timestamptz
        RETURNING state_hash`,
        [hashToken(state), requireTimestamp(now(), "current time")]
      );
      return result.rows.length === 1;
    }
  };
}

async function initializeAccessSchema(executor: PostgresExecutor): Promise<void> {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      provider_account_id TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await executor.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      bootstrap_admin_assigned BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await executor.query(
    `ALTER TABLE projects
     ADD COLUMN IF NOT EXISTS bootstrap_admin_assigned BOOLEAN NOT NULL DEFAULT FALSE`
  );
  await executor.query(`
    CREATE TABLE IF NOT EXISTS project_memberships (
      project_id TEXT NOT NULL REFERENCES projects(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL CHECK (role IN ('viewer', 'developer', 'admin')),
      PRIMARY KEY (project_id, user_id)
    )
  `);
  await executor.query(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await executor.query(`
    CREATE TABLE IF NOT EXISTS oauth_login_states (
      state_hash TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function readBearerToken(header: string | null): string | undefined {
  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }
  const token = header.slice("Bearer ".length);
  return isValidToken(token) ? token : undefined;
}

function readSessionToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    // An explicit Authorization header wins; never fall back from a bad header to a cookie.
    return readBearerToken(authorization);
  }
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("lecoding_session="));
  if (matches.length !== 1) {
    return undefined;
  }
  const token = matches[0]!.slice("lecoding_session=".length);
  return isValidToken(token) ? token : undefined;
}

function isValidToken(token: string): boolean {
  return token.length >= 32 && token.length <= 512 && /^[\x21-\x7e]+$/u.test(token);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function requireTimestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function requireIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function requireBoundedText(value: string, label: string, maximum: number): void {
  if (value.length === 0 || value.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
}

function isProjectRole(value: string): value is RunApiProjectRole {
  return value === "viewer" || value === "developer" || value === "admin";
}
