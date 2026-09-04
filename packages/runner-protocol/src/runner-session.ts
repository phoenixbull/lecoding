/**
 * Desktop-side Runner session — the peer that owns side effects.
 *
 * Every guarantee M2.1 is judged on lands here:
 *
 * - **Commands execute at most once.** `commandId` goes through the dedupe
 *   table, so a redelivery after reconnect returns the recorded outcome and a
 *   concurrent redelivery attaches to the in-flight attempt.
 * - **Nothing upward is lost.** Every result and event is recorded in the replay
 *   window before it is sent, so `welcome.replayFromCursor` can be honoured
 *   exactly.
 * - **Cancellation reaches the process.** The session owns one `AbortController`
 *   per in-flight command and wires `env.abort` to it, which is how the server's
 *   `AbortSignal` crosses the wire and reaches a spawned child process.
 *
 * ## The session outlives the socket
 *
 * A dropped connection is normal; a restarted Runner is not. The dedupe table
 * and the replay window belong to the *session*, not to the transport, so
 * `connect()` may be called again with a fresh socket and both survive. That is
 * what makes resume work: the server says "replay from cursor 2" and this
 * session still holds cursor 2, because it never went away.
 *
 * The application supplies only the four `RunEnvironment` operations; replay,
 * dedupe, heartbeat and resume are protocol machinery and stay here.
 */

import type { JsonValue } from "@lecoding/contracts";
import { createCommandDedupe, type CommandDedupe } from "./command-dedupe.js";
import { RunnerProtocolError, decodeRunnerEnvelope, encodeRunnerEnvelope } from "./codec.js";
import { createEventWindow, type EventWindow } from "./event-window.js";
import {
  type RunnerCapabilities,
  type RunnerCloseCode,
  type RunnerCommandOp,
  type RunnerCommandOutcome,
  type RunnerEnvelope,
  type RunnerProgressEvent
} from "./envelope.js";
import { createHeartbeatMonitor, type HeartbeatMonitor } from "./reconnect.js";
import type {
  RunnerSocket,
  RunnerSocketClose,
  RunnerSocketUnsubscribe
} from "./runner-socket.js";

/**
 * One environment operation.
 *
 * `signal` fires when the server sends `env.abort`; `context.commandId` is the
 * transport-allocated id of this specific invocation, which a journalling
 * handler needs to record the effect before it happens. It is supplied here
 * rather than inside `payload` so it cannot be forged or forgotten by a caller
 * building payloads.
 */
export type RunnerEnvironmentHandler = (
  payload: JsonValue,
  signal: AbortSignal,
  context: { commandId: number }
) => Promise<JsonValue>;

/** Mirrors `RunEnvironment`; `dispose` receives the keep/discard outcome. */
export interface RunnerEnvironmentHandlers {
  prepare: RunnerEnvironmentHandler;
  perform: RunnerEnvironmentHandler;
  inspect: RunnerEnvironmentHandler;
  dispose: RunnerEnvironmentHandler;
}

/** The server's resume instructions, surfaced for diagnostics. */
export interface RunnerWelcomeInfo {
  sessionId: string;
  deviceId: string;
  projectId: string;
  heartbeatIntervalMs: number;
  replayFromCursor: number;
  nextCommandId: number;
}

export interface RunnerSessionOptions {
  deviceAccessToken: string;
  capabilities: RunnerCapabilities;
  handlers: RunnerEnvironmentHandlers;
  /**
   * Highest command id already accepted, restored from the durable journal on
   * restart. Becomes the `hello.resume` hint so the server redelivers from here
   * instead of replaying the whole Run.
   */
  lastReceivedCommandId?: number;
  onWelcome?(info: RunnerWelcomeInfo): void;
  /** Fires whenever the current transport dies. The session stays reconnectable. */
  onDisconnect?(info: RunnerSocketClose): void;
  now?: () => number;
  /** Dedupe capacity; see `createCommandDedupe`. */
  maxTrackedCommands?: number;
  /** Replay window capacity; see `createEventWindow`. */
  maxFrames?: number;
  /**
   * Seeds the dedupe table from durable state before the session opens.
   *
   * This is how a *restarted* Runner keeps its at-most-once guarantee: the
   * journal knows which command ids settled and which were interrupted, and
   * replaying them here means a redelivered id is answered from that record
   * instead of executed again. An interrupted command is seeded as a failure,
   * because its effect cannot be known.
   *
   * Caller obligation: seed before the first `connect`. Entries already
   * tracked are left alone, so seeding twice is harmless.
   */
  seedCommands?(entries: Array<{ id: number; outcome: RunnerCommandOutcome }>): void;
}

