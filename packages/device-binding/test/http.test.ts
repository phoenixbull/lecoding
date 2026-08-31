import { beforeEach, describe, expect, it } from "vitest";
import {
  createDeviceBindingHttpHandler,
  createDeviceBindingService,
  createInMemoryDeviceBindingStore,
  type DeviceBindingPrincipal
} from "../src/index.js";

const PROJECTS = ["project-1", "project-2"] as const;
const PROJECT_NAMES: Record<string, string> = {
  "project-1": "Project One",
  "project-2": "Project Two"
};

function makePrincipalResolver(): {
  authenticate(
    request: Request
  ): Promise<DeviceBindingPrincipal | undefined>;
} {
  return {
    async authenticate(request) {
      const header = request.headers.get("authorization");
      if (!header) {
        return undefined;
      }
      if (header === "Bearer alice") {
        return { userId: "user-1", email: "alice@example.com" };
      }
      if (header === "Bearer bob") {
        return { userId: "user-2", email: "bob@example.com" };
      }
      return undefined;
    }
  };
}

function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("DeviceBindingHttpHandler", () => {
  let now: () => Date;
  let service: ReturnType<typeof createDeviceBindingService>;
  let handler: ReturnType<typeof createDeviceBindingHttpHandler>;

  beforeEach(() => {
    now = () => new Date("2026-08-31T10:00:00.000Z");
    service = createDeviceBindingService({
      store: createInMemoryDeviceBindingStore(),
      now
    });
    handler = createDeviceBindingHttpHandler({
      service,
      principal: makePrincipalResolver(),
      projectIds: PROJECTS,
      projectName: (projectId) => PROJECT_NAMES[projectId]
    });
  });

  it("issues a code through POST /api/v1/devices/code", async () => {
    const response = await handler.handle(
      new Request("https://example.test/api/v1/devices/code", {
        method: "POST",
        headers: {
          authorization: "Bearer alice",
          "content-type": "application/json"
        },
        body: JSON.stringify({ projectId: "project-1" })
      })
    );
    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body.code).toMatch(/^[A-Z2-9]{9}$/);
    expect(body.payload).toContain(body.code);
    expect(body.projectId).toBe("project-1");
    expect(body.projectName).toBe("Project One");
  });

  it("rejects POST /api/v1/devices/code from an unauthenticated caller", async () => {
    const response = await handler.handle(
      new Request("https://example.test/api/v1/devices/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: "project-1" })
      })
    );
    expect(response.status).toBe(401);
    expect(await jsonBody(response)).toMatchObject({ error: "unauthorized" });
  });

  it("rejects POST /api/v1/devices/code for an unregistered projectId", async () => {
    const response = await handler.handle(
      new Request("https://example.test/api/v1/devices/code", {
        method: "POST",
        headers: {
          authorization: "Bearer alice",
          "content-type": "application/json"
        },
        body: JSON.stringify({ projectId: "unknown-project" })
      })
    );
    expect(response.status).toBe(400);
    expect(await jsonBody(response)).toMatchObject({ error: "invalid_project" });
  });

  it("exchanges a code through POST /api/v1/devices/exchange without requiring the browser session", async () => {
    const issued = await handler.handle(
      new Request("https://example.test/api/v1/devices/code", {
        method: "POST",
        headers: {
          authorization: "Bearer alice",
          "content-type": "application/json"
        },
        body: JSON.stringify({ projectId: "project-1" })
      })
    );
    const { code } = (await issued.json()) as { code: string };

    const response = await handler.handle(
      new Request("https://example.test/api/v1/devices/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          deviceLabel: "Alice's laptop",
          platform: "darwin"
        })
      })
    );
    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body.deviceId).toMatch(/^[a-f0-9-]{36}$/);
    expect(body.accessToken).toMatch(/^[a-f0-9]{64}$/);
    expect(body.email).toBe("alice@example.com");
    expect(body.projectId).toBe("project-1");
    expect(body.projectName).toBe("Project One");
  });

  it("surfaces a code_consumed error with status 404 on replay", async () => {
    const issued = await handler.handle(
      new Request("https://example.test/api/v1/devices/code", {
        method: "POST",
        headers: {
          authorization: "Bearer alice",
          "content-type": "application/json"
        },
        body: JSON.stringify({ projectId: "project-1" })
      })
    );
    const { code } = (await issued.json()) as { code: string };
    await handler.handle(
      new Request("https://example.test/api/v1/devices/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code })
      })
    );
    const replay = await handler.handle(
      new Request("https://example.test/api/v1/devices/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code })
      })
    );
    expect(replay.status).toBe(404);
    expect(await jsonBody(replay)).toMatchObject({ error: "code_consumed" });
  });

  it("lists the current user's devices through GET /api/v1/devices", async () => {
    const codeResponse = await handler.handle(
      new Request("https://example.test/api/v1/devices/code", {
        method: "POST",
        headers: {
          authorization: "Bearer alice",
          "content-type": "application/json"
        },
        body: JSON.stringify({ projectId: "project-1" })
      })
    );
    const { code } = (await codeResponse.json()) as { code: string };
    await handler.handle(
      new Request("https://example.test/api/v1/devices/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code })
      })
    );

    const response = await handler.handle(
      new Request("https://example.test/api/v1/devices", {
        method: "GET",
        headers: { authorization: "Bearer alice" }
      })
    );
    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(Array.isArray(body.devices)).toBe(true);
    expect((body.devices as unknown[]).length).toBe(1);
    const [device] = body.devices as { projectId: string }[];
    expect(device?.projectId).toBe("project-1");
  });

  it("revokes a device through DELETE /api/v1/devices/:id", async () => {
    const codeResponse = await handler.handle(
      new Request("https://example.test/api/v1/devices/code", {
        method: "POST",
        headers: {
          authorization: "Bearer alice",
          "content-type": "application/json"
        },
        body: JSON.stringify({ projectId: "project-1" })
      })
    );
    const { code } = (await codeResponse.json()) as { code: string };
    const exchange = await handler.handle(
      new Request("https://example.test/api/v1/devices/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code })
      })
    );
    const { deviceId } = (await exchange.json()) as { deviceId: string };

    const revoke = await handler.handle(
      new Request(`https://example.test/api/v1/devices/${deviceId}`, {
        method: "DELETE",
        headers: { authorization: "Bearer alice" }
      })
    );
    expect(revoke.status).toBe(204);

    const after = await handler.handle(
      new Request("https://example.test/api/v1/devices", {
        method: "GET",
        headers: { authorization: "Bearer alice" }
      })
    );
    const body = await jsonBody(after);
    expect((body.devices as unknown[]).length).toBe(0);
  });

  it("rejects DELETE /api/v1/devices/:id when the device belongs to another user", async () => {
    const codeResponse = await handler.handle(
      new Request("https://example.test/api/v1/devices/code", {
        method: "POST",
        headers: {
          authorization: "Bearer alice",
          "content-type": "application/json"
        },
        body: JSON.stringify({ projectId: "project-1" })
      })
    );
    const { code } = (await codeResponse.json()) as { code: string };
    const exchange = await handler.handle(
      new Request("https://example.test/api/v1/devices/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code })
      })
    );
    const { deviceId } = (await exchange.json()) as { deviceId: string };

    const response = await handler.handle(
      new Request(`https://example.test/api/v1/devices/${deviceId}`, {
        method: "DELETE",
        headers: { authorization: "Bearer bob" }
      })
    );
    expect(response.status).toBe(404);
    expect(await jsonBody(response)).toMatchObject({ error: "device_unknown" });
  });

  it("returns 404 for an unknown route", async () => {
    const response = await handler.handle(
      new Request("https://example.test/api/v1/devices/who-knows", {
        method: "GET",
        headers: { authorization: "Bearer alice" }
      })
    );
    expect(response.status).toBe(404);
  });

  it("rejects a list request without authentication", async () => {
    const response = await handler.handle(
      new Request("https://example.test/api/v1/devices", {
        method: "GET"
      })
    );
    expect(response.status).toBe(401);
  });
});