import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { createPostgresRunApiAccessControl } from "../src/postgres-access-control.js";

describe("PostgreSQL control-plane access", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  it("authenticates a hashed session and resolves only persisted memberships", async () => {
    const database = new PGlite();
    databases.push(database);
    const rawToken = "phase2-session-token-that-is-never-persisted-0001";
    const access = await createPostgresRunApiAccessControl(database, {
      now: () => "2026-08-28T00:00:00.000Z",
      createToken: () => rawToken
    });
    await access.provisionUser({
      id: "user-alice",
      email: "alice@example.com",
      providerAccountId: "github:alice"
    });
    await access.provisionProject({
      id: "project-1",
      name: "Project One",
      repository: "https://example.invalid/project-1.git",
      defaultBranch: "main"
    });
    await access.setMembership({
      userId: "user-alice",
      projectId: "project-1",
      role: "developer"
    });

    const session = await access.issueSession({
      userId: "user-alice",
      expiresAt: "2026-08-29T00:00:00.000Z"
    });
    const principal = await access.authenticate(
      new Request("https://agent.example/api/v1/config", {
        headers: { authorization: `Bearer ${session.accessToken}` }
      })
    );
    const cookiePrincipal = await access.authenticate(
      new Request("https://agent.example/api/v1/config", {
        headers: { cookie: `lecoding_session=${session.accessToken}` }
      })
    );
    const stored = await database.query<{ token_hash: string }>(
      "SELECT token_hash FROM auth_sessions"
    );

    expect(session).toEqual({ accessToken: rawToken });
    expect(principal).toEqual({ userId: "user-alice" });
    expect(cookiePrincipal).toEqual({ userId: "user-alice" });
    await expect(access.roleFor("user-alice", "project-1")).resolves.toBe(
      "developer"
    );
    await expect(access.listMemberships("project-1")).resolves.toEqual([
      { userId: "user-alice", role: "developer" }
    ]);
    await expect(access.roleFor("user-alice", "project-2")).resolves.toBeUndefined();
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.token_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(stored.rows)).not.toContain(rawToken);
    await access.removeMembership("project-1", "user-alice");
    await expect(access.roleFor("user-alice", "project-1")).resolves.toBeUndefined();
  });

  it("expires and revokes login sessions without exposing whether another token exists", async () => {
    const database = new PGlite();
    databases.push(database);
    let currentTime = "2026-08-28T00:00:00.000Z";
    const tokens = [
      "phase2-session-token-for-expiry-check-0001",
      "phase2-session-token-for-revocation-check-0002"
    ];
    const access = await createPostgresRunApiAccessControl(database, {
      now: () => currentTime,
      createToken: () => tokens.shift()!
    });
    await access.provisionUser({
      id: "user-alice",
      email: "alice@example.com",
      providerAccountId: "github:alice"
    });
    const expiring = await access.issueSession({
      userId: "user-alice",
      expiresAt: "2026-08-28T01:00:00.000Z"
    });
    currentTime = "2026-08-28T02:00:00.000Z";

    await expect(authenticate(access, expiring.accessToken)).resolves.toBeUndefined();

    currentTime = "2026-08-28T00:30:00.000Z";
    const revoked = await access.issueSession({
      userId: "user-alice",
      expiresAt: "2026-08-29T00:00:00.000Z"
    });
    await access.revokeSession(revoked.accessToken);
    await access.revokeSession("unknown-session-token-that-is-long-enough-0003");

    await expect(authenticate(access, revoked.accessToken)).resolves.toBeUndefined();
  });

  it("stores OAuth state as a one-time expiring digest", async () => {
    const database = new PGlite();
    databases.push(database);
    let currentTime = "2026-08-28T00:00:00.000Z";
    const states = [
      "phase2-oauth-state-for-one-time-consumption-0001",
      "phase2-oauth-state-for-expiry-check-0002"
    ];
    const access = await createPostgresRunApiAccessControl(database, {
      now: () => currentTime,
      createLoginState: () => states.shift()!
    });

    const active = await access.issueLoginState("2026-08-28T00:10:00.000Z");
    const stored = await database.query<{ state_hash: string }>(
      "SELECT state_hash FROM oauth_login_states"
    );

    expect(stored.rows[0]!.state_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(stored.rows)).not.toContain(active);
    await expect(access.consumeLoginState(active)).resolves.toBe(true);
    await expect(access.consumeLoginState(active)).resolves.toBe(false);

    const expiring = await access.issueLoginState("2026-08-28T00:20:00.000Z");
    currentTime = "2026-08-28T00:21:00.000Z";
    await expect(access.consumeLoginState(expiring)).resolves.toBe(false);
  });

  it("bootstraps only an empty project's first administrator", async () => {
    const database = new PGlite();
    databases.push(database);
    const access = await createPostgresRunApiAccessControl(database);
    for (const [id, email] of [
      ["user-alice", "alice@example.com"],
      ["user-bob", "bob@example.com"]
    ] as const) {
      await access.provisionUser({
        id,
        email,
        providerAccountId: `github:${id}`
      });
    }
    await access.provisionProject({
      id: "project-1",
      name: "Project One",
      repository: "https://example.invalid/project-1.git",
      defaultBranch: "main"
    });

    await expect(
      access.bootstrapProjectAdmin("project-1", "user-alice")
    ).resolves.toBe(true);
    await expect(
      access.bootstrapProjectAdmin("project-1", "user-bob")
    ).resolves.toBe(false);

    await expect(access.listMemberships("project-1")).resolves.toEqual([
      { userId: "user-alice", role: "admin" }
    ]);
  });
});

function authenticate(
  access: Awaited<ReturnType<typeof createPostgresRunApiAccessControl>>,
  accessToken: string
) {
  return access.authenticate(
    new Request("https://agent.example/api/v1/config", {
      headers: { authorization: `Bearer ${accessToken}` }
    })
  );
}