export interface RunnerSession {
  /**
   * Binds a transport and sends `hello`.
   *
   * Call again with a new socket to reconnect; dedupe state, the replay window
   * and accepted command ids all carry over.
   */
  connect(socket: RunnerSocket): void;
  /**
   * Primes the dedupe table from durable state.
   *
   * See the option of the same name for why this exists: a restarted Runner
   * must answer a redelivered command id from what it already did, not run it
   * again. Idempotent — an id already tracked is left alone.
   */
  seedCommands(
    entries: Array<{ id: number; outcome: RunnerCommandOutcome }>
  ): void;
  /** True while a transport is bound. */
  connected(): boolean;
  /** Records a progress event and sends it upward. Safe before `welcome`. */
  emit(event: RunnerProgressEvent): void;
  /** Sends a heartbeat when due and drops the connection when the server goes silent. */
  tick(): void;
  /** Highest command id accepted so far — persist for the next resume. */
  lastReceivedCommandId(): number;
  /** True once local replay could no longer be complete. */
  replayOverflowed(): boolean;
  /** Ends the session for good; no further `connect` is expected. */
  close(code: RunnerCloseCode, reason?: string): void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export function createRunnerSession(options: RunnerSessionOptions): RunnerSession {
  const { handlers } = options;
  const now = options.now ?? Date.now;

  const dedupe: CommandDedupe = createCommandDedupe(
    options.maxTrackedCommands !== undefined
      ? { maxTrackedCommands: options.maxTrackedCommands }
      : {}
  );

  /*
   * Recovery is consumed here, at construction, before any socket exists.
   *
   * The callback receives an array it fills in — the same inverted shape the
   * broker uses — because the session owns the dedupe table and the caller owns
   * the journal. Skipping this call is how a restarted Runner ended up with a
   * blank dedupe table and re-executed a command its own journal said had
   * already run.
   */
  if (options.seedCommands) {
    const seed: Array<{ id: number; outcome: RunnerCommandOutcome }> = [];
    options.seedCommands(seed);
    for (const { id, outcome } of seed) {
      dedupe.seed(id, outcome);
    }
  }
  const window: EventWindow = createEventWindow(
    options.maxFrames !== undefined ? { maxFrames: options.maxFrames } : {}
  );

  let socket: RunnerSocket | undefined;
  let unsubscribe: RunnerSocketUnsubscribe[] = [];
  let heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
  let monitor: HeartbeatMonitor = createHeartbeatMonitor({ heartbeatIntervalMs, now });
  let lastReceivedCommandId = options.lastReceivedCommandId ?? 0;
  let welcomed = false;
  let terminated = false;

  /** One AbortController per in-flight command, keyed by the command's own id. */
  const inFlight = new Map<number, AbortController>();

  function sendFrame(frame: RunnerEnvelope): void {
    if (!socket) {
      return;
    }
    try {
      socket.send(encodeRunnerEnvelope(frame));
    } catch {
      disconnect(4002, "runner failed to encode a frame");
    }
  }

  async function handleFrame(text: string): Promise<void> {
    let envelope: RunnerEnvelope;
    try {
      envelope = decodeRunnerEnvelope(text);
    } catch (error) {
      if (error instanceof RunnerProtocolError) {
        sendFrame({ v: 1, kind: "nack", code: error.code, message: error.message });
      }
      return;
    }
    monitor.noteActivity();

    switch (envelope.kind) {
      case "welcome": {
        if (welcomed) {
          return;
        }
        welcomed = true;
        heartbeatIntervalMs = envelope.heartbeatIntervalMs;
        monitor = createHeartbeatMonitor({ heartbeatIntervalMs, now });
        options.onWelcome?.({
          sessionId: envelope.sessionId,
          deviceId: envelope.deviceId,
          projectId: envelope.projectId,
          heartbeatIntervalMs: envelope.heartbeatIntervalMs,
          replayFromCursor: envelope.replayFromCursor,
          nextCommandId: envelope.nextCommandId
        });
        replayFrom(envelope.replayFromCursor);
        return;
      }
      case "command": {
        void serveCommand(envelope.id, envelope.op, envelope.payload);
        return;
      }
      case "ack": {
        // The server has consumed everything up to this cursor, so the window
        // can forget it — this is what keeps replay bounded.
        window.trim(envelope.cursor);
        return;
      }
      case "heartbeat": {
        // Reply so the server can tell a slow Runner from a dead one.
        sendFrame({ v: 1, kind: "heartbeat", cursor: window.latest() });
        return;
      }
      case "nack": {
        // A credential nack is terminal; the user must rebind.
        if (
          envelope.code === "auth_required" ||
          envelope.code === "auth_failed" ||
          envelope.code === "device_revoked" ||
          envelope.code === "device_expired"
        ) {
          close(4001, envelope.code);
        }
        return;
      }
      case "goodbye": {
        close(4000, envelope.reason ?? "server said goodbye");
        return;
      }
      default: {
        sendFrame({
          v: 1,
          kind: "nack",
          code: "malformed_envelope",
          message: `Server sent a runner-only frame: ${envelope.kind}`
        });
      }
    }
  }

  /** Re-sends upward frames the server has not acknowledged, in original order. */
  function replayFrom(replayFromCursor: number): void {
    for (const frame of window.after(replayFromCursor - 1)) {
      sendFrame(frame);
    }
  }

  async function serveCommand(
    id: number,
    op: RunnerCommandOp,
    payload: JsonValue
  ): Promise<void> {
    if (id > lastReceivedCommandId) {
      lastReceivedCommandId = id;
    }
    if (!welcomed) {
      // Serve nothing before welcome: replay boundaries are not established yet.
      return;
    }

    const outcome = await dedupe.run(id, () => execute(id, op, payload));
    sendFrame(window.record({ kind: "result", id, outcome }));
  }

  async function execute(
    id: number,
    op: RunnerCommandOp,
    payload: JsonValue
  ): Promise<RunnerCommandOutcome> {
    if (op === "env.abort") {
      abortTarget(payload);
      return { ok: true, value: { aborted: true } };
    }
    const handler = handlerFor(op);
    if (!handler) {
      return {
        ok: false,
        code: "command_conflict",
        message: `Unsupported runner command op: ${op}`
      };
    }

    const controller = new AbortController();
    inFlight.set(id, controller);
    try {
      /*
       * The command id travels as context, not inside the payload.
       *
       * It belongs to the transport, not to the operation: the server allocates
       * it and the dedupe table consumes it, so asking a handler to read it out
       * of a payload meant every caller had to invent a place to put it. A
       * handler that needs it for journalling gets it here, authoritatively.
       */
      return {
        ok: true,
        value: await handler(payload, controller.signal, { commandId: id })
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          ok: false,
          code: "command_interrupted",
          message: "Command was aborted by the server"
        };
      }
      return {
        ok: false,
        code: "internal",
        message: error instanceof Error ? error.message.slice(0, 500) : "Command failed"
      };
    } finally {
      inFlight.delete(id);
    }
  }

