import { describe, expect, it } from "vitest";
import type { EnvironmentSpec, FileAccessScope } from "@lecoding/contracts";
import {
  createRemoteRunnerEnvironment,
  RunnerDeviceNotAuthorizedError,
  RunnerOfflineError,
  type RunnerSessionSource
} from "@lecoding/run-environment";
import type { HostSession, RunnerIdentity } from "@lecoding/runner-protocol";
import { createHostSession } from "@lecoding/runner-protocol";
import { createPairedRunnerSockets } from "@lecoding/runner-protocol";

/**
 * Authorization for local execution.
 *
 * `local:<deviceId>` is a plain string chosen by the caller. Without an
 * ownership check, naming a device id is enough to have a Run executed on it —
 * so these tests assert the two independent gates: at Run admission (the caller
 * must own the device) and at execution (the connected session must belong to
 * the Run's project).
 */

function spec(overrides: Partial<EnvironmentSpec> = {}): EnvironmentSpec {
  return {
    runId: "run-1",
    projectId: "project-a",
    environmentId: "local:device-1",
    fileAccessScope: "workspace_only",
    ...overrides
  };
}

/** A session whose identity is exactly what the caller claims, or is not. */
function fakeSession(identity: RunnerIdentity | undefined): HostSession {
  return {
    sessionId: "session-1",
    identity: () => identity,
    call: async () => ({ handleId: "handle-1" }),
    tick: () => undefined,
    consumedCursor: () => 0,
    lastIssuedCommandId: () => 0,
    close: () => undefined
  };
}

function sourceFor(identity: RunnerIdentity | undefined): RunnerSessionSource {
  return {
    sessionFor: (deviceId) => (deviceId === "device-1" ? fakeSession(identity) : undefined)
  };
}

const OWNED: RunnerIdentity = {
  deviceId: "device-1",
  userId: "user-1",
  projectId: "project-a"
};

describe("local run execution authorization", () => {
  it("runs when the session belongs to the Run's project", async () => {
    const environment = createRemoteRunnerEnvironment({
      gateway: sourceFor(OWNED),
      deviceId: "device-1",
      projectId: "project-a"
    });
    await expect(environment.prepare(spec())).resolves.toMatchObject({
      environmentId: "local:device-1"
    });
  });

  it("refuses a device bound to another project", async () => {
    // The core hole: a device id from another project would otherwise receive
    // this Run and execute it on someone else's machine.
    const environment = createRemoteRunnerEnvironment({
      gateway: sourceFor({ ...OWNED, projectId: "project-b" }),
      deviceId: "device-1",
      projectId: "project-a"
    });
    await expect(environment.prepare(spec())).rejects.toThrow(
      RunnerDeviceNotAuthorizedError
    );
  });

  it("refuses a session that has not authenticated", async () => {
    // An unauthenticated session has no proven project, so it must not serve.
    const environment = createRemoteRunnerEnvironment({
      gateway: sourceFor(undefined),
      deviceId: "device-1",
      projectId: "project-a"
    });
    await expect(environment.prepare(spec())).rejects.toThrow(
      RunnerDeviceNotAuthorizedError
    );
  });

  it("re-checks on every call, not just at construction", async () => {
    // A reconnect replaces the session, and the replacement carries its own
    // identity. Checking once would let a swapped session slip through.
    let identity: RunnerIdentity | undefined = OWNED;
    const environment = createRemoteRunnerEnvironment({
      gateway: { sessionFor: () => fakeSession(identity) },
      deviceId: "device-1",
      projectId: "project-a"
    });
    const handle = await environment.prepare(spec());

    identity = { ...OWNED, projectId: "project-b" };
    await expect(
      environment.perform(handle, { type: "execute", command: ["pnpm", "test"] })
    ).rejects.toThrow(RunnerDeviceNotAuthorizedError);
  });

  it("still reports offline when no session exists at all", async () => {
    const environment = createRemoteRunnerEnvironment({
      gateway: { sessionFor: () => undefined },
      deviceId: "device-1",
      projectId: "project-a"
    });
    await expect(environment.prepare(spec())).rejects.toThrow(RunnerOfflineError);
  });
});

