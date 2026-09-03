import { describe, expect, it, vi } from "vitest";
import { createHostSession, type HostSession, type RunnerIdentity } from "../src/host-session.js";
import { createQueuedRunnerSocket } from "../src/queued-socket.js";
import type { RunnerSocket, RunnerSocketClose } from "../src/runner-socket.js";

/**
 * Recovery semantics that only break across *connections*.
 *
 * These failures are invisible to a single-session test: the dedupe table and
 * the command counter are both correct in isolation, and only go wrong when one
 * survives a reconnect and the other does not.
 */

const IDENTITY: RunnerIdentity = {
  deviceId: "device-1",
  userId: "user-1",
  projectId: "project-a"
};

/**
 * Drains pending microtasks *and* macrotasks.
 *
 * `hello` is handled by an async function awaited inside a `void`-called
 * handler, so a couple of `Promise.resolve()` ticks is not enough to observe
 * the `welcome` frame.
 */
async function flush(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A socket whose open/close the test drives explicitly. */
function controllableSocket() {
  const sent: string[] = [];
  const messageListeners = new Set<(text: string) => void>();
  const closeListeners = new Set<(info: RunnerSocketClose) => void>();
  let open = false;
  let closed = false;

  const socket: RunnerSocket = {
    send(text) {
      if (!open) {
        // Stand-in for `ws`: frames sent before the handshake are dropped.
        throw new Error("socket is not open");
      }
      sent.push(text);
    },
    close(code, reason) {
      if (closed) {
        return;
      }
      closed = true;
      for (const listener of [...closeListeners]) {
        listener({ code, reason: reason ?? "" });
      }
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    }
  };

  return {
    socket,
    sent,
    isOpen: () => open,
    open() {
      open = true;
    },
    deliver(text: string) {
      for (const listener of [...messageListeners]) {
        listener(text);
      }
    },
    close(code = 1006, reason = "") {
      socket.close(code, reason);
    }
  };
}

/** Adapts a controllable socket through the shared queue, as production does. */
function queuedSocket() {
  const control = controllableSocket();
  const openListeners = new Set<() => void>();
  let closed = false;

  const socket = createQueuedRunnerSocket({
    send: (text) => control.socket.send(text),
    close: (code, reason) => control.socket.close(code, reason),
    onOpen(listener) {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    // Delegated to the transport, so frames delivered below actually reach the
    // session subscribed above.
    onMessage: (listener) => control.socket.onMessage(listener),
    onClose: (listener) => control.socket.onClose(listener)
  });

  return {
    socket,
    sent: control.sent,
    /** Opens the underlying transport, as the handshake completing would. */
    openTransport() {
      control.open();
      for (const listener of [...openListeners]) {
        listener();
      }
    },
    deliver(text: string) {
      control.deliver(text);
    },
    close(code?: number, reason?: string) {
      if (closed) {
        return;
      }
      closed = true;
      control.close(code, reason);
    }
  };
}

function helloFrame(resumeLastReceivedCommandId?: number): string {
  return JSON.stringify({
    v: 1,
    kind: "hello",
    deviceAccessToken: "token",
    capabilities: {
      maxFileAccessScope: "workspace_only",
      kernelEnforced: true,
      platform: "darwin"
    },
    ...(resumeLastReceivedCommandId !== undefined
      ? { resume: { lastReceivedCommandId: resumeLastReceivedCommandId } }
      : {})
  });
}

const options = {
  sessionId: "session-1",
  authenticate: async () =>
    ({ ok: true, identity: IDENTITY }) as const,
  heartbeatIntervalMs: 1_000
};

describe("hello delivery before the transport opens", () => {
  it("queues the hello and delivers it once the socket opens", async () => {
    // The bug this guards: a real `ws` client is CONNECTING when the session
    // sends hello, the frame is dropped, and the Runner never authenticates.
    // In-memory sockets are open immediately, so only this shape catches it.
    const transport = queuedSocket();
    const session = createHostSession({
      ...options,
      socket: transport.socket,
      now: () => 0
    });

    transport.deliver(helloFrame());
    await flush();
    // Sent before open: must be buffered, not lost.
    expect(transport.sent).toEqual([]);

    transport.openTransport();
    const welcomes = transport.sent.filter((frame) => frame.includes('"welcome"'));
    expect(welcomes).toHaveLength(1);
    expect(session.identity()).toEqual(IDENTITY);
  });

  it("does not lose the hello when the transport was already open", async () => {
    // Already-open transports must behave identically, or the queue would be a
    // hidden mode switch between the two adapters.
    const transport = queuedSocket();
    transport.openTransport();
    const session = createHostSession({
      ...options,
      socket: transport.socket,
      now: () => 0
    });

    transport.deliver(helloFrame());
    await flush();
    expect(transport.sent.filter((frame) => frame.includes('"welcome"'))).toHaveLength(1);
    expect(session.identity()).toEqual(IDENTITY);
  });
});

describe("command ids across reconnections", () => {
  /** Runs a session that issues one command and reports the id it used. */
  async function issueOneCommand(
    resumeLastReceivedCommandId: number | undefined,
    initialCommandId: (mark: number) => number,
    issued: number[]
  ): Promise<void> {
    const transport = queuedSocket();
    transport.openTransport();
    const session: HostSession = createHostSession({
      ...options,
      socket: transport.socket,
      now: () => 0,
      initialCommandId: (_identity, mark) => initialCommandId(mark),
      onCommandIdIssued: (id) => issued.push(id)
    });
    transport.deliver(helloFrame(resumeLastReceivedCommandId));
    await flush();
    // The rejection when the transport dies is expected; swallowing it here
    // keeps the suite free of unhandled rejections, which would otherwise
    // mask real failures elsewhere in the run.
    session.call("env.prepare", { runId: "run-1" }).catch(() => undefined);
    transport.close(1006, "network dropped");
  }

  it("never reissues an id the Runner has already seen", async () => {
    // The P0: each session numbered from 1, while the Runner's dedupe table
    // survives. A new command would be answered from a stale cache and never
    // run. The gateway must start above the Runner's high-water mark.
    const issued: number[] = [];
    await issueOneCommand(undefined, (mark) => Math.max(1, mark + 1), issued);
    expect(issued[0]).toBe(1);

    // Reconnect: the Runner remembers having received command 1.
    await issueOneCommand(1, (mark) => Math.max(1, mark + 1), issued);
    expect(issued).toEqual([1, 2]);
    // Strictly increasing, and never 1 again.
    expect(new Set(issued).size).toBe(issued.length);
  });

  it("starts above the gateway's own mark even if the Runner reports none", async () => {
    // The other half of the invariant: the Runner may have forgotten ids the
    // gateway still remembers, so its "0" must not pull numbering backwards.
    const issued: number[] = [];
    await issueOneCommand(undefined, (mark) => Math.max(1, mark + 1), issued);
    await issueOneCommand(0, (mark) => Math.max(5, mark + 1), issued);
    expect(issued).toEqual([1, 5]);
  });

  it("advertises nextCommandId so the Runner can detect a gap", async () => {
    const transport = queuedSocket();
    transport.openTransport();
    createHostSession({
      ...options,
      socket: transport.socket,
      now: () => 0,
      initialCommandId: () => 7
    });
    transport.deliver(helloFrame(0));
    await flush();

    const welcome = transport.sent
      .map((frame) => JSON.parse(frame) as { kind: string; nextCommandId?: number })
      .find((frame) => frame.kind === "welcome");
    expect(welcome?.nextCommandId).toBe(7);
  });
});

describe("hello timeout", () => {
  it("closes a connection that never identifies itself", async () => {
    // Without this, an unauthenticated peer holds a socket and a registry slot
    // forever, because it is not in the authenticated set the gateway ticks.
    const transport = queuedSocket();
    transport.openTransport();
    let clock = 0;
    const closes: number[] = [];
    const session = createHostSession({
      ...options,
      socket: transport.socket,
      helloTimeoutMs: 5_000,
      now: () => clock
    });
    session.tick();

    // Still within the deadline.
    clock = 4_999;
    session.tick();
    expect(closes).toEqual([]);

    transport.socket.onClose((info) => closes.push(info.code));
    // Re-tick past the deadline; the session closes with 4001 (credential dead).
    clock = 5_000;
    session.tick();
    expect(closes).toContain(4001);
    expect(session.identity()).toBeUndefined();
  });
});

describe("heartbeat credential revalidation", () => {
  it("closes a session whose device was revoked since it connected", async () => {
    // Revocation is written by another request or another Worker. A session
    // that only checked at hello would keep serving a dead device.
    const transport = queuedSocket();
    transport.openTransport();
    let clock = 0;
    let revoked = false;
    const closes: number[] = [];

    const session = createHostSession({
      ...options,
      socket: transport.socket,
      heartbeatIntervalMs: 1_000,
      now: () => clock,
      revalidate: async () => {
        if (revoked) {
          return { ok: false, code: "device_revoked" };
        }
        return { ok: true, identity: IDENTITY };
      }
    });
    transport.socket.onClose((info) => closes.push(info.code));

    transport.deliver(helloFrame());
    await flush();
    expect(session.identity()).toEqual(IDENTITY);

    revoked = true;
    clock = 1_000;
    session.tick();
    await flush();

    expect(closes).toContain(4001);
  });

  it("treats a revalidation that throws as a failure to prove the credential", async () => {
    // Fail closed: an unreadable credential store must not extend trust.
    const transport = queuedSocket();
    transport.openTransport();
    const closes: number[] = [];
    let clock = 0;
    const session = createHostSession({
      ...options,
      socket: transport.socket,
      heartbeatIntervalMs: 1_000,
      now: () => clock,
      revalidate: async () => {
        throw new Error("database unavailable");
      }
    });
    transport.socket.onClose((info) => closes.push(info.code));

    transport.deliver(helloFrame());
    await flush();
    // Revalidation is due one interval after the session was accepted.
    clock = 1_000;
    session.tick();
    await flush();

    expect(closes).toContain(4001);
  });

  it("does not start overlapping revalidations", async () => {
    const transport = queuedSocket();
    transport.openTransport();
    let clock = 0;
    // Never settles, so overlapping ticks must not pile up on top of it.
    const revalidate = vi.fn(() => new Promise<Awaited<ReturnType<typeof options.authenticate>>>(() => undefined));
    const session = createHostSession({
      ...options,
      socket: transport.socket,
      heartbeatIntervalMs: 1_000,
      now: () => clock,
      revalidate
    });

    transport.deliver(helloFrame());
    await flush();
    clock = 1_000;
    session.tick();
    session.tick();
    session.tick();
    await flush();

    // One in flight: further ticks must not start a second revalidation.
    expect(revalidate).toHaveBeenCalledTimes(1);
  });
});
