import type {
  IssueSessionInput,
  IssuedSession,
  ProvisionUserInput
} from "./postgres-access-control.js";
import type { ModelEnvironment } from "@lecoding/openai-model";

/** Validated deployment settings safe to pass into the login constructor. */
export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  publicOrigin: string;
  allowedOrganizations: string[];
  allowedEmails: string[];
  bootstrapAdminEmails: string[];
}

/** Loads GitHub OAuth credentials and the mandatory organization/email allowlist. */
export function loadGitHubOAuthConfig(
  environment: ModelEnvironment
): GitHubOAuthConfig {
  const clientId = requireBounded(
    environment.LECODING_GITHUB_CLIENT_ID ?? "",
    "GitHub client ID",
    256
  );
  const clientSecret = requireBounded(
    environment.LECODING_GITHUB_CLIENT_SECRET ?? "",
    "GitHub client secret",
    512
  );
  const publicOrigin = requireHttpsOrigin(
    environment.LECODING_PUBLIC_ORIGIN ?? ""
  );
  const allowedOrganizations = parseAllowlist(
    environment.LECODING_GITHUB_ALLOWED_ORGANIZATIONS,
    "organization"
  );
  const allowedEmails = parseAllowlist(
    environment.LECODING_GITHUB_ALLOWED_EMAILS,
    "email"
  );
  const bootstrapAdminEmails = parseAllowlist(
    environment.LECODING_GITHUB_BOOTSTRAP_ADMIN_EMAILS,
    "email"
  );
  if (allowedOrganizations.length === 0 && allowedEmails.length === 0) {
    throw new Error("GitHub login requires an organization or email allowlist");
  }
  if (bootstrapAdminEmails.length === 0) {
    throw new Error("GitHub login requires a bootstrap administrator allowlist");
  }
  return {
    publicOrigin,
    clientId,
    clientSecret,
    allowedOrganizations,
    allowedEmails,
    bootstrapAdminEmails
  };
}

/** Durable state authority prevents OAuth callback forgery and replay. */
export interface GitHubOAuthStateStore {
  issueLoginState(expiresAt: string): Promise<string>;
  consumeLoginState(state: string): Promise<boolean>;
}

/** Trusted configuration for the GitHub OAuth web application flow. */
export interface GitHubOAuthLoginOptions {
  clientId: string;
  clientSecret: string;
  publicOrigin: string;
  allowedOrganizations: readonly string[];
  allowedEmails: readonly string[];
  stateStore: GitHubOAuthStateStore;
  sessions?: {
    provisionUser(input: ProvisionUserInput): Promise<void>;
    issueSession(input: IssueSessionInput): Promise<IssuedSession>;
  };
  fetch?: typeof globalThis.fetch;
  onProvisionedUser?: (identity: {
    userId: string;
    email: string;
  }) => Promise<void>;
  now?: () => string;
}

/** Provider callback parameters accepted only after a matching state is consumed. */
export interface CompleteGitHubOAuthInput {
  code: string;
  state: string;
}

/** Login flow exposed to the HTTP adapter without exposing provider secrets. */
export interface GitHubOAuthLogin {
  begin(): Promise<string>;
  complete(input: CompleteGitHubOAuthInput): Promise<IssuedSession>;
}

