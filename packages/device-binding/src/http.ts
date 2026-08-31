import type { DeviceBindingService } from "./index.js";
import { DeviceBindingError } from "./index.js";

/**
 * Caller that can answer "who is making this request?" and "what role do
 * they have in this project?". Production wires this to the Worker's
 * existing `RunApiAccessControl`; tests can substitute a deterministic map.
 */
export interface DeviceBindingPrincipalResolver {
  authenticate(
    request: Request
  ): Promise<DeviceBindingPrincipal | undefined>;
}

export interface DeviceBindingPrincipal {
  userId: string;
  email: string;
}

export interface DeviceBindingHttpOptions {
  service: DeviceBindingService;
  principal: DeviceBindingPrincipalResolver;
  /**
   * Project allowlist; codes and devices are only valid for one of these
   * project IDs. Callers are required to map the request's projectId to
   * one of these to keep server-owned project identity in the control plane.
   */
  projectIds: readonly string[];
  /** Returns the project display name for a known projectId. */
  projectName(projectId: string): string | undefined;
}

export interface DeviceBindingHttpHandler {
  handle(request: Request): Promise<Response>;
}

interface CreateCodeBody {
  projectId: string;
  ttlMs?: number;
}

interface ExchangeBody {
  code: string;
  deviceLabel?: string;
  platform?: string;
}

const DEFAULT_DEVICE_PLATFORM = "unknown";

export function createDeviceBindingHttpHandler(
  options: DeviceBindingHttpOptions
): DeviceBindingHttpHandler {
  if (options.projectIds.length === 0) {
    throw new Error(
      "Device binding HTTP handler requires at least one registered project"
    );
  }
  return {
    async handle(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method === "POST" && path === "/api/v1/devices/code") {
        return handleCreateCode(request, options);
      }
      if (request.method === "POST" && path === "/api/v1/devices/exchange") {
        return handleExchange(request, options);
      }
      if (request.method === "GET" && path === "/api/v1/devices") {
        return handleList(request, options);
      }
      const deviceMatch = path.match(/^\/api\/v1\/devices\/([^/]+)$/);
      if (request.method === "DELETE" && deviceMatch) {
        return handleRevoke(request, options, deviceMatch[1]!);
      }
      return jsonResponse(404, { error: "not_found", message: "Unknown route" });
    }
  };
}

async function handleCreateCode(
  request: Request,
  options: DeviceBindingHttpOptions
): Promise<Response> {
  const principal = await options.principal.authenticate(request);
  if (!principal) {
    return jsonResponse(401, {
      error: "unauthorized",
      message: "Authentication required"
    });
  }
  const body = await readJson<CreateCodeBody>(request);
  const allowedProjects = new Set(options.projectIds);
  if (!body.projectId || !allowedProjects.has(body.projectId)) {
    return jsonResponse(400, {
      error: "invalid_project",
      message: "projectId is required and must be registered"
    });
  }
  const projectName = options.projectName(body.projectId);
  if (!projectName) {
    return jsonResponse(404, {
      error: "project_unknown",
      message: "Project is not registered with this Worker"
    });
  }
  try {
    const issued = await options.service.issueCode({
      userId: principal.userId,
      email: principal.email,
      projectId: body.projectId,
      projectName,
      ...(typeof body.ttlMs === "number" ? { ttlMs: body.ttlMs } : {})
    });
    return jsonResponse(200, {
      code: issued.code,
      payload: issued.payload,
      expiresAt: issued.expiresAt,
      projectId: body.projectId,
      projectName
    });
  } catch (error) {
    return mapError(error);
  }
}

async function handleExchange(
  request: Request,
  options: DeviceBindingHttpOptions
): Promise<Response> {
  // Exchanges do not require the browser session because the device is
  // presenting a one-time code that has not yet been redeemed.
  const body = await readJson<ExchangeBody>(request);
  if (typeof body.code !== "string" || body.code.trim() === "") {
    return jsonResponse(400, {
      error: "invalid_code",
      message: "code is required"
    });
  }
  try {
    const input: { code: string; deviceLabel?: string; platform?: string } = {
      code: body.code
    };
    if (typeof body.deviceLabel === "string") {
      input.deviceLabel = body.deviceLabel;
    }
    if (typeof body.platform === "string") {
      input.platform = body.platform;
    }
    const exchanged = await options.service.exchangeCode(input);
    return jsonResponse(200, {
      deviceId: exchanged.deviceId,
      accessToken: exchanged.accessToken,
      userId: exchanged.userId,
      email: exchanged.email,
      projectId: exchanged.projectId,
      projectName: exchanged.projectName,
      deviceLabel: exchanged.deviceLabel,
      platform: exchanged.platform,
      expiresAt: exchanged.expiresAt,
      createdAt: exchanged.createdAt
    });
  } catch (error) {
    return mapError(error);
  }
}

async function handleList(
  request: Request,
  options: DeviceBindingHttpOptions
): Promise<Response> {
  const principal = await options.principal.authenticate(request);
  if (!principal) {
    return jsonResponse(401, {
      error: "unauthorized",
      message: "Authentication required"
    });
  }
  const devices = await options.service.listDevicesForUser(principal.userId);
  return jsonResponse(200, {
    devices: devices.map((device) => ({
      deviceId: device.deviceId,
      projectId: device.projectId,
      projectName: device.projectName,
      deviceLabel: device.deviceLabel,
      platform: device.platform,
      createdAt: device.createdAt,
      lastUsedAt: device.lastUsedAt,
      expiresAt: device.expiresAt
    }))
  });
}

async function handleRevoke(
  request: Request,
  options: DeviceBindingHttpOptions,
  rawDeviceId: string
): Promise<Response> {
  const principal = await options.principal.authenticate(request);
  if (!principal) {
    return jsonResponse(401, {
      error: "unauthorized",
      message: "Authentication required"
    });
  }
  const deviceId = decodePathSegment(rawDeviceId);
  if (deviceId === "") {
    return jsonResponse(400, {
      error: "invalid_device",
      message: "deviceId is required"
    });
  }
  try {
    await options.service.revokeDevice({
      userId: principal.userId,
      deviceId
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return mapError(error);
  }
}

function mapError(error: unknown): Response {
  if (error instanceof DeviceBindingError) {
    const status =
      error.code === "too_many_codes"
        ? 429
        : error.code === "code_unknown" ||
            error.code === "device_unknown" ||
            error.code === "code_expired" ||
            error.code === "device_expired" ||
            error.code === "device_revoked" ||
            error.code === "code_consumed"
          ? 404
          : 400;
    return jsonResponse(status, { error: error.code, message: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse(500, { error: "internal_error", message });
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

// Suppress unused warning if exports rearrange later.
void DEFAULT_DEVICE_PLATFORM;