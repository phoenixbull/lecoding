import { describe, expect, it, vi } from "vitest";
import {
  createGitHubOAuthLogin,
  loadGitHubOAuthConfig
} from "../src/github-oauth.js";

describe("GitHub OAuth login", () => {
  it("loads a strict provider config with an explicit login allowlist", () => {
    expect(
      loadGitHubOAuthConfig({
        LECODING_PUBLIC_ORIGIN: "https://agent.example",
        LECODING_GITHUB_CLIENT_ID: "client-id",
        LECODING_GITHUB_CLIENT_SECRET: "client-secret",
        LECODING_GITHUB_ALLOWED_ORGANIZATIONS: " Trusted-Org,second-org ",
        LECODING_GITHUB_ALLOWED_EMAILS: "Alice@Example.com",
        LECODING_GITHUB_BOOTSTRAP_ADMIN_EMAILS: "Alice@Example.com"
      })
    ).toEqual({
      publicOrigin: "https://agent.example",
      clientId: "client-id",
      clientSecret: "client-secret",
      allowedOrganizations: ["trusted-org", "second-org"],
      allowedEmails: ["alice@example.com"],
      bootstrapAdminEmails: ["alice@example.com"]
    });
    expect(() =>
      loadGitHubOAuthConfig({
        LECODING_PUBLIC_ORIGIN: "https://agent.example",
        LECODING_GITHUB_CLIENT_ID: "client-id",
        LECODING_GITHUB_CLIENT_SECRET: "client-secret"
      })
    ).toThrow("allowlist");
  });

  it("starts the official web flow with a durable one-time state", async () => {
    const stateStore = {
      issueLoginState: vi.fn(async () => "oauth-state-secret-0001"),
      consumeLoginState: vi.fn(async () => true)
    };
    const login = createGitHubOAuthLogin({
      clientId: "github-client-id",
      clientSecret: "github-client-secret",
      publicOrigin: "https://agent.example",
      allowedOrganizations: ["trusted-org"],
      allowedEmails: [],
      now: () => "2026-08-28T00:00:00.000Z",
      stateStore
    });

    const authorizationUrl = await login.begin();
    const parsed = new URL(authorizationUrl);

    expect(parsed.origin + parsed.pathname).toBe(
      "https://github.com/login/oauth/authorize"
    );
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      client_id: "github-client-id",
      redirect_uri: "https://agent.example/api/v1/auth/github/callback",
      scope: "read:user user:email read:org",
      state: "oauth-state-secret-0001"
    });
    expect(stateStore.issueLoginState).toHaveBeenCalledWith(
      "2026-08-28T00:10:00.000Z"
    );
  });

  it("consumes state, enforces the allowlist, and issues an application session", async () => {
    const calls: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/login/oauth/access_token")) {
        return Response.json({
          access_token: "github-provider-token-must-not-persist",
          token_type: "bearer",
          scope: "read:user,user:email,read:org"
        });
      }
      if (url.endsWith("/user/emails")) {
        return Response.json([
          { email: "alice@example.com", primary: true, verified: true }
        ]);
      }
      if (url.endsWith("/user/orgs")) {
        return Response.json([{ login: "trusted-org" }]);
      }
      return Response.json({ id: 42, login: "alice", email: null });
    });
    const sessions = {
      provisionUser: vi.fn(async () => undefined),
      issueSession: vi.fn(async () => ({ accessToken: "application-session" }))
    };
    const stateStore = {
      issueLoginState: vi.fn(async () => "unused"),
      consumeLoginState: vi.fn(async () => true)
    };
    const onProvisionedUser = vi.fn(async () => undefined);
    const login = createGitHubOAuthLogin({
      clientId: "github-client-id",
      clientSecret: "github-client-secret",
      publicOrigin: "https://agent.example",
      allowedOrganizations: ["trusted-org"],
      allowedEmails: [],
      now: () => "2026-08-28T00:00:00.000Z",
      stateStore,
      sessions,
      onProvisionedUser,
      fetch
    });

    const result = await login.complete({
      code: "one-time-code",
      state: "oauth-state-secret-0001"
    });

    expect(result).toEqual({ accessToken: "application-session" });
    expect(stateStore.consumeLoginState).toHaveBeenCalledWith(
      "oauth-state-secret-0001"
    );
    expect(sessions.provisionUser).toHaveBeenCalledWith({
      id: "github_42",
      email: "alice@example.com",
      providerAccountId: "github:42"
    });
    expect(sessions.issueSession).toHaveBeenCalledWith({
      userId: "github_42",
      expiresAt: "2026-08-29T00:00:00.000Z"
    });
    expect(onProvisionedUser).toHaveBeenCalledWith({
      userId: "github_42",
      email: "alice@example.com"
    });
    expect(calls).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
      "https://api.github.com/user/emails",
      "https://api.github.com/user/orgs"
    ]);
    expect(
      JSON.stringify([
        sessions.provisionUser.mock.calls,
        sessions.issueSession.mock.calls
      ])
    ).not.toContain("github-provider-token");
  });

  it("stops before contacting GitHub when the durable state is invalid or replayed", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const sessions = {
      provisionUser: vi.fn(async () => undefined),
      issueSession: vi.fn(async () => ({ accessToken: "must-not-be-issued" }))
    };
    const login = createGitHubOAuthLogin({
      clientId: "github-client-id",
      clientSecret: "github-client-secret",
      publicOrigin: "https://agent.example",
      allowedOrganizations: ["trusted-org"],
      allowedEmails: [],
      stateStore: {
        issueLoginState: vi.fn(async () => "unused"),
        // A false result represents both expiry and a previously consumed state.
        consumeLoginState: vi.fn(async () => false)
      },
      sessions,
      fetch
    });

    await expect(
      login.complete({ code: "one-time-code", state: "replayed-state" })
    ).rejects.toThrow("invalid or expired");
    expect(fetch).not.toHaveBeenCalled();
    expect(sessions.provisionUser).not.toHaveBeenCalled();
    expect(sessions.issueSession).not.toHaveBeenCalled();
  });

  it("rejects an identity outside every allowlist without creating a session", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/login/oauth/access_token")) {
        return Response.json({
          access_token: "github-provider-token",
          token_type: "bearer",
          scope: "read:user,user:email,read:org"
        });
      }
      if (url.endsWith("/user/emails")) {
        return Response.json([
          { email: "mallory@example.com", primary: true, verified: true }
        ]);
      }
      if (url.endsWith("/user/orgs")) {
        return Response.json([{ login: "untrusted-org" }]);
      }
      return Response.json({ id: 99, login: "mallory", email: null });
    });
    const sessions = {
      provisionUser: vi.fn(async () => undefined),
      issueSession: vi.fn(async () => ({ accessToken: "must-not-be-issued" }))
    };
    const login = createGitHubOAuthLogin({
      clientId: "github-client-id",
      clientSecret: "github-client-secret",
      publicOrigin: "https://agent.example",
      allowedOrganizations: ["trusted-org"],
      allowedEmails: ["alice@example.com"],
      stateStore: {
        issueLoginState: vi.fn(async () => "unused"),
        consumeLoginState: vi.fn(async () => true)
      },
      sessions,
      fetch
    });

    await expect(
      login.complete({ code: "one-time-code", state: "valid-state" })
    ).rejects.toThrow("not allowed");
    expect(sessions.provisionUser).not.toHaveBeenCalled();
    expect(sessions.issueSession).not.toHaveBeenCalled();
  });
});
