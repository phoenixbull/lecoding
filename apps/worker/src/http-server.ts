import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import type { ModelEnvironment } from "@lecoding/openai-model";
import type { WorkerControlPlane } from "./index.js";
import { createRunApiHandler } from "./api.js";

const NODE_REQUEST_LIMIT_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "connect-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join("; ");

/** API authentication modes accepted before project membership authorization. */
export type WorkerHttpAuth =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | { mode: "database_sessions" };

/** Validated single-user HTTP listener settings. */
export interface WorkerHttpConfig {
  host: string;
  port: number;
  auth: WorkerHttpAuth;
}

/** Inputs for serving the API and prebuilt Web assets on one origin. */
export interface StartWorkerHttpServerOptions extends WorkerHttpConfig {
  control: WorkerControlPlane;
  webRoot: string;
  onBackgroundError?: (error: unknown) => void;
}

/** Bound HTTP listener owned by WorkerProcessHost. */
export interface WorkerHttpServer {
  origin: string;
  stop(): Promise<void>;
}

/** Reads an authenticated listener; remote binds require explicit TLS termination. */
export function loadWorkerHttpConfig(
  environment: ModelEnvironment
): WorkerHttpConfig {
  const host = environment.LECODING_HTTP_HOST?.trim() || "127.0.0.1";
  if (!isValidListenHost(host)) {
    throw new Error("LECODING_HTTP_HOST must be a valid hostname or IP address");
  }
  const rawPort = environment.LECODING_HTTP_PORT?.trim() || "8787";
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("LECODING_HTTP_PORT must be an integer from 1 to 65535");
  }
  const token = environment.LECODING_HTTP_AUTH_TOKEN;
  const authMode = environment.LECODING_AUTH_MODE?.trim();
  if (authMode && authMode !== "database_sessions") {
    throw new Error("LECODING_AUTH_MODE must be database_sessions when set");
  }
  if (authMode === "database_sessions" && token) {
    throw new Error(
      "LECODING_HTTP_AUTH_TOKEN cannot be combined with database sessions"
    );
  }
  const auth: WorkerHttpAuth =
    authMode === "database_sessions"
      ? { mode: "database_sessions" }
      : token
        ? loadBearerAuth(token)
        : { mode: "none" };
  if (!LOOPBACK_HOSTS.has(host)) {
    if (auth.mode === "none") {
      throw new Error(
        "Non-loopback HTTP requires database sessions or LECODING_HTTP_AUTH_TOKEN"
      );
    }
    if (environment.LECODING_HTTP_BEHIND_TLS_PROXY !== "1") {
      throw new Error(
        "Non-loopback HTTP requires LECODING_HTTP_BEHIND_TLS_PROXY=1"
      );
    }
  }
  return { host, port, auth };
}

