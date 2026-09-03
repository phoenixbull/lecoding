/**
 * Strict codec for the Runner wire protocol.
 *
 * Both directions run the same validator. That is deliberate: the encoder
 * validates too, so the protocol can never emit a frame its own decoder would
 * reject, and a bug in a producer surfaces at the producer instead of as a
 * confusing `malformed_envelope` on the peer.
 *
 * Validation is strict in the same way `parseRunEvent` is strict — unknown
 * fields are rejected rather than ignored. Ignoring them would let two peers
 * disagree about a field's meaning while both reporting success, which is the
 * exact failure mode a versioned contract exists to prevent.
 *
 * The byte cap is checked *before* `JSON.parse` so an oversized frame is
 * refused without spending CPU or memory decoding it.
 */

import type { FileAccessScope, JsonValue } from "@lecoding/contracts";
import {
  RUNNER_CLOSE_CODES,
  RUNNER_COMMAND_OPS,
  RUNNER_ENVELOPE_KINDS,
  RUNNER_ERROR_CODES,
  RUNNER_MAX_FRAME_BYTES,
  RUNNER_PROTOCOL_VERSION,
  type RunnerCapabilities,
  type RunnerCloseCode,
  type RunnerCommandOp,
  type RunnerEnvelope,
  type RunnerEnvelopeKind,
  type RunnerErrorCode,
  type RunnerProgressEvent,
  type RunnerResumeHint
} from "./envelope.js";

/** Thrown for any wire violation. `code` is safe to send back on the wire. */
export class RunnerProtocolError extends Error {
  readonly code: RunnerErrorCode;

  constructor(code: RunnerErrorCode, message: string) {
    super(message);
    this.name = "RunnerProtocolError";
    this.code = code;
  }
}

/**
 * Human-facing strings are bounded so a peer cannot use a `message` field as a
 * side channel for unbounded data. The frame cap would catch it anyway; this
 * makes the failure legible.
 */
const MAX_MESSAGE_CHARS = 2_000;

/** Device tokens are 32 random bytes; anything longer is malformed by construction. */
const MAX_TOKEN_CHARS = 512;

const FILE_ACCESS_SCOPES: readonly FileAccessScope[] = [
  "workspace_only",
  "selected_directories",
  "host_full"
];

const CAPABILITY_PLATFORMS: readonly RunnerCapabilities["platform"][] = [
  "darwin",
  "win32",
  "linux"
];

const PROGRESS_EVENT_TYPES: readonly RunnerProgressEvent["type"][] = [
  "audit.host_access",
  "residual.path"
];

/**
 * Field sets per kind. `required` must all be present; `optional` may be;
 * anything else is rejected.
 */
const ENVELOPE_FIELDS: Record<
  RunnerEnvelopeKind,
  { required: readonly string[]; optional: readonly string[] }
> = {
  hello: {
    required: ["v", "kind", "deviceAccessToken", "capabilities"],
    optional: ["resume"]
  },
  result: { required: ["v", "kind", "id", "cursor", "outcome"], optional: [] },
  event: { required: ["v", "kind", "cursor", "event"], optional: [] },
  welcome: {
    required: [
      "v",
      "kind",
      "sessionId",
      "deviceId",
      "projectId",
      "heartbeatIntervalMs",
      "replayFromCursor",
      "nextCommandId"
    ],
    optional: []
  },
  command: { required: ["v", "kind", "id", "op", "payload"], optional: [] },
  ack: { required: ["v", "kind", "cursor"], optional: [] },
  nack: { required: ["v", "kind", "code", "message"], optional: [] },
  heartbeat: { required: ["v", "kind", "cursor"], optional: [] },
  goodbye: { required: ["v", "kind", "code"], optional: ["reason"] }
};

/**
 * Encodes one envelope, validating it first.
 *
 * @throws {RunnerProtocolError} if the envelope is not a valid frame of this
 * protocol version, or if the encoded form exceeds `RUNNER_MAX_FRAME_BYTES`.
 */
