import type {
  ApprovalMode,
  CreateRunInput,
  FileAccessScope,
  RunCommand,
  RunEngine,
  RunId,
  RunResumer
} from "@lecoding/contracts";
import type { RunHistory } from "@lecoding/run-engine";
import type { RunEventSseHandler } from "@lecoding/run-events";
import type { RunChangesReader, RunResultManager } from "@lecoding/workspace";

const MAX_JSON_BODY_BYTES = 64 * 1024;
const APPROVAL_MODES = new Set<ApprovalMode>([
  "manual",
  "auto_review",
  "full_access"
]);
const FILE_ACCESS_SCOPES = new Set<FileAccessScope>([
  "workspace_only",
  "selected_directories",
  "host_full"
]);

/** Authenticated control-plane identity; provider credentials never cross this seam. */
export interface RunApiPrincipal {
  userId: string;
}

/** Project role ordered from read-only visibility to administrative authority. */
export type RunApiProjectRole = "viewer" | "developer" | "admin";

/** Request authentication and membership authority used by every versioned route. */
export interface RunApiAccessControl {
  authenticate(request: Request): Promise<RunApiPrincipal | undefined>;
  roleFor(
    userId: string,
    projectId: string
  ): Promise<RunApiProjectRole | undefined>;
}

/** Non-secret membership projection visible only to project administrators. */
export interface RunApiProjectMembership {
  userId: string;
  role: RunApiProjectRole;
}

/** Administrator mutation seam; the API performs role checks before every call. */
export interface RunApiMembershipAdministration {
  list(projectId: string): Promise<RunApiProjectMembership[]>;
  set(input: {
    projectId: string;
    userId: string;
    role: RunApiProjectRole;
  }): Promise<void>;
  remove(projectId: string, userId: string): Promise<void>;
}

/** RunEngine surface consumed by the single-user HTTP control plane. */
export type RunApiOperations = Pick<
  RunEngine,
  "start" | "inspect" | "command"
> &
  Pick<RunResumer, "resume">;

/** Dependencies for the versioned Run API router. */
export interface RunApiHandlerOptions {
  defaultProjectId: string;
  /** Complete administrator-registered allowlist; source paths never cross this seam. */
  projectIds: readonly string[];
  runs: RunApiOperations;
  history: RunHistory;
  changes: RunChangesReader;
  results: RunResultManager;
  access: RunApiAccessControl;
  memberships?: RunApiMembershipAdministration;
  eventStream: RunEventSseHandler;
  /** Observes detached resume failures without exposing them to HTTP clients. */
  onBackgroundError?: (error: unknown) => void;
}

/** Web-standard router shared by Node HTTP and request-level tests. */
export interface RunApiHandler {
  handle(request: Request): Promise<Response>;
}

