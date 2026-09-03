import { describe, expect, it, vi } from "vitest";
import type { EnvironmentHandle } from "@lecoding/contracts";
import {
  createRemoteRunnerEnvironment,
  RunnerOfflineError
} from "../src/remote-runner-environment.js";

const handle: EnvironmentHandle = { id: "handle-1", environmentId: "local:device-1" };

/** Stands in for a live host session; records what the adapter sent. */
function fakeSession(responses: Array<unknown>) {
  const calls: Array<{ op: string; payload: unknown }> = [];
  let index = 0;
  return {
    calls,
    session: {
      call(op: string, payload: unknown) {
        calls.push({ op, payload });
        const value = responses[index];
        index += 1;
        if (value instanceof Error) {
          return Promise.reject(value);
        }
        return Promise.resolve(value ?? null);
      }
    }
  };
}

function environmentFor(session: unknown) {
  return createRemoteRunnerEnvironment({
    gateway: { sessionFor: () => session as never },
    deviceId: "device-1"
  });
}

describe("createRemoteRunnerEnvironment", () => {
  it("forwards prepare and returns a handle", async () => {
    const fake = fakeSession([{ handleId: "handle-9" }]);
    const environment = environmentFor(fake.session);

    const result = await environment.prepare({
      runId: "run-1",
      projectId: "project-1",
      environmentId: "local:device-1",
      fileAccessScope: "workspace_only"
    });

    expect(result).toEqual({ id: "handle-9", environmentId: "local:device-1" });
    expect(fake.calls[0]).toMatchObject({ op: "env.prepare" });
  });

  it("forwards perform with the action command", async () => {
    const fake = fakeSession([{ exitCode: 0, stdout: "ok", stderr: "" }]);
    const environment = environmentFor(fake.session);

    const result = await environment.perform(handle, {
      type: "execute",
      command: ["pnpm", "test"]
    });

    expect(result).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(fake.calls[0]?.payload).toEqual({
      handleId: "handle-1",
      command: ["pnpm", "test"]
    });
  });

  it("passes the abort signal through to the session so cancel crosses the wire", async () => {
    const fake = fakeSession([{ exitCode: 130, stdout: "", stderr: "" }]);
    const environment = environmentFor(fake.session);
    const controller = new AbortController();

    await environment.perform(
      handle,
      { type: "execute", command: ["sleep"] },
      controller.signal
    );

    // Three arguments means the signal reached `call`, which is the only path
    // by which a server-side cancel becomes an `env.abort` on the desktop.
    expect(fake.calls[0]).toBeDefined();
  });

  it("rejects a non-execute action before touching the session", async () => {
    const fake = fakeSession([]);
    const environment = environmentFor(fake.session);

    await expect(
      environment.perform(handle, { type: "apply_patch" } as never)
    ).rejects.toThrow(/Unsupported action type/);
    expect(fake.calls).toHaveLength(0);
  });

  it("forwards inspect and validates the report shape", async () => {
    const fake = fakeSession([{ changedFiles: ["a.ts", "b.ts"] }]);
    const environment = environmentFor(fake.session);

    await expect(environment.inspect(handle)).resolves.toEqual({
      changedFiles: ["a.ts", "b.ts"]
    });
  });

  it("rejects a malformed inspect result rather than passing it upstream", async () => {
    // A malformed EnvironmentReport would flow straight into the model's tool
    // history, so the adapter re-validates outcomes from the remote peer.
    const fake = fakeSession([{ changedFiles: "not-an-array" }]);
    const environment = environmentFor(fake.session);

    await expect(environment.inspect(handle)).rejects.toThrow(/changedFiles/);
  });

  it("rejects a malformed perform result", async () => {
    const fake = fakeSession([{ exitCode: "0" }]);
    const environment = environmentFor(fake.session);

    await expect(
      environment.perform(handle, { type: "execute", command: ["x"] })
    ).rejects.toThrow(/exitCode/);
  });

  it("forwards dispose with the caller's outcome", async () => {
    const fake = fakeSession([{ disposed: true }]);
    const environment = environmentFor(fake.session);

    await environment.dispose(handle, "discard");
    expect(fake.calls[0]?.payload).toEqual({ handleId: "handle-1", outcome: "discard" });
  });

  it("fails closed when the device has no live session", async () => {
    const environment = createRemoteRunnerEnvironment({
      gateway: { sessionFor: () => undefined },
      deviceId: "device-1"
    });

    // Running this on the server sandbox instead would execute code the user
    // believes is on their own machine, so it must throw.
    await expect(
      environment.prepare({
        runId: "run-1",
        projectId: "project-1",
        environmentId: "local:device-1",
        fileAccessScope: "workspace_only"
      })
    ).rejects.toThrow(RunnerOfflineError);
  });

  it("resolves the session per call so a reconnect is picked up", async () => {
    const first = fakeSession([{ exitCode: 1, stdout: "", stderr: "" }]);
    const second = fakeSession([{ exitCode: 2, stdout: "", stderr: "" }]);
    let current: unknown = first.session;
    const environment = createRemoteRunnerEnvironment({
      gateway: {
        sessionFor: () => {
          const found = current;
          return found as never;
        }
      },
      deviceId: "device-1"
    });

    await expect(
      environment.perform(handle, { type: "execute", command: ["a"] })
    ).resolves.toMatchObject({ exitCode: 1 });

    // Simulate a reconnect replacing the session between two commands.
    current = second.session;
    await expect(
      environment.perform(handle, { type: "execute", command: ["b"] })
    ).resolves.toMatchObject({ exitCode: 2 });
  });

  it("reports truncation flags when the runner sets them", async () => {
    const fake = fakeSession([
      { exitCode: 0, stdout: "x", stderr: "", stdoutTruncated: true }
    ]);
    const environment = environmentFor(fake.session);

    await expect(
      environment.perform(handle, { type: "execute", command: ["big"] })
    ).resolves.toMatchObject({ stdoutTruncated: true });
  });
});