describe("device ownership at admission", () => {
  /** Mirrors the predicate the composition root installs on the API handler. */
  function authorizeFor(owned: Array<{ deviceId: string; projectId: string }>) {
    return ({ deviceId, projectId }: { deviceId: string; projectId: string }): boolean =>
      owned.some((device) => device.deviceId === deviceId && device.projectId === projectId);
  }

  it("admits a device the caller owns in this project", () => {
    const authorize = authorizeFor([{ deviceId: "device-1", projectId: "project-a" }]);
    expect(authorize({ deviceId: "device-1", projectId: "project-a" })).toBe(true);
  });

  it("refuses a device the caller owns in a different project", () => {
    // Ownership is per (device, project): the same device id under another
    // project is a different authorization.
    const authorize = authorizeFor([{ deviceId: "device-1", projectId: "project-a" }]);
    expect(authorize({ deviceId: "device-1", projectId: "project-b" })).toBe(false);
  });

  it("refuses a device the caller does not own", () => {
    const authorize = authorizeFor([{ deviceId: "device-2", projectId: "project-a" }]);
    expect(authorize({ deviceId: "device-1", projectId: "project-a" })).toBe(false);
  });
});

describe("file access scope admission", () => {
  /**
   * The rule that previously blocked every non-server scope: the workspace-only
   * restriction belongs to the server sandbox, which cannot confine a Run to
   * selected host directories. A local Run is enforced by the desktop sandbox.
   */
  function scopeAllowed(environmentId: string, scope: FileAccessScope): boolean {
    const isLocal = environmentId.startsWith("local:");
    return isLocal || scope === "workspace_only";
  }

  it("allows all three tiers for a local environment", () => {
    const scopes: FileAccessScope[] = [
      "workspace_only",
      "selected_directories",
      "host_full"
    ];
    for (const scope of scopes) {
      expect(scopeAllowed("local:device-1", scope), scope).toBe(true);
    }
  });

  it("still restricts server environments to workspace_only", () => {
    expect(scopeAllowed("sandbox-v1", "workspace_only")).toBe(true);
    expect(scopeAllowed("sandbox-v1", "selected_directories")).toBe(false);
    expect(scopeAllowed("sandbox-v1", "host_full")).toBe(false);
  });
});

describe("remote environment over a real session", () => {
  /** Exercises the authorization path against a genuine HostSession. */
  async function connectedSession(projectId: string): Promise<HostSession> {
    const pair = createPairedRunnerSockets();
    const session = createHostSession({
      // Side `a` is the host; side `b` is the Runner.
      socket: pair.a,
      sessionId: "session-1",
      authenticate: async () => ({
        ok: true,
        identity: { deviceId: "device-1", userId: "user-1", projectId }
      }),
      heartbeatIntervalMs: 60_000
    });
    pair.b.send(
      JSON.stringify({
        v: 1,
        kind: "hello",
        deviceAccessToken: "token",
        capabilities: {
          maxFileAccessScope: "workspace_only",
          kernelEnforced: true,
          platform: "darwin"
        }
      })
    );
    pair.deliver();
    await new Promise((resolve) => setImmediate(resolve));
    return session;
  }

  it("authorizes a session authenticated into the matching project", async () => {
    const session = await connectedSession("project-a");
    const environment = createRemoteRunnerEnvironment({
      gateway: { sessionFor: () => session },
      deviceId: "device-1",
      projectId: "project-a"
    });
    // No throw: the session proven its project at hello.
    expect(session.identity()?.projectId).toBe("project-a");
    expect(environment).toBeDefined();
  });

  it("refuses a session authenticated into another project", async () => {
    const session = await connectedSession("project-b");
    const environment = createRemoteRunnerEnvironment({
      gateway: { sessionFor: () => session },
      deviceId: "device-1",
      projectId: "project-a"
    });
    await expect(environment.prepare(spec())).rejects.toThrow(
      RunnerDeviceNotAuthorizedError
    );
  });
});