/** Implements the minimal Phase 1 create/inspect/events/cancel/approval contract. */
export function createRunApiHandler(
  options: RunApiHandlerOptions
): RunApiHandler {
  const projectIds = new Set(options.projectIds);
  if (!projectIds.has(options.defaultProjectId) || projectIds.size === 0) {
    throw new Error("Run API requires a registered default project");
  }
  return {
    async handle(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      const principal = await options.access.authenticate(request);
      if (!principal) {
        return errorResponse(401, "unauthorized", "Authentication required");
      }
      if (request.method === "GET" && path === "/api/v1/config") {
        const visibleProjectIds = await filterAccessibleProjects(
          options,
          principal,
          "viewer"
        );
        if (visibleProjectIds.length === 0) {
          return errorResponse(403, "project_access_denied", "No project access");
        }
        const defaultProjectId = visibleProjectIds.includes(options.defaultProjectId)
          ? options.defaultProjectId
          : visibleProjectIds[0]!;
        return jsonResponse({
          projectId: defaultProjectId,
          projects: visibleProjectIds.map((id) => ({ id })),
          defaultEnvironmentId: "server-docker"
        });
      }
      const membershipCollectionMatch = path.match(
        /^\/api\/v1\/projects\/([^/]+)\/memberships$/
      );
      if (request.method === "GET" && membershipCollectionMatch) {
        const projectId = decodePathSegment(membershipCollectionMatch[1]!);
        if (
          !options.memberships ||
          !projectIds.has(projectId) ||
          !(await hasProjectRole(options, principal, projectId, "admin"))
        ) {
          return errorResponse(404, "project_not_found", "Project was not found");
        }
        return jsonResponse({
          memberships: await options.memberships.list(projectId)
        });
      }
      const membershipMatch = path.match(
        /^\/api\/v1\/projects\/([^/]+)\/memberships\/([^/]+)$/
      );
      if (request.method === "PUT" && membershipMatch) {
        const projectId = decodePathSegment(membershipMatch[1]!);
        const userId = decodePathSegment(membershipMatch[2]!);
        if (
          !options.memberships ||
          !projectIds.has(projectId) ||
          !(await hasProjectRole(options, principal, projectId, "admin"))
        ) {
          return errorResponse(404, "project_not_found", "Project was not found");
        }
        try {
          const role = parseMembershipRole(await readJsonBody(request));
          await options.memberships.set({ projectId, userId, role });
          return new Response(null, { status: 204 });
        } catch {
          return errorResponse(
            400,
            "invalid_membership",
            "Project membership is invalid"
          );
        }
      }
      if (request.method === "DELETE" && membershipMatch) {
        const projectId = decodePathSegment(membershipMatch[1]!);
        const userId = decodePathSegment(membershipMatch[2]!);
        if (
          !options.memberships ||
          !projectIds.has(projectId) ||
          !(await hasProjectRole(options, principal, projectId, "admin"))
        ) {
          return errorResponse(404, "project_not_found", "Project was not found");
        }
        await options.memberships.remove(projectId, userId);
        return new Response(null, { status: 204 });
      }
      const createMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/runs$/);
      if (request.method === "GET" && createMatch) {
        const projectId = decodePathSegment(createMatch[1]!);
        if (
          !projectIds.has(projectId) ||
          !(await hasProjectRole(options, principal, projectId, "viewer"))
        ) {
          return errorResponse(404, "project_not_found", "Project was not found");
        }
        try {
          const limit = parseHistoryLimit(url.searchParams.get("limit"));
          return jsonResponse({ runs: await options.history.list(projectId, limit) });
        } catch {
          return errorResponse(400, "invalid_history", "Run history request is invalid");
        }
      }
      if (request.method === "POST" && createMatch) {
        const projectId = decodePathSegment(createMatch[1]!);
        if (
          !projectIds.has(projectId) ||
          !(await hasProjectRole(options, principal, projectId, "developer"))
        ) {
          return errorResponse(404, "project_not_found", "Project was not found");
        }
        try {
          const input = parseCreateRunInput(await readJsonBody(request));
          const runId = await options.runs.start({ projectId, ...input });
          // Run execution is detached from the HTTP request after queued persistence.
          queueMicrotask(() => {
            void options.runs.resume(runId).catch((error: unknown) => {
              options.onBackgroundError?.(error);
            });
          });
          return jsonResponse({ runId }, 202, {
            location: `/api/v1/runs/${encodeURIComponent(runId)}`
          });
        } catch {
          return errorResponse(400, "invalid_run", "Run input is invalid");
        }
      }

      const inspectMatch = path.match(/^\/api\/v1\/runs\/([^/]+)$/);
      if (request.method === "GET" && inspectMatch) {
        try {
          const runId = decodePathSegment(inspectMatch[1]!) as RunId;
          return jsonResponse(
            await inspectProjectRun(options, principal, runId, "viewer")
          );
        } catch {
          return errorResponse(404, "run_not_found", "Run was not found");
        }
      }

      const eventMatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/events$/);
      if (request.method === "GET" && eventMatch) {
        try {
          const runId = decodePathSegment(eventMatch[1]!) as RunId;
          await inspectProjectRun(options, principal, runId, "viewer");
          return options.eventStream.handle(request, runId);
        } catch {
          return errorResponse(404, "run_not_found", "Run was not found");
        }
      }

      const changesMatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/changes$/);
      if (request.method === "GET" && changesMatch) {
        try {
          const runId = decodePathSegment(changesMatch[1]!) as RunId;
          await inspectProjectRun(options, principal, runId, "viewer");
          return jsonResponse(await options.changes.read(runId));
        } catch {
          return errorResponse(404, "changes_not_found", "Run changes were not found");
        }
      }

      const resultMatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/result$/);
      if (request.method === "POST" && resultMatch) {
        let runId: RunId;
        try {
          runId = decodePathSegment(resultMatch[1]!) as RunId;
          const run = await inspectProjectRun(
            options,
            principal,
            runId,
            "developer"
          );
          if (!isTerminalRunStatus(run.status)) {
            return errorResponse(
              409,
              "result_not_terminal",
              "Run result is not terminal"
            );
          }
        } catch {
          return errorResponse(404, "run_not_found", "Run was not found");
        }
        let outcome: "keep" | "discard";
        try {
          outcome = parseRunResult(await readJsonBody(request));
        } catch {
          return errorResponse(400, "invalid_result", "Run result input is invalid");
        }
        try {
          await options.results.resolve(runId, outcome);
          return new Response(null, { status: 204 });
        } catch {
          return errorResponse(409, "result_rejected", "Run result was rejected");
        }
      }

      const commandMatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/commands$/);
      if (request.method === "POST" && commandMatch) {
        let runId: RunId;
        try {
          runId = decodePathSegment(commandMatch[1]!) as RunId;
          await inspectProjectRun(options, principal, runId, "developer");
        } catch {
          return errorResponse(404, "run_not_found", "Run was not found");
        }
        try {
          const command = parseMinimalRunCommand(await readJsonBody(request));
          if (command.type === "approve" || command.type === "reject") {
            await options.runs.command(runId, command, {
              actorId: principal.userId
            });
          } else {
            await options.runs.command(runId, command);
          }
          return new Response(null, { status: 202 });
        } catch {
          return errorResponse(409, "command_rejected", "Run command was rejected");
        }
      }

      return errorResponse(404, "route_not_found", "Route was not found");
    }
  };
}

