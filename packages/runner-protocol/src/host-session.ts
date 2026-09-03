/**
 * Server-side Runner session — one side of the WSS conversation.
 *
 * The host owns the two things that make recovery work: it *allocates*
 * `commandId` (so it alone decides what to redeliver) and it *tracks the
 * consumed cursor* (so the Runner knows what to replay). Both survive the
 * socket: a reconnect produces a new `HostSession` but the gateway carries the
 * consumed cursor forward, which is what makes replay resume rather than restart.
 *
 * There are deliberately no timers in here. Liveness and reconnection are driven
 * by `tick()`, which the gateway calls from its own interval, so tests advance a
 * virtual clock instead of waiting for real time.
 */

import type { JsonValue } from "@lecoding/contracts";
import { RunnerProtocolError, decodeRunnerEnvelope, encodeRunnerEnvelope } from "./codec.js";
import {
  type RunnerCloseCode,
  type RunnerCommandOp,
  type RunnerEnvelope,
  type RunnerErrorCode,
  type RunnerProgressEvent
} from "./envelope.js";
import { createHeartbeatMonitor, type HeartbeatMonitor } from "./reconnect.js";
import type { RunnerSocket, RunnerSocketClose } from "./runner-socket.js";

/** Who the Runner proved itself to be. Everything downstream is scoped by this. */
export interface RunnerIdentity {
  deviceId: string;
  userId: string;
  projectId: string;
}

/**
 * Authentication outcome.
 *
 * `code` is returned rather than thrown so the transport layer stays free of
 * exception plumbing, and so `device_revoked` can be distinguished from a
 * generic bad token — the Runner treats revocation as "rebind" and everything
 * else as "retry", and conflating them makes a dead device reconnect forever.
 */
export type RunnerAuthResult =
  | { ok: true; identity: RunnerIdentity }
  | { ok: false; code: RunnerErrorCode };

export interface HostSessionOptions {
  socket: RunnerSocket;
  sessionId: string;
  /**
   * Resolves a device access token to an identity. Never throw for an expected
   * rejection — return `{ ok: false, code }` so the close code stays accurate.
   */
  authenticate(token: string): Promise<RunnerAuthResult>;
  /** Receives upward progress events (audit rows, residual paths). */
  onEvent?(event: RunnerProgressEvent): void;
  /**
   * Called whenever the consumed cursor advances.
   *
   * The gateway persists this per device so the next connection resumes from
   * here rather than from zero.
   */
  onConsumedCursor?(cursor: number): void;
  /** Called when the transport dies and the session is finished. */
  onClose?(info: RunnerSocketClose): void;
  /**
   * Cursor already consumed for the authenticated device, read once `hello`
   * succeeds.
   *
   * It is a function rather than a value because the device is not known until
   * authentication completes, and the gateway keys this by device so a
   * reconnect resumes from where the previous connection stopped.
   */
  initialConsumedCursor?(identity: RunnerIdentity): number;
  heartbeatIntervalMs?: number;
  now?: () => number;
}

export interface HostSession {
  readonly sessionId: string;
  /** Undefined until the Runner's `hello` is accepted. */
  identity(): RunnerIdentity | undefined;

  /**
   * Sends a command and resolves with its outcome value.
   *
   * Rejects if the transport dies first, or with an `AbortError` if `signal`
   * fires — in which case an `env.abort` is also sent so the Runner can stop a
   * side effect that is already under way.
   */
  call(
    op: RunnerCommandOp,
    payload: JsonValue,
    signal?: AbortSignal
  ): Promise<JsonValue>;

  /**
   * Drives liveness: sends a heartbeat when one is due and closes the session
   * when the peer has been silent past the timeout.
   */
  tick(): void;

  /** Highest cursor durably consumed from the Runner. */
  consumedCursor(): number;

  /** Highest command id issued on this connection. */
  lastIssuedCommandId(): number;

  close(code: RunnerCloseCode, reason?: string): void;
}

/** Raised for `call` when the transport dies underneath an in-flight command. */
export class RunnerSessionClosedError extends Error {
  readonly code: RunnerErrorCode;