/** Creates the organization/email-restricted GitHub OAuth login boundary. */
export function createGitHubOAuthLogin(
  options: GitHubOAuthLoginOptions
): GitHubOAuthLogin {
  const clientId = requireBounded(options.clientId, "GitHub client ID", 256);
  requireBounded(options.clientSecret, "GitHub client secret", 512);
  const publicOrigin = requireHttpsOrigin(options.publicOrigin);
  if (
    options.allowedOrganizations.length === 0 &&
    options.allowedEmails.length === 0
  ) {
    throw new Error("GitHub login requires an organization or email allowlist");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const allowedOrganizations = new Set(
    options.allowedOrganizations.map((value) => value.trim().toLowerCase())
  );
  const allowedEmails = new Set(
    options.allowedEmails.map((value) => value.trim().toLowerCase())
  );
  const callbackUrl = `${publicOrigin}/api/v1/auth/github/callback`;

  return {
    async begin() {
      const expiresAt = new Date(Date.parse(now()) + 10 * 60_000).toISOString();
      const state = await options.stateStore.issueLoginState(expiresAt);
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", callbackUrl);
      url.searchParams.set("scope", "read:user user:email read:org");
      url.searchParams.set("state", state);
      return url.toString();
    },

    async complete(input) {
      const code = requireBounded(input.code, "GitHub OAuth code", 1_024);
      const state = requireBounded(input.state, "GitHub OAuth state", 512);
      if (!(await options.stateStore.consumeLoginState(state))) {
        throw new Error("GitHub OAuth state is invalid or expired");
      }
      if (!options.sessions) {
        throw new Error("GitHub OAuth session authority is unavailable");
      }
      const token = await fetchJson<GitHubTokenResponse>(
        fetchImplementation,
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: options.clientSecret,
            code,
            redirect_uri: callbackUrl
          })
        }
      );
      const providerToken = requireBounded(
        token.access_token,
        "GitHub provider token",
        2_048
      );
      const providerHeaders = {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${providerToken}`,
        "x-github-api-version": "2022-11-28"
      };
      const profile = await fetchJson<GitHubUser>(
        fetchImplementation,
        "https://api.github.com/user",
        { headers: providerHeaders }
      );
      const emails = await fetchJson<GitHubEmail[]>(
        fetchImplementation,
        "https://api.github.com/user/emails",
        { headers: providerHeaders }
      );
      const organizations = await fetchJson<GitHubOrganization[]>(
        fetchImplementation,
        "https://api.github.com/user/orgs",
        { headers: providerHeaders }
      );
      const email = emails.find(
        (candidate) =>
          candidate.primary === true &&
          candidate.verified === true &&
          typeof candidate.email === "string"
      )?.email;
      if (!email || !Number.isSafeInteger(profile.id) || profile.id < 1) {
        throw new Error("GitHub account is missing a verified identity");
      }
      const emailAllowed = allowedEmails.has(email.toLowerCase());
      const organizationAllowed = organizations.some(
        ({ login }) =>
          typeof login === "string" &&
          allowedOrganizations.has(login.toLowerCase())
      );
      if (!emailAllowed && !organizationAllowed) {
        throw new Error("GitHub account is not allowed to sign in");
      }
      const userId = `github_${profile.id}`;
      await options.sessions.provisionUser({
        id: userId,
        email,
        providerAccountId: `github:${profile.id}`
      });
      await options.onProvisionedUser?.({ userId, email });
      return options.sessions.issueSession({
        userId,
        expiresAt: new Date(Date.parse(now()) + 24 * 60 * 60_000).toISOString()
      });
    }
  };
}

interface GitHubTokenResponse {
  access_token: string;
}

interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

interface GitHubOrganization {
  login: string;
}

async function fetchJson<T>(
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  init: RequestInit
): Promise<T> {
  const response = await fetchImplementation(url, init);
  if (!response.ok) {
    // Provider bodies can contain sensitive or attacker-controlled details.
    throw new Error(`GitHub OAuth request failed with HTTP ${response.status}`);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 256 * 1_024) {
    throw new Error("GitHub OAuth response exceeded its size limit");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("GitHub OAuth response was not valid JSON");
  }
}

function requireHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GitHub OAuth public origin is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("GitHub OAuth public origin must be an HTTPS origin");
  }
  return url.origin;
}

function requireBounded(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function parseAllowlist(
  value: string | undefined,
  kind: "organization" | "email"
): string[] {
  if (!value?.trim()) {
    return [];
  }
  const entries = [...new Set(value.split(",").map((entry) => entry.trim().toLowerCase()))];
  for (const entry of entries) {
    const valid =
      kind === "organization"
        ? /^[a-z0-9](?:[a-z0-9-]{0,38})$/u.test(entry)
        : entry.length <= 320 && /^[^\s@]+@[^\s@]+$/u.test(entry);
    if (!valid) {
      throw new Error(`GitHub ${kind} allowlist is invalid`);
    }
  }
  return entries;
}