async function inspectProjectRun(
  options: RunApiHandlerOptions,
  principal: RunApiPrincipal,
  runId: RunId,
  minimumRole: RunApiProjectRole
) {
  const run = await options.runs.inspect(runId);
  if (
    !options.projectIds.includes(run.projectId) ||
    !(await hasProjectRole(options, principal, run.projectId, minimumRole))
  ) {
    // Return the same not-found surface so cross-project identities are not disclosed.
    throw new Error("Run is outside the registered project");
  }
  return run;
}

async function filterAccessibleProjects(
  options: RunApiHandlerOptions,
  principal: RunApiPrincipal,
  minimumRole: RunApiProjectRole
): Promise<string[]> {
  const decisions = await Promise.all(
    options.projectIds.map(async (projectId) => ({
      projectId,
      allowed: await hasProjectRole(options, principal, projectId, minimumRole)
    }))
  );
  return decisions.filter(({ allowed }) => allowed).map(({ projectId }) => projectId);
}

async function hasProjectRole(
  options: RunApiHandlerOptions,
  principal: RunApiPrincipal,
  projectId: string,
  minimumRole: RunApiProjectRole
): Promise<boolean> {
  const role = await options.access.roleFor(principal.userId, projectId);
  return role !== undefined && roleRank(role) >= roleRank(minimumRole);
}

function roleRank(role: RunApiProjectRole): number {
  return role === "viewer" ? 0 : role === "developer" ? 1 : 2;
}

function parseHistoryLimit(value: string | null): number {
  if (value === null) {
    return 20;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error("Run history limit must be numeric");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Run history limit is outside its bounded range");
  }
  return limit;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (
    contentType !== "application/json" ||
    (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES)
  ) {
    throw new Error("Invalid JSON request metadata");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) {
    throw new Error("JSON request body is too large");
  }
  return JSON.parse(text) as unknown;
}

