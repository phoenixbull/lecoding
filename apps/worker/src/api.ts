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
import type { RunChangesReader } from "@lecoding/workspace";

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
      if (request.method === "GET" && path === "/api/v1/config") {
        return jsonResponse({
          projectId: options.defaultProjectId,
          projects: options.projectIds.map((id) => ({ id })),
          defaultEnvironmentId: "server-docker"
        });
      }
      const createMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/runs$/);
      if (request.method === "GET" && createMatch) {
        const projectId = decodePathSegment(createMatch[1]!);
        if (!projectIds.has(projectId)) {
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
        if (!projectIds.has(projectId)) {
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
          return jsonResponse(await inspectProjectRun(options, runId));
        } catch {
          return errorResponse(404, "run_not_found", "Run was not found");
        }
      }

      const eventMatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/events$/);
      if (request.method === "GET" && eventMatch) {
        try {
          const runId = decodePathSegment(eventMatch[1]!) as RunId;
          await inspectProjectRun(options, runId);
          return options.eventStream.handle(request, runId);
        } catch {
          return errorResponse(404, "run_not_found", "Run was not found");
        }
      }

      const changesMatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/changes$/);
      if (request.method === "GET" && changesMatch) {
        try {
          const runId = decodePathSegment(changesMatch[1]!) as RunId;
          await inspectProjectRun(options, runId);
          return jsonResponse(await options.changes.read(runId));
        } catch {
          return errorResponse(404, "changes_not_found", "Run changes were not found");
        }
      }

      const commandMatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/commands$/);
      if (request.method === "POST" && commandMatch) {
        let runId: RunId;
        try {
          runId = decodePathSegment(commandMatch[1]!) as RunId;
          await inspectProjectRun(options, runId);
        } catch {
          return errorResponse(404, "run_not_found", "Run was not found");
        }
        try {
          const command = parseMinimalRunCommand(await readJsonBody(request));
          await options.runs.command(runId, command);
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
  runId: RunId
) {
  const run = await options.runs.inspect(runId);
  if (!options.projectIds.includes(run.projectId)) {
    // Return the same not-found surface so cross-project identities are not disclosed.
    throw new Error("Run is outside the registered project");
  }
  return run;
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
    value.scope === "once"
  ) {
    // Browser commands cannot broaden one reviewed call into a Run-wide grant.
    return {
      type: value.type,
      approvalId: value.approvalId,
      scope: "once"
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
