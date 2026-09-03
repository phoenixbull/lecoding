import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@lecoding/contracts";
import {
  createHostSession,
  RunnerCommandFailedError,
  RunnerSessionClosedError,
  type HostSession,
  type RunnerAuthResult,
  type RunnerIdentity
} from "../src/host-session.js";
import {
  createPairedRunnerSockets,
  type RunnerSocketPair
} from "../src/paired-sockets.js";
import { createRunnerSession, type RunnerSession } from "../src/runner-session.js";
import type { RunnerCapabilities, RunnerProgressEvent } from "../src/envelope.js";

const identity: RunnerIdentity = {
  deviceId: "device-1",
  userId: "user-1",
  projectId: "project-1"
};

const capabilities: RunnerCapabilities = {
  maxFileAccessScope: "workspace_only",
  kernelEnforced: true,
  platform: "darwin"
};

const audit: RunnerProgressEvent = {
  type: "audit.host_access",
  runId: "run-1",
  path: "/tmp/outside",
  kind: "write",
  outOfScope: true,
  recordedAt: "2026-09-03T00:00:00.000Z"
};

/** Lets the async `authenticate` callback settle so `welcome` has been sent. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  pair: RunnerSocketPair;
  host: HostSession;
  runner: RunnerSession;
  calls: Array<{ op: string; payload: JsonValue }>;
  events: RunnerProgressEvent[];
  welcomes: Array<{ replayFromCursor: number; replayFromCommandId: number }>;
  disconnects: number;
}

function createHarness(
  overrides: {
    authenticate?: (token: string) => Promise<RunnerAuthResult>;
    handlers?: Partial<{
      prepare: (payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>;
      perform: (payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>;
      inspect: (payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>;
      dispose: (payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>;
    }>;
    initialConsumedCursor?: number;
    lastReceivedCommandId?: number;
    maxFrames?: number;
    maxTrackedCommands?: number;
  } = {}
): Harness {
  const pair = createPairedRunnerSockets();
  const calls: Harness["calls"] = [];
  const events: RunnerProgressEvent[] = [];
  const welcomes: Harness["welcomes"] = [];
  let disconnects = 0;

  const host = createHostSession({
    socket: pair.a,
    sessionId: "session-1",
    authenticate:
      overrides.authenticate ?? (async () => ({ ok: true, identity })),
    onEvent: (event) => events.push(event),
    // Wrapped in a resolver because the gateway looks the cursor up by device,
    // which is only known once the hello has been authenticated.
    ...(overrides.initialConsumedCursor !== undefined
      ? { initialConsumedCursor: () => overrides.initialConsumedCursor ?? 0 }
      : {})
  });

  const runner = createRunnerSession({
    deviceAccessToken: "device-token",
    capabilities,
    handlers: {
      prepare: async (payload, signal) => {
        calls.push({ op: "env.prepare", payload });
        return overrides.handlers?.prepare?.(payload, signal) ?? { handleId: "handle-1" };
      },
      perform: async (payload, signal) => {
        calls.push({ op: "env.perform", payload });
        return overrides.handlers?.perform?.(payload, signal) ?? { exitCode: 0 };
      },
      inspect: async (payload, signal) => {
        calls.push({ op: "env.inspect", payload });
        return overrides.handlers?.inspect?.(payload, signal) ?? { changedFiles: [] };
      },
      dispose: async (payload, signal) => {
        calls.push({ op: "env.dispose", payload });
        return overrides.handlers?.dispose?.(payload, signal) ?? { disposed: true };
      }
    },
    onWelcome: (info) =>
      welcomes.push({
        replayFromCursor: info.replayFromCursor,
        replayFromCommandId: info.replayFromCommandId
      }),
    onDisconnect: () => {
      disconnects += 1;
    },
    ...(overrides.lastReceivedCommandId !== undefined
      ? { lastReceivedCommandId: overrides.lastReceivedCommandId }
      : {}),
    ...(overrides.maxFrames !== undefined ? { maxFrames: overrides.maxFrames } : {}),
    ...(overrides.maxTrackedCommands !== undefined
      ? { maxTrackedCommands: overrides.maxTrackedCommands }
      : {})
  });

  runner.connect(pair.b);

  return {
    pair,
    host,
    runner,
    calls,
    events,
    welcomes,
    get disconnects() {
      return disconnects;
    }
  } as Harness;
}

describe("runner session handshake", () => {
  it("authenticates with hello and exchanges welcome", async () => {
    const h = createHarness();
    await settle();

    expect(h.host.identity()).toEqual(identity);
    expect(h.welcomes).toEqual([{ replayFromCursor: 1, replayFromCommandId: 1 }]);
  });

  it("passes the device token in the hello frame, never in the URL", async () => {
    const h = createHarness();
    await settle();
    const hello = JSON.parse(h.pair.wire()[0]!.text) as { kind: string; deviceAccessToken: string };
    expect(hello.kind).toBe("hello");
    expect(hello.deviceAccessToken).toBe("device-token");
  });

  it("closes with 4001 when the credential is rejected", async () => {
    const h = createHarness({
      authenticate: async () => ({ ok: false, code: "device_revoked" })
    });
    await settle();

    expect(h.host.identity()).toBeUndefined();
    expect(h.pair.closed()).toBe(true);
    const goodbye = h.pair
      .wire()
      .map((frame) => JSON.parse(frame.text) as { kind: string; code?: number })
      .find((frame) => frame.kind === "goodbye");
    expect(goodbye?.code).toBe(4001);
  });

  it("nacks a non-hello first frame", async () => {
    const h = createHarness();
    h.pair.b.send('{"v":1,"kind":"heartbeat","cursor":0}');
    await settle();

    const nack = h.pair
      .wire()
      .map((frame) => JSON.parse(frame.text) as { kind: string; code?: string })
      .find((frame) => frame.kind === "nack");
    expect(nack?.code).toBe("auth_required");
  });

  it("refuses to dispatch a command before authentication completes", async () => {
    const pair = createPairedRunnerSockets();
    const host = createHostSession({
      socket: pair.a,
      sessionId: "s",
      authenticate: async () => ({ ok: false, code: "auth_failed" })
    });
    await expect(host.call("env.inspect", { handleId: "h" })).rejects.toThrow(
      RunnerSessionClosedError
    );
  });
});

describe("runner session command dispatch", () => {
  it("dispatches a command and resolves with the returned value", async () => {
    const h = createHarness();
    await settle();

    await expect(
      h.host.call("env.perform", { handleId: "handle-1", command: ["pnpm", "test"] })
    ).resolves.toEqual({ exitCode: 0 });
    expect(h.calls).toEqual([
      { op: "env.perform", payload: { handleId: "handle-1", command: ["pnpm", "test"] } }
    ]);
  });

  it("surfaces a failed outcome as a RunnerCommandFailedError", async () => {
    const h = createHarness({
      handlers: {
        perform: async () => {
          throw new Error("spawn ENOENT");
        }
      }
    });
    await settle();

    await expect(h.host.call("env.perform", { handleId: "h", command: ["x"] })).rejects.toThrow(
      RunnerCommandFailedError
    );
    try {
      await h.host.call("env.perform", { handleId: "h", command: ["x"] });
    } catch (error) {
      expect((error as RunnerCommandFailedError).code).toBe("internal");
    }
  });

  it("executes a redelivered command only once", async () => {
    // The core M2.1 guarantee: a resent commandId must not repeat a side effect.
    const h = createHarness();
    await settle();

    await h.host.call("env.perform", { handleId: "h", command: ["pnpm", "test"] });

    // Replay the exact command frame the server already sent.
    const commandFrame = h.pair
      .wire()
      .map((frame) => JSON.parse(frame.text) as { kind: string; id?: number })
      .find((frame) => frame.kind === "command");
    const redelivery = h.pair
      .wire()
      .find((frame) => (JSON.parse(frame.text) as { kind: string }).kind === "command")!;
    h.pair.a.send(redelivery.text);
    await settle();

    expect(commandFrame).toBeDefined();
    expect(h.calls).toHaveLength(1);
  });

  it("executes a concurrent redelivery only once", async () => {
    // A resend arriving while the first attempt is still running must attach to
    // it rather than start a second execution.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = createHarness({
      handlers: {
        perform: async () => {
          await gate;
          return { exitCode: 0 };
        }
      }
    });
    await settle();

    // `call` sends the command synchronously, so the frame is on the wire as
    // soon as it is invoked — before the command has been served.
    const first = h.host.call("env.perform", { handleId: "h", command: ["sleep"] });
    const commandText = h.pair
      .wire()
      .find((frame) => (JSON.parse(frame.text) as { kind: string }).kind === "command")!.text;

    // Redeliver the same command id while the first attempt is still running.
    h.pair.a.send(commandText);
    await settle();
    release();

    await expect(first).resolves.toEqual({ exitCode: 0 });
    await settle();
    expect(h.calls).toHaveLength(1);
  });

  it("aborts an in-flight command and reports command_interrupted", async () => {
    let abortSignal: AbortSignal | undefined;
    let observedAborted = false;
    const h = createHarness({
      handlers: {
        perform: async (_payload, signal) => {
          abortSignal = signal;
          await new Promise((resolve) => setTimeout(resolve, 50));
          observedAborted = signal.aborted;
          return { exitCode: 0 };
        }
      }
    });
    await settle();

    const controller = new AbortController();
    const pending = h.host.call("env.perform", { handleId: "h", command: ["sleep"] }, controller.signal);
    await settle();
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    await new Promise((resolve) => setTimeout(resolve, 80));
    // The Runner's handler must observe the abort through its own signal: that
    // is the path by which a server cancel reaches a spawned child process.
    expect(abortSignal?.aborted).toBe(true);
    expect(observedAborted).toBe(true);
  });
});

describe("runner session events and replay", () => {
  it("delivers emitted events to the host", async () => {
    const h = createHarness();
    await settle();

    h.runner.emit(audit);
    await settle();

    expect(h.events).toEqual([audit]);
  });

  it("replays only events the host never acknowledged", async () => {
    // Proves "resume from the last confirmed cursor": cursor 1 was acked before
    // the drop, so only cursor 2 may be replayed.
    const h = createHarness();
    await settle();

    h.runner.emit(audit);
    await settle();
    h.host.tick(); // sends ack for cursor 1
    await settle();

    h.runner.emit({ ...audit, path: "/tmp/second" });
    await settle();
    expect(h.host.consumedCursor()).toBe(2);

    // Drop the transport; the Runner session survives and reconnects.
    h.pair.a.close(4003, "network drop");

    const reconnected = createPairedRunnerSockets();
    const replayed: RunnerProgressEvent[] = [];
    const host2 = createHostSession({
      socket: reconnected.a,
      sessionId: "session-2",
      authenticate: async () => ({ ok: true, identity }),
      onEvent: (event) => replayed.push(event),
      // Carried forward by the gateway: cursor 1 was already consumed.
      initialConsumedCursor: () => 1
    });
    h.runner.connect(reconnected.b);
    await settle();

    expect(host2.consumedCursor()).toBe(2);
    expect(replayed).toEqual([{ ...audit, path: "/tmp/second" }]);
  });

  it("tells the runner where to resume from on reconnect", async () => {
    const h = createHarness({ lastReceivedCommandId: 7 });
    await settle();

    // Server redelivers from 8; the runner asked to resume after 7.
    expect(h.welcomes[0]?.replayFromCommandId).toBe(8);
  });

  it("replays events in their original order after a reconnect", async () => {
    const h = createHarness();
    await settle();

    h.runner.emit({ ...audit, path: "/tmp/a" });
    h.runner.emit({ ...audit, path: "/tmp/b" });
    h.runner.emit({ ...audit, path: "/tmp/c" });
    await settle();
    h.pair.a.close(4003, "drop");

    const reconnected = createPairedRunnerSockets();
    const replayed: string[] = [];
    createHostSession({
      socket: reconnected.a,
      sessionId: "session-2",
      authenticate: async () => ({ ok: true, identity }),
      onEvent: (event) => replayed.push(event.type === "audit.host_access" ? event.path : "")
    });
    h.runner.connect(reconnected.b);
    await settle();

    expect(replayed).toEqual(["/tmp/a", "/tmp/b", "/tmp/c"]);
  });

  it("trims the replay window once the host acknowledges", async () => {
    const h = createHarness({ maxFrames: 4 });
    await settle();

    h.runner.emit(audit);
    await settle();
    h.host.tick();
    await settle();
    h.pair.a.close(4003, "drop");

    // Everything up to cursor 1 was acked, so a reconnect must not resend it.
    const reconnected = createPairedRunnerSockets();
    const replayed: RunnerProgressEvent[] = [];
    createHostSession({
      socket: reconnected.a,
      sessionId: "session-2",
      authenticate: async () => ({ ok: true, identity }),
      onEvent: (event) => replayed.push(event),
      initialConsumedCursor: () => 1
    });
    h.runner.connect(reconnected.b);
    await settle();

    expect(replayed).toEqual([]);
  });

  it("reports when local replay can no longer be complete", async () => {
    // Bounded window + a server that never acks = eventual overflow. The session
    // must be able to say so instead of pretending replay was lossless.
    const h = createHarness({ maxFrames: 2 });
    await settle();

    for (let i = 0; i < 5; i += 1) {
      h.runner.emit({ ...audit, path: `/tmp/${i}` });
    }
    expect(h.runner.replayOverflowed()).toBe(true);
  });
});

describe("runner session lifecycle", () => {
  it("sends a heartbeat when one is due", async () => {
    let clock = 0;
    const pair = createPairedRunnerSockets();
    const host = createHostSession({
      socket: pair.a,
      sessionId: "s",
      authenticate: async () => ({ ok: true, identity }),
      heartbeatIntervalMs: 1_000,
      now: () => clock
    });
    createRunnerSession({
      deviceAccessToken: "t",
      capabilities,
      handlers: {
        prepare: async () => ({}),
        perform: async () => ({}),
        inspect: async () => ({}),
        dispose: async () => ({})
      }
    }).connect(pair.b);
    await settle();

    clock = 1_000;
    host.tick();
    const heartbeat = pair
      .wire()
      .map((frame) => JSON.parse(frame.text) as { kind: string })
      .filter((frame) => frame.kind === "heartbeat");
    expect(heartbeat.length).toBeGreaterThan(0);
  });

  it("drops the connection when the peer goes silent past the timeout", async () => {
    let clock = 0;
    const pair = createPairedRunnerSockets();
    const host = createHostSession({
      socket: pair.a,
      sessionId: "s",
      authenticate: async () => ({ ok: true, identity }),
      heartbeatIntervalMs: 1_000,
      now: () => clock
    });
    createRunnerSession({
      deviceAccessToken: "t",
      capabilities,
      handlers: {
        prepare: async () => ({}),
        perform: async () => ({}),
        inspect: async () => ({}),
        dispose: async () => ({})
      },
      now: () => clock
    }).connect(pair.b);
    await settle();

    // Two missed heartbeats: 2x the interval is the timeout.
    clock = 2_001;
    host.tick();
    expect(pair.closed()).toBe(true);
  });

  it("rejects in-flight commands when the transport dies", async () => {
    const h = createHarness({
      handlers: {
        perform: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { exitCode: 0 };
        }
      }
    });
    await settle();

    const pending = h.host.call("env.perform", { handleId: "h", command: ["sleep"] });
    await settle();
    h.pair.a.close(4003, "network drop");

    await expect(pending).rejects.toThrow(RunnerSessionClosedError);
  });

  it("notifies the runner on disconnect so the app can reconnect", async () => {
    const h = createHarness();
    await settle();

    h.pair.a.close(4003, "network drop");
    expect(h.disconnects).toBe(1);
    expect(h.runner.connected()).toBe(false);
  });

  it("keeps dedupe state across a reconnect", async () => {
    const h = createHarness();
    await settle();
    await h.host.call("env.inspect", { handleId: "h" });

    h.pair.a.close(4003, "drop");
    const reconnected = createPairedRunnerSockets();
    const host2 = createHostSession({
      socket: reconnected.a,
      sessionId: "session-2",
      authenticate: async () => ({ ok: true, identity })
    });
    h.runner.connect(reconnected.b);
    await settle();

    // Re-issue command id 1 (the new session restarts its counter at 1). The
    // runner already executed id 1, so it must answer from cache, not re-run.
    await expect(host2.call("env.inspect", { handleId: "h" })).resolves.toEqual({
      changedFiles: []
    });
    expect(h.calls).toHaveLength(1);
  });

  it("ignores duplicate welcome frames", async () => {
    const h = createHarness();
    await settle();
    const welcomesBefore = h.welcomes.length;

    h.pair.a.send(
      JSON.stringify({
        v: 1,
        kind: "welcome",
        sessionId: "s",
        deviceId: "d",
        projectId: "p",
        heartbeatIntervalMs: 1000,
        replayFromCursor: 1,
        replayFromCommandId: 1
      })
    );
    expect(h.welcomes.length).toBe(welcomesBefore);
  });
});
