/**
 * Versioned WSS envelope for the Runner transport (M2.1).
 *
 * This module is deliberately free of transport and runtime dependencies: it
 * describes the wire contract only. `apps/worker` and `apps/desktop` supply the
 * `ws` adapters; everything between `encodeRunnerEnvelope` and
 * `decodeRunnerEnvelope` is pure and testable without a socket.
 *
 * ## Two counters, two directions
 *
 * The protocol carries two independent monotonic counters because the two
 * guarantees they protect run in opposite directions and must never be
 * conflated:
 *
 * - **commandId — allocated by the server, monotonically increasing per
 *   session.** It is the idempotency key for side effects. The Runner records
 *   every commandId it has accepted; a resent command returns the recorded
 *   outcome instead of executing twice.
 *
 * - **cursor — allocated by the Runner, monotonically increasing per session.**
 *   It orders everything the Runner sends upward (`result` and `event` share
 *   one sequence). The server reports the highest cursor it has durably
 *   consumed, which lets the Runner trim its replay window.
 *
 * Keeping them separate is what makes "never lose an event" and "never repeat a
 * side effect" independently provable: replay is cursor-driven and safe to
 * repeat, redelivery is commandId-driven and must not repeat.
 *
 * ## Handshake
 *
 * The WebSocket handshake carries no credential — a token in the URL would
 * leak into proxy and access logs. The Runner instead authenticates with the
 * first frame it sends (`hello`). Reconnection resumes through the *same*
 * frame: `hello.resume` is optional, so authenticate-and-resume is one atomic
 * step and there is no window in which a session is authenticated but not yet
 * resumed.
 */

import type { FileAccessScope, JsonValue } from "@lecoding/contracts";

/** Wire version. Raising it is a breaking change both peers must agree on in `hello`. */
export const RUNNER_PROTOCOL_VERSION = 1;

/**
 * Hard cap on a single encoded frame.
 *
 * A larger frame is rejected rather than buffered so one peer cannot drive the
 * other into an out-of-memory kill by streaming an unbounded payload. It sits
 * above the 8 MiB `BoundedOutputCapture` default because command output is
 * transported as one `result` frame; the Runner must still bound what it sends.
 */
export const RUNNER_MAX_FRAME_BYTES = 2 * 1024 * 1024;

/**
 * Operations the server may ask the desktop Runner to perform.
 *
 * They mirror `RunEnvironment` one-for-one so the remote adapter stays a
 * pass-through and RunEngine keeps a single contract. `env.abort` is the only
 * addition: it carries the cancellation that `RunEnvironment.perform` receives
 * as an `AbortSignal` and that `prepare` / `inspect` need for M2.3.
 */
export type RunnerCommandOp =
  | "env.prepare"
  | "env.perform"
  | "env.inspect"
  | "env.dispose"
  | "env.abort";

/** What the Runner can actually enforce on this host, declared before any Run starts. */
export interface RunnerCapabilities {
  /** Highest file-access tier the local sandbox can enforce on this platform. */
  maxFileAccessScope: FileAccessScope;
  /**
   * True when the sandbox enforces inside the kernel rather than only at argv
   * inspection time. The server uses this to refuse — not silently downgrade —
   * a Run that asked for more isolation than the host can provide.
   */
  kernelEnforced: boolean;
  platform: "darwin" | "win32" | "linux";
}

/** How far the Runner got before the previous connection dropped. */
export interface RunnerResumeHint {
  /**
   * Highest commandId the Runner already accepted. The server resends from
   * `lastReceivedCommandId + 1`; the Runner's dedupe table makes the resend of
   * anything at or below it a no-op.
   */
  lastReceivedCommandId: number;
}

/** Terminal outcome of one command. Cached by commandId so a resend is free. */
export type RunnerCommandOutcome =
  | { ok: true; value: JsonValue }
  | { ok: false; code: RunnerErrorCode; message: string };

/**
 * Upward progress notifications that are not command results.
 *
 * The set is closed, exactly like `RunEventType`: adding a kind is a versioned
 * contract change, so every server can decode every Runner's stream.
 */
export type RunnerProgressEvent =
  /** A file access the Runner observed, including every out-of-scope attempt. */
  | {
      type: "audit.host_access";
      runId: string;
      path: string;
      kind: "read" | "write" | "execute";
      outOfScope: boolean;
      recordedAt: string;
    }
  /** A path cleanup failed to remove. Surfaces to the operator for manual recovery. */
  | { type: "residual.path"; runId: string; path: string; reason: string };

/**
 * Failure codes shared by `nack` (server rejects a Runner frame) and
 * `RunnerCommandOutcome` (Runner reports a failed command).
 *
 * The Runner-facing codes are coarse on purpose: they cross a trust boundary,
 * so they carry intent ("rebind", "do not retry", "operator must act") and
 * never stack traces, paths from the server's own disk, or token fragments.
 */
export type RunnerErrorCode =
  // — authentication / session lifecycle —
  /** Any frame other than `hello` arrived before authentication completed. */
  | "auth_required"
  /** The device token does not resolve to a live device. */
  | "auth_failed"
  /** The device was revoked; the Runner must stop and ask the user to rebind. */
  | "device_revoked"
  /** The device credential expired; same handling as revocation. */
  | "device_expired"
  // — protocol —
  | "protocol_version_mismatch"
  /** The frame is not a well-formed envelope of a known kind. */
  | "malformed_envelope"
  | "frame_too_large"
  // — command dispatch —
  /** A result referenced a commandId this session never issued. */
  | "unknown_command"
  /**
   * The command was started but its outcome is unknown (the Runner process died
   * mid-execution). The Runner must NOT re-execute it; this code exists so the
   * engine can fail the Run instead of repeating an unobservable side effect.
   */
  | "command_interrupted"
  /** The command is invalid for the Run's current state, e.g. perform before prepare. */
  | "command_conflict"
  /** The handle id does not belong to a prepared environment. */
  | "handle_unknown"
  // — sandbox —
  /** The command touched a path outside the Run's FileAccessGrant. */
  | "scope_violation"
  /** The host cannot enforce the requested tier; never silently downgraded. */
  | "sandbox_unsupported"
  // — catch-all —
  | "internal";