function parseCreateRunInput(value: unknown): CreateRunInput {
  if (!isRecord(value)) {
    throw new Error("Run input must be an object");
  }
  const allowedKeys = new Set([
    "environmentId",
    "task",
    "acceptanceCriteria",
    "approvalMode",
    "fileAccessScope",
    "deniedCommands"
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("Run input contains unknown fields");
  }
  if (
    typeof value.environmentId !== "string" ||
    value.environmentId.trim() === "" ||
    typeof value.task !== "string" ||
    value.task.trim() === "" ||
    !Array.isArray(value.acceptanceCriteria) ||
    value.acceptanceCriteria.length === 0 ||
    value.acceptanceCriteria.some(
      (criterion) => typeof criterion !== "string" || criterion.trim() === ""
    ) ||
    typeof value.approvalMode !== "string" ||
    !APPROVAL_MODES.has(value.approvalMode as ApprovalMode) ||
    typeof value.fileAccessScope !== "string" ||
    !FILE_ACCESS_SCOPES.has(value.fileAccessScope as FileAccessScope) ||
    (value.deniedCommands !== undefined &&
      (!Array.isArray(value.deniedCommands) ||
        value.deniedCommands.some(
          (command) => typeof command !== "string" || command.trim() === ""
        )))
  ) {
    throw new Error("Run input fields are invalid");
  }
  return value as unknown as CreateRunInput;
}

function parseMinimalRunCommand(value: unknown): RunCommand {
  if (!isRecord(value)) {
    throw new Error("Run command must be an object");
  }
  if (Object.keys(value).length === 1 && value.type === "cancel") {
    return { type: "cancel" };
  }
  if (
    Object.keys(value).length === 3 &&
    (value.type === "approve" || value.type === "reject") &&
    typeof value.approvalId === "string" &&
    value.approvalId.trim() !== "" &&
    (value.scope === "once" || value.scope === "run")
  ) {
    // The engine binds Run scope to the pending normalized capability fingerprint.
    return {
      type: value.type,
      approvalId: value.approvalId,
      scope: value.scope
    };
  }
  if (
    Object.keys(value).length === 4 &&
    value.type === "answer" &&
    typeof value.commandId === "string" &&
    value.commandId.trim() !== "" &&
    value.commandId.length <= 128 &&
    typeof value.requestId === "string" &&
    value.requestId.trim() !== "" &&
    typeof value.value === "string" &&
    value.value.trim() !== "" &&
    value.value.trim().length <= 4_000
  ) {
    return {
      type: "answer",
      commandId: value.commandId,
      requestId: value.requestId,
      value: value.value
    };
  }
  if (
    Object.keys(value).length === 3 &&
    value.type === "steer" &&
    typeof value.commandId === "string" &&
    value.commandId.trim() !== "" &&
    value.commandId.length <= 128 &&
    typeof value.message === "string" &&
    value.message.trim() !== "" &&
    value.message.trim().length <= 4_000
  ) {
    return {
      type: "steer",
      commandId: value.commandId,
      message: value.message
    };
  }
  throw new Error("Run command is not available in the minimal control plane");
}

function parseRunResult(value: unknown): "keep" | "discard" {
  if (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    (value.outcome === "keep" || value.outcome === "discard")
  ) {
    return value.outcome;
  }
  throw new Error("Run result must be keep or discard");
}

function parseMembershipRole(value: unknown): RunApiProjectRole {
  if (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    isProjectRole(value.role)
  ) {
    return value.role;
  }
  throw new Error("Project membership role is invalid");
}

function isProjectRole(value: unknown): value is RunApiProjectRole {
  return value === "viewer" || value === "developer" || value === "admin";
}

function isTerminalRunStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function decodePathSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.trim() === "") {
      throw new Error("Empty path identity");
    }
    return decoded;
  } catch {
    throw new Error("Invalid encoded path identity");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: HeadersInit = {}
): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...Object.fromEntries(new Headers(extraHeaders))
    }
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}