  /**
   * Applies a server-initiated cancellation.
   *
   * Idempotent on purpose: aborting a command that already finished is a no-op,
   * so a redelivered `env.abort` is harmless.
   */
  function abortTarget(payload: JsonValue): void {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return;
    }
    const target = (payload as Record<string, unknown>)["targetCommandId"];
    if (typeof target !== "number") {
      return;
    }
    inFlight.get(target)?.abort();
  }

  function handlerFor(op: RunnerCommandOp): RunnerEnvironmentHandler | undefined {
    switch (op) {
      case "env.prepare":
        return handlers.prepare;
      case "env.perform":
        return handlers.perform;
      case "env.inspect":
        return handlers.inspect;
      case "env.dispose":
        return handlers.dispose;
      default:
        return undefined;
    }
  }

  /**
   * Ends the session for good.
   *
   * Distinct from `disconnect`: this sends `goodbye`, closes the transport and
   * marks the session terminated so a later `connect` is refused. Used when the
   * server says goodbye, or when the credential is rejected and reconnecting
   * would only re-fail against a dead device.
   */
  function close(code: RunnerCloseCode, reason?: string): void {
    if (terminated) {
      return;
    }
    terminated = true;
    sendFrame({ v: 1, kind: "goodbye", code, ...(reason ? { reason } : {}) });
    const current = socket;
    disconnect(code, reason ?? "closed");
    current?.close(code, reason ?? "");
  }

  /** Tears down the current transport but leaves the session reconnectable. */
  function disconnect(code: number, reason: string): void {
    for (const off of unsubscribe) {
      off();
    }
    unsubscribe = [];
    const wasConnected = socket !== undefined;
    socket = undefined;
    welcomed = false;
    // Nobody can receive these results any more, and leaving child processes
    // running would leak the user's machine.
    for (const controller of [...inFlight.values()]) {
      controller.abort();
    }
    inFlight.clear();
    if (wasConnected) {
      options.onDisconnect?.({ code, reason });
    }
  }

  return {
    seedCommands(entries) {
      for (const { id, outcome } of entries) {
        // `seed` is a no-op for an id already tracked, so seeding after a
        // reconnect cannot clobber a fresher result recorded this session.
        dedupe.seed(id, outcome);
      }
    },

    connect(nextSocket) {
      if (terminated) {
        return;
      }
      disconnect(4000, "reconnecting");
      socket = nextSocket;
      unsubscribe = [
        nextSocket.onMessage((text) => {
          void handleFrame(text);
        }),
        nextSocket.onClose((info) => {
          disconnect(info.code, info.reason);
        })
      ];
      sendFrame({
        v: 1,
        kind: "hello",
        deviceAccessToken: options.deviceAccessToken,
        capabilities: options.capabilities,
        resume: { lastReceivedCommandId }
      });
    },

    connected() {
      return socket !== undefined;
    },

    emit(event) {
      sendFrame(window.record({ kind: "event", event }));
    },

    tick() {
      if (!socket) {
        return;
      }
      if (monitor.isTimedOut()) {
        // Drop the transport so the app can reconnect; the session survives.
        const current = socket;
        disconnect(4002, "server heartbeat timed out");
        current.close(4002, "server heartbeat timed out");
        return;
      }
      if (monitor.msUntilNextHeartbeat() === 0) {
        sendFrame({ v: 1, kind: "heartbeat", cursor: window.latest() });
        monitor.noteHeartbeatSent();
      }
    },

    lastReceivedCommandId() {
      return lastReceivedCommandId;
    },

    replayOverflowed() {
      return window.overflowed() > 0;
    },

    close(code, reason) {
      close(code, reason);
    }
  };
}