/**
 * WebSocket close codes in the 4000–4999 application range.
 *
 * `device_revoked` is separated from a generic close so the Runner can
 * distinguish "your credential is dead, go rebind" from "the server went away,
 * retry" — collapsing them makes a revoked device reconnect forever.
 */
export type RunnerCloseCode =
  /** Ordinary shutdown, e.g. user quit the desktop client. */
  | 4000
  /** The device was revoked or expired; the Runner must clear credentials. */
  | 4001
  /** The peer violated the protocol and the session is not recoverable. */
  | 4002
  /** The server is shutting down; the Runner should reconnect with backoff. */
  | 4003
  /** Another session for the same device took over; this one must not retry. */
  | 4004;

/**
 * One frame on the wire.
 *
 * Frames are grouped by direction in comments because that grouping is part of
 * the contract: the server must never emit a Runner-only kind and vice versa.
 */
export type RunnerEnvelope =
  // ——— Runner → server ———
  /**
   * First frame of every connection. Carries the credential (never the URL) and
   * optionally the resume hint that makes reconnection recoverable.
   */
  | {
      v: 1;
      kind: "hello";
      deviceAccessToken: string;
      capabilities: RunnerCapabilities;
      resume?: RunnerResumeHint;
    }
  /** Terminal outcome of one command, and the idempotency record for it. */
  | { v: 1; kind: "result"; id: number; cursor: number; outcome: RunnerCommandOutcome }
  /** Non-terminal upward notification. Shares the cursor sequence with `result`. */
  | { v: 1; kind: "event"; cursor: number; event: RunnerProgressEvent }
  // ——— server → Runner ———
  /** Accepts the session and tells the Runner where replay and redelivery start. */
  | {
      v: 1;
      kind: "welcome";
      sessionId: string;
      deviceId: string;
      projectId: string;
      heartbeatIntervalMs: number;
      /** Cursor the Runner must replay from: the last one the server consumed, plus one. */
      replayFromCursor: number;
      /** Command id the server will redeliver from: the Runner's `lastReceivedCommandId`, plus one. */
      replayFromCommandId: number;
    }
  /** One unit of work. `id` is the server-allocated idempotency key. */
  | { v: 1; kind: "command"; id: number; op: RunnerCommandOp; payload: JsonValue }
  // ——— either direction ———
  /**
   * "I have durably consumed every upward frame up to and including `cursor`."
   * Lets the peer trim its replay window; it is not an acknowledgement that a
   * command's effect was applied.
   */
  | { v: 1; kind: "ack"; cursor: number }
  /** The peer's last frame was rejected. Terminal for that frame, not the session. */
  | { v: 1; kind: "nack"; code: RunnerErrorCode; message: string }
  /**
   * Liveness plus the sender's own cursor, so one frame serves both keepalive
   * and replay-window synchronization. The server sends its consumed cursor;
   * the Runner sends its produced cursor.
   */
  | { v: 1; kind: "heartbeat"; cursor: number }
  /** Intentional close with a reason the peer can branch on. */
  | { v: 1; kind: "goodbye"; code: RunnerCloseCode; reason?: string };

/** Payload shape per operation. Wire validation stays at `JsonValue`; callers get types. */
export interface RunnerCommandPayloadByOp {
  "env.prepare": {
    runId: string;
    projectId: string;
    environmentId: string;
    fileAccessScope: FileAccessScope;
  };
  "env.perform": { handleId: string; command: string[] };
  "env.inspect": { handleId: string };
  "env.dispose": { handleId: string; outcome: "keep" | "discard" };
  /** Cancels the command identified by `targetCommandId` (an `env.perform`, usually). */
  "env.abort": { targetCommandId: number };
}

/** All envelope kinds, used by the codec to reject unknown kinds in O(1). */
export const RUNNER_ENVELOPE_KINDS = [
  "hello",
  "result",
  "event",
  "welcome",
  "command",
  "ack",
  "nack",
  "heartbeat",
  "goodbye"
] as const;

export type RunnerEnvelopeKind = RunnerEnvelope["kind"];

/** All command operations, used by the codec to reject unknown ops in O(1). */
export const RUNNER_COMMAND_OPS: readonly RunnerCommandOp[] = [
  "env.prepare",
  "env.perform",
  "env.inspect",
  "env.dispose",
  "env.abort"
];

/** All protocol error codes, used by the codec to reject unknown codes in O(1). */
export const RUNNER_ERROR_CODES: readonly RunnerErrorCode[] = [
  "auth_required",
  "auth_failed",
  "device_revoked",
  "device_expired",
  "protocol_version_mismatch",
  "malformed_envelope",
  "frame_too_large",
  "unknown_command",
  "command_interrupted",
  "command_conflict",
  "handle_unknown",
  "scope_violation",
  "sandbox_unsupported",
  "internal"
];

/** Application close codes. Anything outside this set was not produced by us. */
export const RUNNER_CLOSE_CODES: readonly RunnerCloseCode[] = [4000, 4001, 4002, 4003, 4004];
