import { describe, expect, it, vi } from "vitest";
import {
  createPairedRunnerSockets,
  type RunnerEnvironmentHandlers,
  type RunnerSocket,
  type RunnerSocketPair
} from "@lecoding/runner-protocol";
import { createRunnerBroker, type RunnerBrokerState } from "../src/main/runner-broker.js";

const handlers: RunnerEnvironmentHandlers = {
  prepare: async () => ({ handleId: "h" }),
  perform: async () => ({ exitCode: 0 }),
  inspect: async () => ({ changedFiles: [] }),
  dispose: async () => ({ disposed: true })
};

/** Runs scheduled retries immediately so tests never sleep. */
function immediateSchedule(delays: number[]) {
  return (delayMs: number, run: () => void) => {
    delays.push(delayMs);
    run();
    return () => undefined;
  };
}

interface Harness {
  delays: number[];
  states: RunnerBrokerState[];
  pairs: RunnerSocketPair[];
  broker: ReturnType<typeof createRunnerBroker>;
  /** Opens the next transport and returns its server-side socket. */
  nextServerSocket(): RunnerSocket;
}

function createHarness(
  overrides: {
    token?: string | undefined;
    backoff?: { baseDelayMs?: number; factor?: number; jitter?: number };
    maxAttempts?: number;
  } = {}
): Harness {
  const delays: number[] = [];
  const states: RunnerBrokerState[] = [];
  const pairs: RunnerSocketPair[] = [];

  const broker = createRunnerBroker({
    connect() {
      const pair = createPairedRunnerSockets();
      pairs.push(pair);
      return pair.b;
    },
    credential: async () => overrides.token,
    capabilities: {
      maxFileAccessScope: "workspace_only",
      kernelEnforced: true,
      platform: "darwin"
    },
    handlers,
    schedule: immediateSchedule(delays),
    onStateChange: (state) => states.push(state),
    backoffOptions: overrides.backoff ?? { baseDelayMs: 100, factor: 2, jitter: 0 }
  });

  return {
    delays,
    states,
    pairs,
    broker,
    nextServerSocket() {
      return pairs[pairs.length - 1]!.a;
    }
  };
}