export function encodeRunnerEnvelope(envelope: RunnerEnvelope): string {
  // Validating the object (rather than a JSON round trip) is what catches
  // `undefined` and non-finite numbers: JSON.stringify would silently drop or
  // coerce them, producing a frame that decodes differently than it encoded.
  validateEnvelope(envelope);
  const text = JSON.stringify(envelope);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > RUNNER_MAX_FRAME_BYTES) {
    throw new RunnerProtocolError(
      "frame_too_large",
      `Runner frame is ${bytes} bytes, above the ${RUNNER_MAX_FRAME_BYTES} byte cap`
    );
  }
  return text;
}

/**
 * Decodes and validates one untrusted frame.
 *
 * @throws {RunnerProtocolError} with a `code` that is safe to return to the
 * peer as a `nack`. Never throws the underlying JSON parse error, which can
 * carry input fragments.
 */
export function decodeRunnerEnvelope(text: string): RunnerEnvelope {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > RUNNER_MAX_FRAME_BYTES) {
    throw new RunnerProtocolError(
      "frame_too_large",
      `Runner frame is ${bytes} bytes, above the ${RUNNER_MAX_FRAME_BYTES} byte cap`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new RunnerProtocolError("malformed_envelope", "Runner frame is not valid JSON");
  }
  return validateEnvelope(parsed);
}

function validateEnvelope(value: unknown): RunnerEnvelope {
  const record = requireRecord(value, "Runner frame");
  if (record["v"] === undefined) {
    throw new RunnerProtocolError("malformed_envelope", "Runner frame is missing its version");
  }
  if (record["v"] !== RUNNER_PROTOCOL_VERSION) {
    throw new RunnerProtocolError(
      "protocol_version_mismatch",
      `Unsupported runner protocol version: ${String(record["v"])}`
    );
  }
  const kind = record["kind"];
  if (typeof kind !== "string" || !RUNNER_ENVELOPE_KINDS.includes(kind as RunnerEnvelopeKind)) {
    throw new RunnerProtocolError(
      "malformed_envelope",
      `Unknown runner envelope kind: ${String(kind)}`
    );
  }
  const spec = ENVELOPE_FIELDS[kind as RunnerEnvelopeKind];
  assertFieldSet(record, spec.required, spec.optional);

  switch (kind as RunnerEnvelopeKind) {
    case "hello":
      return {
        v: 1,
        kind: "hello",
        deviceAccessToken: requireBoundedString(record, "deviceAccessToken", MAX_TOKEN_CHARS),
        capabilities: requireCapabilities(record["capabilities"]),
        ...(record["resume"] !== undefined
          ? { resume: requireResumeHint(record["resume"]) }
          : {})
      };
    case "welcome":
      return {
        v: 1,
        kind: "welcome",
        sessionId: requireNonEmptyString(record, "sessionId"),
        deviceId: requireNonEmptyString(record, "deviceId"),
        projectId: requireNonEmptyString(record, "projectId"),
        heartbeatIntervalMs: requirePositiveInteger(record, "heartbeatIntervalMs"),
        replayFromCursor: requireCursor(record, "replayFromCursor"),
        nextCommandId: requirePositiveInteger(record, "nextCommandId")
      };
    case "command":
      return {
        v: 1,
        kind: "command",
        id: requirePositiveInteger(record, "id"),
        op: requireCommandOp(record["op"]),
        payload: requireJsonValue(record["payload"])
      };
    case "result":
      return {
        v: 1,
        kind: "result",
        id: requirePositiveInteger(record, "id"),
        cursor: requireCursor(record, "cursor"),
        outcome: requireOutcome(record["outcome"])
      };
    case "event":
      return {
        v: 1,
        kind: "event",
        cursor: requireCursor(record, "cursor"),
        event: requireProgressEvent(record["event"])
      };
    case "ack":
      return { v: 1, kind: "ack", cursor: requireCursor(record, "cursor") };
    case "nack":
      return {
        v: 1,
        kind: "nack",
        code: requireErrorCode(record["code"]),
        message: requireBoundedString(record, "message", MAX_MESSAGE_CHARS)
      };
    case "heartbeat":
      return { v: 1, kind: "heartbeat", cursor: requireCursor(record, "cursor") };
    case "goodbye":
      return {
        v: 1,
        kind: "goodbye",
        code: requireCloseCode(record["code"]),
        ...(record["reason"] !== undefined
          ? { reason: requireBoundedString(record, "reason", MAX_MESSAGE_CHARS) }
          : {})
      };
    default:
      // Unreachable: `kind` was checked against RUNNER_ENVELOPE_KINDS above.
      throw new RunnerProtocolError("malformed_envelope", "Unknown runner envelope kind");
  }
}