/** Starts the Node transport adapter around the Web-standard API handler. */
export async function startWorkerHttpServer(
  options: StartWorkerHttpServerOptions
): Promise<WorkerHttpServer> {
  if (!isAbsoluteCanonicalPath(options.webRoot)) {
    throw new Error("Worker Web root must be a canonical absolute path");
  }
  const api = createRunApiHandler({
    defaultProjectId: options.control.defaultProjectId,
    projectIds: options.control.projectIds,
    runs: options.control.runs,
    history: options.control.history,
    changes: options.control.changes,
    results: options.control.results,
    ...(options.control.artifacts ? { artifacts: options.control.artifacts } : {}),
    access: options.control.access,
    ...(options.control.memberships
      ? { memberships: options.control.memberships }
      : {}),
    ...(options.control.projectPolicy
      ? { projectPolicy: options.control.projectPolicy }
      : {}),
    ...(options.control.metrics ? { metrics: options.control.metrics } : {}),
    ...(options.control.actions ? { actions: options.control.actions } : {}),
    eventStream: options.control.eventStream,
    ...(options.onBackgroundError
      ? { onBackgroundError: options.onBackgroundError }
      : {})
  });
  const server = createServer((request, response) => {
    void handleNodeRequest(request, response, options, api.handle).catch(
      () => {
        if (!response.headersSent) {
          applySecurityHeaders(response);
          response.writeHead(500, { "content-type": "application/json" });
        }
        response.end('{"error":{"code":"internal_error","message":"Request failed"}}');
      }
    );
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise<void>((resolveListening, rejectListening) => {
    const reject = (error: Error): void => rejectListening(error);
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolveListening();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Worker HTTP server did not expose a TCP address");
  }
  const hostForUrl = address.address.includes(":")
    ? `[${address.address}]`
    : address.address;
  let stopPromise: Promise<void> | undefined;

  return {
    origin: `http://${hostForUrl}:${address.port}`,
    stop() {
      if (stopPromise) {
        return stopPromise;
      }
      stopPromise = new Promise<void>((resolveStop, rejectStop) => {
        server.close((error) => (error ? rejectStop(error) : resolveStop()));
        // SSE connections are process-owned and must not block graceful teardown.
        server.closeAllConnections();
      });
      return stopPromise;
    }
  };
}

async function handleNodeRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  options: StartWorkerHttpServerOptions,
  handleApi: (request: Request) => Promise<Response>
): Promise<void> {
  const host = incoming.headers.host ?? `${options.host}:${options.port}`;
  const url = new URL(incoming.url ?? "/", `http://${host}`);
  if (url.pathname.startsWith("/api/")) {
    if (url.pathname.startsWith("/api/v1/auth/")) {
      await handleLoginRequest(incoming, outgoing, url, options);
      return;
    }
    // Device binding owns its own per-route authentication because the
    // exchange endpoint deliberately presents no session: the device proves
    // itself with a one-time code instead. Routing it before the API bearer
    // gate is what lets a desktop client bind before it holds a credential.
    if (
      options.control.devices &&
      (url.pathname === "/api/v1/devices" || url.pathname.startsWith("/api/v1/devices/"))
    ) {
      const deviceRequest = await toWebRequest(incoming, url);
      await sendWebResponse(outgoing, await options.control.devices.handle(deviceRequest));
      return;
    }
    if (!isApiAuthorized(incoming, options.auth)) {
      sendUnauthorized(outgoing);
      return;
    }
    const abort = new AbortController();
    outgoing.once("close", () => abort.abort());
    const request = await toWebRequest(incoming, url, abort.signal);
    await sendWebResponse(outgoing, await handleApi(request));
    return;
  }
  await serveStatic(outgoing, options.webRoot, url.pathname);
}

/**
 * Converts a Node request into a Web `Request`.
 *
 * The optional signal lets long-lived handlers (SSE, device binding) observe a
 * client disconnect instead of writing into a closed socket.
 */
async function toWebRequest(
  incoming: IncomingMessage,
  url: URL,
  signal?: AbortSignal
): Promise<Request> {
  const body = await readIncomingBody(incoming);
  return new Request(url, {
    method: incoming.method ?? "GET",
    headers: nodeHeadersToWeb(incoming.headers),
    // Minimal API bodies are JSON text; decoding avoids cross-lib Uint8Array types.
    ...(body.byteLength > 0 ? { body: new TextDecoder().decode(body) } : {}),
    ...(signal ? { signal } : {})
  });
}

async function handleLoginRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  url: URL,
  options: StartWorkerHttpServerOptions
): Promise<void> {
  applySecurityHeaders(outgoing);
  outgoing.setHeader("cache-control", "no-store");
  const login = options.control.login;
  if (!login) {
    outgoing.writeHead(404, { "content-type": "application/json" });
    outgoing.end(
      '{"error":{"code":"login_unavailable","message":"Login is unavailable"}}'
    );
    return;
  }
  try {
    if (
      incoming.method === "GET" &&
      url.pathname === "/api/v1/auth/github/start"
    ) {
      outgoing.writeHead(302, { location: await login.begin() });
      outgoing.end();
      return;
    }
    if (
      incoming.method === "GET" &&
      url.pathname === "/api/v1/auth/github/callback"
    ) {
      const codes = url.searchParams.getAll("code");
      const states = url.searchParams.getAll("state");
      if (
        codes.length !== 1 ||
        states.length !== 1 ||
        !codes[0] ||
        !states[0] ||
        [...url.searchParams.keys()].some(
          (key) => key !== "code" && key !== "state"
        )
      ) {
        // Exact cardinality prevents query-parameter smuggling across parsers.
        throw new Error("OAuth callback parameters are invalid");
      }
      const session = await login.complete({ code: codes[0], state: states[0] });
      outgoing.writeHead(303, {
        location: "/",
        "set-cookie": sessionCookie(session.accessToken)
      });
      outgoing.end();
      return;
    }
    if (
      incoming.method === "POST" &&
      url.pathname === "/api/v1/auth/logout"
    ) {
      await login.revokeRequestSession(
        new Request(url, {
          method: "POST",
          headers: nodeHeadersToWeb(incoming.headers)
        })
      );
      outgoing.writeHead(204, { "set-cookie": clearSessionCookie() });
      outgoing.end();
      return;
    }
    outgoing.writeHead(404, { "content-type": "application/json" });
    outgoing.end(
      '{"error":{"code":"route_not_found","message":"Route was not found"}}'
    );
  } catch {
    // Provider errors, identities, and credentials remain opaque at the public boundary.
    outgoing.writeHead(401, { "content-type": "application/json" });
    outgoing.end(
      '{"error":{"code":"login_failed","message":"Login was not accepted"}}'
    );
  }
}

function sessionCookie(accessToken: string): string {
  return `lecoding_session=${accessToken}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie(): string {
  return "lecoding_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
}

function loadBearerAuth(token: string): WorkerHttpAuth {
  if (token.length < 32) {
    throw new Error("LECODING_HTTP_AUTH_TOKEN must contain at least 32 characters");
  }
  if (token.length > 512 || !/^[\x21-\x7e]+$/u.test(token)) {
    throw new Error(
      "LECODING_HTTP_AUTH_TOKEN must contain at most 512 visible ASCII characters"
    );
  }
  return { mode: "bearer", token };
}

function isValidListenHost(host: string): boolean {
  return (
    host.length <= 253 &&
    /^[a-zA-Z0-9._:-]+$/u.test(host) &&
    !host.startsWith(".") &&
    !host.endsWith(".")
  );
}

function isApiAuthorized(
  incoming: IncomingMessage,
  auth: WorkerHttpAuth
): boolean {
  if (auth.mode === "none" || auth.mode === "database_sessions") {
    // Database sessions are authenticated by the API access-control authority.
    return true;
  }
  const header = incoming.headers.authorization;
  const supplied =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
  // Fixed-length digests avoid leaking token-prefix or token-length matches.
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  const expectedDigest = createHash("sha256").update(auth.token).digest();
  return supplied !== "" && timingSafeEqual(suppliedDigest, expectedDigest);
}

function sendUnauthorized(response: ServerResponse): void {
  applySecurityHeaders(response);
  response.writeHead(401, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "www-authenticate": 'Bearer realm="LeCoding"'
  });
  response.end(
    '{"error":{"code":"unauthorized","message":"Authentication required"}}'
  );
}

async function readIncomingBody(incoming: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of incoming) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += bytes.byteLength;
    if (total > NODE_REQUEST_LIMIT_BYTES) {
      throw new Error("HTTP request body is too large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function nodeHeadersToWeb(headers: IncomingMessage["headers"]): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => result.append(name, entry));
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
}

async function sendWebResponse(
  outgoing: ServerResponse,
  response: Response
): Promise<void> {
  applySecurityHeaders(outgoing);
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  if (!response.body) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (!outgoing.destroyed) {
      const { done, value } = await reader.read();
      if (done) {
        outgoing.end();
        return;
      }
      if (!outgoing.write(Buffer.from(value))) {
        await once(outgoing, "drain");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function serveStatic(
  response: ServerResponse,
  webRoot: string,
  pathname: string
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendStaticError(response, 400, "Invalid path");
    return;
  }
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const filePath = resolve(webRoot, relativePath);
  const containment = relative(webRoot, filePath);
  if (containment === ".." || containment.startsWith("../") || containment.startsWith("..\\")) {
    sendStaticError(response, 404, "Not found");
    return;
  }
  try {
    const body = await readFile(filePath);
    applySecurityHeaders(response);
    response.writeHead(200, {
      "content-type": contentType(filePath),
      "cache-control": relativePath === "index.html"
        ? "no-cache"
        : "public, max-age=31536000, immutable"
    });
    response.end(body);
  } catch {
    sendStaticError(response, 404, "Not found");
  }
}

function sendStaticError(
  response: ServerResponse,
  status: number,
  message: string
): void {
  applySecurityHeaders(response);
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function isAbsoluteCanonicalPath(path: string): boolean {
  return resolve(path) === path;
}