/** Sends `welcome` from the server side of the most recent connection. */
async function welcome(pair: RunnerSocketPair): Promise<void> {
  pair.a.send(
    JSON.stringify({
      v: 1,
      kind: "welcome",
      sessionId: "s1",
      deviceId: "device-1",
      projectId: "project-1",
      heartbeatIntervalMs: 15_000,
      replayFromCursor: 1,
      nextCommandId: 1
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createRunnerBroker", () => {
  it("stays idle when there is no device credential", async () => {
    const h = createHarness({ token: undefined });
    await h.broker.start();

    // Retrying a credential that does not exist yet would spin forever; the
    // user has to bind a device first.
    expect(h.broker.state()).toBe("idle");
    expect(h.pairs).toHaveLength(0);
    expect(h.delays).toEqual([]);
  });

  it("connects and reports live after welcome", async () => {
    const h = createHarness({ token: "device-token" });
    await h.broker.start();
    expect(h.broker.state()).toBe("connecting");

    await welcome(h.pairs[0]!);
    expect(h.broker.state()).toBe("live");
  });

  it("reconnects after a dropped transport with backoff", async () => {
    const h = createHarness({ token: "device-token" });
    await h.broker.start();
    await welcome(h.pairs[0]!);

    h.pairs[0]!.a.close(4003, "network drop");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.broker.state()).toBe("reconnecting");
    expect(h.delays).toEqual([100]);
    expect(h.pairs).toHaveLength(2);
  });

  it("grows the delay across successive failures", async () => {
    const h = createHarness({ token: "device-token" });
    await h.broker.start();

    h.pairs[0]!.a.close(4003, "drop");
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.pairs[1]!.a.close(4003, "drop");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.delays).toEqual([100, 200]);
    expect(h.pairs).toHaveLength(3);
  });

  it("resets the backoff after a successful exchange", async () => {
    // A brief blip must not leave the client on a long retry schedule.
    const h = createHarness({ token: "device-token" });
    await h.broker.start();

    h.pairs[0]!.a.close(4003, "drop");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.delays).toEqual([100]);

    await welcome(h.pairs[1]!);
    expect(h.broker.state()).toBe("live");

    h.pairs[1]!.a.close(4003, "drop");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.delays).toEqual([100, 100]);
  });

  it("stops retrying when the device is revoked", async () => {
    // Retrying a revoked credential forever is the failure this prevents: the
    // user must rebind, and reconnecting cannot change that.
    const h = createHarness({ token: "device-token" });
    await h.broker.start();
    await welcome(h.pairs[0]!);

    h.pairs[0]!.a.close(4001, "device revoked");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.broker.state()).toBe("stopped");
    expect(h.delays).toEqual([]);
    expect(h.pairs).toHaveLength(1);
  });

  it("stops retrying when another session supersedes this one", async () => {
    const h = createHarness({ token: "device-token" });
    await h.broker.start();

    h.pairs[0]!.a.close(4004, "session superseded");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.broker.state()).toBe("stopped");
    expect(h.delays).toEqual([]);
  });

  it("reuses one session across reconnects so dedupe state survives", async () => {
    // The session holds the dedupe table and the replay window; rebuilding it
    // per socket would make resume impossible.
    const h = createHarness({ token: "device-token" });
    await h.broker.start();
    const session = h.broker.session();

    h.pairs[0]!.a.close(4003, "drop");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.broker.session()).toBe(session);
  });

  it("sends hello with the credential in the frame, not the URL", async () => {
    const h = createHarness({ token: "device-token" });
    await h.broker.start();

    const hello = JSON.parse(h.pairs[0]!.wire()[0]!.text) as {
      kind: string;
      deviceAccessToken: string;
    };
    expect(hello.kind).toBe("hello");
    expect(hello.deviceAccessToken).toBe("device-token");
  });

  it("carries the restored command id into the resume hint", async () => {
    const h = createHarness({ token: "device-token" });
    const broker = createRunnerBroker({
      connect() {
        const pair = createPairedRunnerSockets();
        h.pairs.push(pair);
        return pair.b;
      },
      credential: async () => "device-token",
      capabilities: {
        maxFileAccessScope: "workspace_only",
        kernelEnforced: true,
        platform: "darwin"
      },
      handlers,
      lastReceivedCommandId: () => 41,
      schedule: immediateSchedule(h.delays),
      backoffOptions: { baseDelayMs: 100, jitter: 0 }
    });
    await broker.start();

    const hello = JSON.parse(h.pairs[0]!.wire()[0]!.text) as {
      resume?: { lastReceivedCommandId: number };
    };
    expect(hello.resume?.lastReceivedCommandId).toBe(41);
  });

  it("cancels a pending retry on stop", async () => {
    // The schedule never runs the retry, so one stays pending when stop() is
    // called — that is the case where a leaked timer would reconnect a client
    // the user already quit.
    let cancelled = false;
    const pairs: RunnerSocketPair[] = [];
    const broker = createRunnerBroker({
      connect() {
        const pair = createPairedRunnerSockets();
        pairs.push(pair);
        return pair.b;
      },
      credential: async () => "device-token",
      capabilities: {
        maxFileAccessScope: "workspace_only",
        kernelEnforced: true,
        platform: "darwin"
      },
      handlers,
      schedule: () => () => {
        cancelled = true;
      }
    });
    await broker.start();
    pairs[0]!.a.close(4003, "drop");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(broker.state()).toBe("reconnecting");

    broker.stop();
    expect(cancelled).toBe(true);
    expect(broker.state()).toBe("stopped");
  });

  it("does not reconnect after stop", async () => {
    const h = createHarness({ token: "device-token" });
    await h.broker.start();
    h.broker.stop();

    h.pairs[0]!.a.close(4003, "drop");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.pairs).toHaveLength(1);
    expect(h.broker.session()).toBeUndefined();
  });

  it("reports state transitions in order", async () => {
    const h = createHarness({ token: "device-token" });
    await h.broker.start();
    await welcome(h.pairs[0]!);
    h.broker.stop();

    expect(h.states).toEqual(["connecting", "live", "stopped"]);
  });
});