function assertFieldSet(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[]
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new RunnerProtocolError(
        "malformed_envelope",
        `Runner frame has an unknown field: ${key}`
      );
    }
  }
  for (const key of required) {
    if (record[key] === undefined) {
      throw new RunnerProtocolError(
        "malformed_envelope",
        `Runner frame is missing required field: ${key}`
      );
    }
  }
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RunnerProtocolError("malformed_envelope", `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  key: string
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new RunnerProtocolError("malformed_envelope", `${key} must be a non-empty string`);
  }
  return value;
}

function requireBoundedString(
  record: Record<string, unknown>,
  key: string,
  max: number
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length > max) {
    throw new RunnerProtocolError(
      "malformed_envelope",
      `${key} must be a string of at most ${max} characters`
    );
  }
  return value;
}

/**
 * A cursor is non-negative: 0 means "nothing produced yet" or "nothing consumed
 * yet", which is the state of every session before its first frame. Requiring
 * 1 would force peers to fabricate a first value, and would make
 * `replayFromCursor = lastConsumed + 1` off by one at the origin.
 */
function requireCursor(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RunnerProtocolError(
      "malformed_envelope",
      `${key} must be a non-negative integer`
    );
  }
  return value as number;
}

/** Command ids start at 1 so that 0 can mean "no command received yet" in a resume hint. */
function requirePositiveInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RunnerProtocolError(
      "malformed_envelope",
      `${key} must be a positive integer`
    );
  }
  return value as number;
}

function requireCapabilities(value: unknown): RunnerCapabilities {
  const record = requireRecord(value, "capabilities");
  assertFieldSet(record, ["maxFileAccessScope", "kernelEnforced", "platform"], []);
  const scope = record["maxFileAccessScope"];
  const platform = record["platform"];
  if (typeof scope !== "string" || !FILE_ACCESS_SCOPES.includes(scope as FileAccessScope)) {
    throw new RunnerProtocolError(
      "malformed_envelope",
      `capabilities.maxFileAccessScope is invalid: ${String(scope)}`
    );
  }
  if (typeof record["kernelEnforced"] !== "boolean") {
    throw new RunnerProtocolError("malformed_envelope", "capabilities.kernelEnforced must be a boolean");
  }
  if (
    typeof platform !== "string" ||
    !CAPABILITY_PLATFORMS.includes(platform as RunnerCapabilities["platform"])
  ) {
    throw new RunnerProtocolError(
      "malformed_envelope",
      `capabilities.platform is invalid: ${String(platform)}`
    );
  }
  return {
    maxFileAccessScope: scope as FileAccessScope,
    kernelEnforced: record["kernelEnforced"] as boolean,
    platform: platform as RunnerCapabilities["platform"]
  };
}

function requireResumeHint(value: unknown): RunnerResumeHint {
  const record = requireRecord(value, "resume");
  assertFieldSet(record, ["lastReceivedCommandId"], []);
  return {
    lastReceivedCommandId: requireCursor(record, "lastReceivedCommandId")
  };
}

function requireCommandOp(value: unknown): RunnerCommandOp {
  if (typeof value !== "string" || !RUNNER_COMMAND_OPS.includes(value as RunnerCommandOp)) {
    throw new RunnerProtocolError(
      "malformed_envelope",
      `Unknown runner command op: ${String(value)}`
    );
  }
  return value as RunnerCommandOp;
}

function requireErrorCode(value: unknown): RunnerErrorCode {
  if (typeof value !== "string" || !RUNNER_ERROR_CODES.includes(value as RunnerErrorCode)) {
    throw new RunnerProtocolError(
      "malformed_envelope",
      `Unknown runner error code: ${String(value)}`
    );
  }
  return value as RunnerErrorCode;
}

function requireCloseCode(value: unknown): RunnerCloseCode {
  if (typeof value !== "number" || !RUNNER_CLOSE_CODES.includes(value as RunnerCloseCode)) {
    throw new RunnerProtocolError(
      "malformed_envelope",
      `Unknown runner close code: ${String(value)}`
    );
  }
  return value as RunnerCloseCode;
}

function requireOutcome(value: unknown): {
  ok: true;
  value: JsonValue;
} | {
  ok: false;
  code: RunnerErrorCode;
  message: string;
} {
  const record = requireRecord(value, "outcome");
  if (record["ok"] === true) {
    assertFieldSet(record, ["ok", "value"], []);
    return { ok: true, value: requireJsonValue(record["value"]) };
  }
  if (record["ok"] === false) {
    assertFieldSet(record, ["ok", "code", "message"], []);
    return {
      ok: false,
      code: requireErrorCode(record["code"]),
      message: requireBoundedString(record, "message", MAX_MESSAGE_CHARS)
    };
  }
  throw new RunnerProtocolError("malformed_envelope", "outcome.ok must be true or false");
}

function requireProgressEvent(value: unknown): RunnerProgressEvent {
  const record = requireRecord(value, "event");
  const type = record["type"];
  if (typeof type !== "string" || !PROGRESS_EVENT_TYPES.includes(type as RunnerProgressEvent["type"])) {
    throw new RunnerProtocolError(
      "malformed_envelope",
      `Unknown runner progress event type: ${String(type)}`
    );
  }
  if (type === "audit.host_access") {
    assertFieldSet(record, ["type", "runId", "path", "kind", "outOfScope", "recordedAt"], []);
    const kind = record["kind"];
    if (kind !== "read" && kind !== "write" && kind !== "execute") {
      throw new RunnerProtocolError(
        "malformed_envelope",
        `audit.host_access.kind is invalid: ${String(kind)}`
      );
    }
    if (typeof record["outOfScope"] !== "boolean") {
      throw new RunnerProtocolError("malformed_envelope", "audit.host_access.outOfScope must be a boolean");
    }
    return {
      type: "audit.host_access",
      runId: requireNonEmptyString(record, "runId"),
      path: requireNonEmptyString(record, "path"),
      kind,
      outOfScope: record["outOfScope"] as boolean,
      recordedAt: requireNonEmptyString(record, "recordedAt")
    };
  }
  assertFieldSet(record, ["type", "runId", "path", "reason"], []);
  return {
    type: "residual.path",
    runId: requireNonEmptyString(record, "runId"),
    path: requireNonEmptyString(record, "path"),
    reason: requireBoundedString(record, "reason", MAX_MESSAGE_CHARS)
  };
}

/**
 * Accepts only JSON-representable values.
 *
 * `undefined` and non-finite numbers are rejected even though `JSON.stringify`
 * would coerce them, because the result would not round-trip: `undefined`
 * disappears and `NaN` becomes `null`, so the peer would see a different value
 * than the producer intended.
 */
function requireJsonValue(value: unknown): JsonValue {
  if (value === null) {
    return null;
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RunnerProtocolError("malformed_envelope", "JSON numbers must be finite");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => requireJsonValue(entry));
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== Object.prototype && proto !== null) {
      throw new RunnerProtocolError(
        "malformed_envelope",
        "JSON objects must be plain objects"
      );
    }
    const result: { [key: string]: JsonValue } = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = requireJsonValue(entry);
    }
    return result;
  }
  throw new RunnerProtocolError(
    "malformed_envelope",
    `Value is not JSON-serialisable: ${typeof value}`
  );
}
