import { describe, expect, it, vi } from "vitest";
import type { DeviceBindingService } from "@lecoding/device-binding";
import {
  createPairedRunnerSockets,
  type HostSession,
  type RunnerSocket
} from "@lecoding/runner-protocol";
import { createRunnerGateway, type RunnerGateway } from "../src/runner-gateway.js";
import { localRunnerDeviceId } from "../src/index.js";

/** Minimal device service double: one token resolves to one device. */
function fakeDevices(
  overrides: Partial<Record<"authenticate" | "revokeDevice", unknown>> = {}
): DeviceBindingService & { revoked: string[] } {
  const revoked: string[] = [];
  return {
    revoked,
    async issueCode() {
      throw new Error("unused");
    },
    async exchangeCode() {
      throw new Error("unused");
    },
    async authenticate(input: { accessToken: string }) {
      if (overrides.authenticate) {
        return (overrides.authenticate as (i: { accessToken: string }) => unknown)(input) as never;
      }
      if (input.accessToken !== "good-token") {
        throw Object.assign(new Error("unknown device"), { code: "device_unknown" });
      }
      return {
        deviceId: "device-1",
        userId: "user-1",
        email: "u@example.com",
        projectId: "project-1",
        projectName: "project-1"
      };
    },
    async touchDevice() {
      /* unused */
    },
    async revokeDevice(input: { userId: string; deviceId: string }) {
      revoked.push(input.deviceId);
    },
    async listDevicesForUser() {
      return [];
    }
  } as DeviceBindingService & { revoked: string[] };
}

/** Connects a socket pair and waits for the async `authenticate` to settle. */
async function connectRunner(
  gateway: RunnerGateway,
  token: string
): Promise<{ socket: RunnerSocket; peer: RunnerSocket }> {
  const pair = createPairedRunnerSockets();
  gateway.accept(pair.a);
  pair.b.send(
    JSON.stringify({
      v: 1,
      kind: "hello",
      deviceAccessToken: token,
      capabilities: {
        maxFileAccessScope: "workspace_only",
        kernelEnforced: true,
        platform: "darwin"
      }
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { socket: pair.a, peer: pair.b };
}

function createGateway(
  devices: DeviceBindingService,
  overrides: { projectIds?: string[]; heartbeatIntervalMs?: number } = {}
): RunnerGateway {
  return createRunnerGateway({
    devices,
    projectIds: overrides.projectIds ?? ["project-1"],
    ...(overrides.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: overrides.heartbeatIntervalMs }
      : {})
  });
}

describe("createRunnerGateway", () => {
  it("registers a session only after the device token is verified", async () => {
    const gateway = createGateway(fakeDevices());
    const pair = createPairedRunnerSockets();
    gateway.accept(pair.a);

    // Live socket, but not yet routable: a Run must never reach a stranger.
    expect(gateway.sessionFor("device-1")).toBeUndefined();

    pair.b.send(
      JSON.stringify({
        v: 1,
        kind: "hello",
        deviceAccessToken: "good-token",
        capabilities: {
          maxFileAccessScope: "workspace_only",
          kernelEnforced: true,
          platform: "darwin"
        }
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(gateway.sessionFor("device-1")).toBeDefined();
    gateway.stop();
  });

  it("does not register a session when authentication fails", async () => {
    const gateway = createGateway(fakeDevices());
    await connectRunner(gateway, "bad-token");
    expect(gateway.sessionFor("device-1")).toBeUndefined();
    gateway.stop();
  });

  it("rejects a device whose project this Worker does not serve", async () => {
    const gateway = createGateway(fakeDevices(), { projectIds: ["other-project"] });
    await connectRunner(gateway, "good-token");
    expect(gateway.sessionFor("device-1")).toBeUndefined();
    gateway.stop();
  });

  it("carries the consumed cursor across a reconnect", async () => {
    // The whole point of keeping the cursor in the gateway rather than the
    // session: a new socket must resume, not restart.
    const gateway = createGateway(fakeDevices());
    const first = await connectRunner(gateway, "good-token");
    const session = gateway.sessionFor("device-1")!;

    first.peer.send(
      JSON.stringify({
        v: 1,
        kind: "event",
        cursor: 1,
        event: {
          type: "audit.host_access",
          runId: "r1",
          path: "/tmp/a",
          kind: "write",
          outOfScope: true,
          recordedAt: "2026-09-03T00:00:00.000Z"
        }
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.consumedCursor()).toBe(1);

    first.socket.close(4003, "network drop");
    await new Promise((resolve) => setTimeout(resolve, 0));

    await connectRunner(gateway, "good-token");
    const reconnected = gateway.sessionFor("device-1")!;
    // A different session object, but it starts from the cursor the previous
    // one reached, so replay resumes instead of restarting.
    expect(reconnected).not.toBe(session);
    expect(reconnected.consumedCursor()).toBe(1);
    gateway.stop();
  });

  it("terminates a device session on revocation with close code 4001", async () => {
    const gateway = createGateway(fakeDevices());
    await connectRunner(gateway, "good-token");
    expect(gateway.sessionFor("device-1")).toBeDefined();

    expect(gateway.terminateDevice("device-1")).toBe(1);
    expect(gateway.sessionFor("device-1")).toBeUndefined();
    gateway.stop();
  });

  it("reports zero terminations for an offline device", () => {
    const gateway = createGateway(fakeDevices());
    expect(gateway.terminateDevice("device-nope")).toBe(0);
    gateway.stop();
  });

  it("closes every session on stop", async () => {
    const gateway = createGateway(fakeDevices());
    await connectRunner(gateway, "good-token");
    gateway.stop();
    expect(gateway.sessionFor("device-1")).toBeUndefined();
  });

  it("survives a session that throws during tick", async () => {
    const errors: unknown[] = [];
    const gateway = createRunnerGateway({
      devices: fakeDevices(),
      projectIds: ["project-1"],
      onBackgroundError: (error) => errors.push(error)
    });
    await connectRunner(gateway, "good-token");
    const session = gateway.sessionFor("device-1") as HostSession & {
      tick(): void;
    };
    session.tick = () => {
      throw new Error("tick failed");
    };

    expect(() => gateway.tick()).not.toThrow();
    expect(errors).toHaveLength(1);
    gateway.stop();
  });

  it("maps an expired device onto a distinct error code", async () => {
    const devices = fakeDevices({
      authenticate: async () => {
        throw Object.assign(new Error("expired"), { code: "device_expired" });
      }
    });
    const gateway = createGateway(devices);
    const pair = createPairedRunnerSockets();
    gateway.accept(pair.a);
    pair.b.send(
      JSON.stringify({
        v: 1,
        kind: "hello",
        deviceAccessToken: "expired-token",
        capabilities: {
          maxFileAccessScope: "workspace_only",
          kernelEnforced: true,
          platform: "darwin"
        }
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const goodbye = pair
      .wire()
      .map((frame) => JSON.parse(frame.text) as { kind: string; code?: number })
      .find((frame) => frame.kind === "goodbye");
    expect(goodbye?.code).toBe(4001);
    gateway.stop();
  });
});

describe("localRunnerDeviceId", () => {
  it("extracts the device id from a local environment id", () => {
    expect(localRunnerDeviceId("local:device-7")).toBe("device-7");
  });

  it("returns undefined for server environments", () => {
    expect(localRunnerDeviceId("server-docker")).toBeUndefined();
    expect(localRunnerDeviceId("local:")).toBe("");
  });
});
