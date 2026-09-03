/**
 * `@lecoding/runner-protocol` — the zero-dependency core of the Runner wire
 * protocol (Phase 4B / M2.1).
 *
 * What belongs here: the wire contract, its strict codec, the transport
 * interface, and the session-level state machines (dedupe, replay, reconnect)
 * that both peers must agree on.
 *
 * What does NOT belong here: anything transport-specific. `ws` appears only in
 * the two adapters at the edges — `apps/worker` and `apps/desktop` — so the
 * behaviour that actually needs proving stays testable without a network.
 */

export {
  RUNNER_CLOSE_CODES,
  RUNNER_COMMAND_OPS,
  RUNNER_ENVELOPE_KINDS,
  RUNNER_ERROR_CODES,
  RUNNER_MAX_FRAME_BYTES,
  RUNNER_PROTOCOL_VERSION,
  type RunnerCapabilities,
  type RunnerCloseCode,
  type RunnerCommandOp,
  type RunnerCommandOutcome,
  type RunnerCommandPayloadByOp,
  type RunnerEnvelope,
  type RunnerEnvelopeKind,
  type RunnerErrorCode,
  type RunnerProgressEvent,
  type RunnerResumeHint
} from "./envelope.js";

export {
  RunnerProtocolError,
  decodeRunnerEnvelope,
  encodeRunnerEnvelope
} from "./codec.js";

export {
  createCommandDedupe,
  type CommandDedupe,
  type CommandDedupeOptions,
  type CommandStatus
} from "./command-dedupe.js";

export {
  createEventWindow,
  type EventWindow,
  type EventWindowInput,
  type EventWindowOptions,
  type UpwardFrame
} from "./event-window.js";

export {
  createBackoff,
  createHeartbeatMonitor,
  type Backoff,
  type BackoffOptions,
  type HeartbeatMonitor,
  type HeartbeatMonitorOptions
} from "./reconnect.js";

export {
  createHostSession,
  RunnerCommandFailedError,
  RunnerSessionClosedError,
  type HostSession,
  type HostSessionOptions,
  type RunnerAuthResult,
  type RunnerIdentity
} from "./host-session.js";

export {
  createRunnerSession,
  type RunnerEnvironmentHandler,
  type RunnerEnvironmentHandlers,
  type RunnerSession,
  type RunnerSessionOptions,
  type RunnerWelcomeInfo
} from "./runner-session.js";

export type {
  RunnerSocket,
  RunnerSocketClose,
  RunnerSocketUnsubscribe
} from "./runner-socket.js";

export {
  createPairedRunnerSockets,
  type PairedRunnerSocketOptions,
  type RunnerSocketPair,
  type WireFrame
} from "./paired-sockets.js";