  constructor(code: RunnerErrorCode, message: string) {
    super(message);
    this.name = "RunnerSessionClosedError";
    this.code = code;
  }
}

interface PendingCommand {
  resolve(value: JsonValue): void;
  reject(error: unknown): void;
  op: RunnerCommandOp;
}

export function createHostSession(options: HostSessionOptions): HostSession {
  const { socket, sessionId, authenticate } = options;
  const now = options.now ?? Date.now;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;

  let identity: RunnerIdentity | undefined;
  /** Set from the gateway once authenticated, so replay resumes, not restarts. */
  let consumed = 0;
  /** Highest cursor acknowledged back to the Runner, so it can trim its window. */
  let lastAcked = 0;
  let nextCommandId = 1;
  let closed = false;

  const pending = new Map<number, PendingCommand>();
  const monitor: HeartbeatMonitor = createHeartbeatMonitor({
    heartbeatIntervalMs,
    now
  });

  const offMessage = socket.onMessage((text) => {
    void handleFrame(text);
  });
  const offClose = socket.onClose((info) => {
    finish(info.code, info.reason);
  });

  function send(envelope: RunnerEnvelope): void {
    try {
      socket.send(encodeRunnerEnvelope(envelope));
    } catch {
      // A frame we cannot encode is our bug, not the peer's; close rather than
      // leave the peer waiting on a command that will never arrive.
      close(4002, "server failed to encode a frame");
    }
  }

  async function handleFrame(text: string): Promise<void> {
    let envelope: RunnerEnvelope;
    try {
      envelope = decodeRunnerEnvelope(text);
    } catch (error) {
      if (error instanceof RunnerProtocolError) {
        send({ v: 1, kind: "nack", code: error.code, message: error.message });
        // A version mismatch or an oversized frame is not recoverable by
        // retrying the same peer; continuing would just spam nacks.
        if (error.code === "protocol_version_mismatch" || error.code === "frame_too_large") {
          close(4002, error.message);
        }
      }
      return;
    }
    monitor.noteActivity();

    if (!identity) {
      await handleUnauthenticated(envelope);
      return;
    }
    handleAuthenticated(envelope);
  }

  async function handleUnauthenticated(envelope: RunnerEnvelope): Promise<void> {
    if (envelope.kind !== "hello") {
      send({ v: 1, kind: "nack", code: "auth_required", message: "hello must be the first frame" });
      return;
    }
    let result: RunnerAuthResult;
    try {
      result = await authenticate(envelope.deviceAccessToken);
    } catch {
      result = { ok: false, code: "internal" };
    }
    if (!result.ok) {
      // Every credential failure closes with the same code: from the Runner's
      // point of view the token is dead and the user must rebind.
      send({ v: 1, kind: "nack", code: result.code, message: "Device credential was rejected" });
      close(4001, result.code);
      return;
    }
    identity = result.identity;
    consumed = options.initialConsumedCursor?.(identity) ?? 0;
    lastAcked = consumed;
    // Resume is part of the same exchange as authenticate, so there is no
    // window where a session is authenticated but not yet resumed.
    const replayFromCommandId = (envelope.resume?.lastReceivedCommandId ?? 0) + 1;
    send({
      v: 1,
      kind: "welcome",
      sessionId,
      deviceId: identity.deviceId,
      projectId: identity.projectId,
      heartbeatIntervalMs,
      replayFromCursor: consumed + 1,
      replayFromCommandId
    });
  }

  function handleAuthenticated(envelope: RunnerEnvelope): void {
    switch (envelope.kind) {
      case "result": {
        // Consume in cursor order: a gap would mean a lost upward frame, which
        // the replay window exists to repair rather than to paper over.
        const entry = pending.get(envelope.id);
        if (entry) {
          pending.delete(envelope.id);
          if (envelope.outcome.ok) {
            entry.resolve(envelope.outcome.value);
          } else {
            entry.reject(
              new RunnerCommandFailedError(envelope.outcome.code, envelope.outcome.message)
            );
          }
        }
        advanceConsumed(envelope.cursor);
        return;
      }
      case "event": {
        options.onEvent?.(envelope.event);
        advanceConsumed(envelope.cursor);
        return;
      }
      case "heartbeat": {
        return;
      }
      case "goodbye": {
        close(4000, envelope.reason ?? "runner said goodbye");
        return;
      }
      default: {
        // Anything else is a frame only the host is allowed to send.
        send({
          v: 1,
          kind: "nack",
          code: "malformed_envelope",
          message: `Runner sent a host-only frame: ${envelope.kind}`
        });
      }
    }
  }

  function advanceConsumed(cursor: number): void {
    if (cursor <= consumed) {
      return;
    }
    consumed = cursor;
    options.onConsumedCursor?.(cursor);
  }

  function finish(code: number, reason: string): void {
    if (closed) {
      return;
    }
    closed = true;
    offMessage();
    offClose();
    const error = new RunnerSessionClosedError(
      code === 4001 ? "device_revoked" : "internal",
      `Runner session closed (${code}): ${reason}`
    );
    for (const entry of [...pending.values()]) {
      entry.reject(error);
    }
    pending.clear();
    options.onClose?.({ code, reason });
  }

  function close(code: RunnerCloseCode, reason?: string): void {
    try {
      socket.send(encodeRunnerEnvelope({ v: 1, kind: "goodbye", code, ...(reason ? { reason } : {}) }));
    } catch {
      // Best effort: the peer may already be gone.
    }
    socket.close(code, reason ?? "");
    finish(code, reason ?? "");
  }

  return {
    sessionId,

    identity() {
      return identity;
    },

    async call(op, payload, signal) {
      if (closed) {
        throw new RunnerSessionClosedError("internal", "Runner session is closed");
      }
      if (!identity) {
        throw new RunnerSessionClosedError(
          "auth_required",
          "Runner session is not authenticated yet"
        );
      }
      if (signal?.aborted) {
        throw new DOMException("Command aborted before dispatch", "AbortError");
      }

      const id = nextCommandId;
      nextCommandId += 1;

      const settled = new Promise<JsonValue>((resolve, reject) => {
        pending.set(id, { resolve, reject, op });
      });

      send({ v: 1, kind: "command", id, op, payload });

      if (!signal) {
        return await settled;
      }

      // Cancellation is best-effort downward: we reject locally so the engine
      // stops waiting, and also tell the Runner so it can stop a side effect
      // that is already under way.
      return await new Promise<JsonValue>((resolve, reject) => {
        const onAbort = () => {
          pending.delete(id);
          send({
            v: 1,
            kind: "command",
            id: nextCommandId++,
            op: "env.abort",
            payload: { targetCommandId: id }
          });
          reject(new DOMException("Command aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        void settled.then(resolve, reject).finally(() => {
          signal.removeEventListener("abort", onAbort);
        });
      });
    },

    tick() {
      if (closed) {
        return;
      }
      if (monitor.isTimedOut()) {
        close(4002, "runner heartbeat timed out");
        return;
      }
      // Acknowledging is batching: one ack per tick covers every frame consumed
      // since the last one, which is what keeps the Runner's replay window small
      // without turning every event into a round trip.
      if (consumed > lastAcked) {
        lastAcked = consumed;
        send({ v: 1, kind: "ack", cursor: lastAcked });
      }
      if (monitor.msUntilNextHeartbeat() === 0) {
        send({ v: 1, kind: "heartbeat", cursor: consumed });
        monitor.noteHeartbeatSent();
      }
    },

    consumedCursor() {
      return consumed;
    },

    lastIssuedCommandId() {
      return nextCommandId - 1;
    },

    close(code, reason) {
      close(code, reason);
    }
  };
}

/** Raised when the Runner reports a failed command outcome. */
export class RunnerCommandFailedError extends Error {
  readonly code: RunnerErrorCode;

  constructor(code: RunnerErrorCode, message: string) {
    super(message);
    this.name = "RunnerCommandFailedError";
    this.code = code;
  }
}
