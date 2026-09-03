import { describe, expect, it } from "vitest";
import {
  decodeRunnerEnvelope,
  encodeRunnerEnvelope,
  RunnerProtocolError
} from "../src/codec.js";
import {
  RUNNER_MAX_FRAME_BYTES,
  RUNNER_PROTOCOL_VERSION,
  type RunnerCapabilities,
  type RunnerEnvelope
} from "../src/envelope.js";

const capabilities: RunnerCapabilities = {
  maxFileAccessScope: "workspace_only",
  kernelEnforced: true,
  platform: "darwin"
};

/** Every kind must survive a round trip, or the codec silently loses a message class. */
const roundTripCases: ReadonlyArray<RunnerEnvelope> = [
  { v: 1, kind: "hello", deviceAccessToken: "token", capabilities },
  {
    v: 1,
    kind: "hello",
    deviceAccessToken: "token",
    capabilities,
    resume: { lastReceivedCommandId: 41 }
  },
  {
    v: 1,
    kind: "welcome",
    sessionId: "s1",
    deviceId: "d1",
    projectId: "p1",
    heartbeatIntervalMs: 15_000,
    replayFromCursor: 8,
    replayFromCommandId: 42
  },
  {
    v: 1,
    kind: "command",
    id: 7,
    op: "env.perform",
    payload: { handleId: "h", command: ["pnpm", "test"] }
  },
  { v: 1, kind: "result", id: 7, cursor: 3, outcome: { ok: true, value: { exitCode: 0 } } },
  {
    v: 1,
    kind: "result",
    id: 7,
    cursor: 3,
    outcome: { ok: false, code: "scope_violation", message: "outside grant" }
  },
  {
    v: 1,
    kind: "event",
    cursor: 4,
    event: {
      type: "audit.host_access",
      runId: "r1",
      path: "/tmp/x",
      kind: "write",
      outOfScope: true,
      recordedAt: "2026-09-03T00:00:00.000Z"
    }
  },
  { v: 1, kind: "ack", cursor: 9 },
  { v: 1, kind: "nack", code: "auth_required", message: "hello first" },
  { v: 1, kind: "heartbeat", cursor: 12 },
  { v: 1, kind: "goodbye", code: 4000 },
  { v: 1, kind: "goodbye", code: 4001, reason: "device revoked" }
];

describe("encodeRunnerEnvelope / decodeRunnerEnvelope", () => {
  it.each(roundTripCases.map((envelope, index) => [index, envelope] as const))(
    "round-trips case %i",
    (_index, envelope) => {
      expect(decodeRunnerEnvelope(encodeRunnerEnvelope(envelope))).toEqual(envelope);
    }
  );

  it("emits the declared protocol version", () => {
    expect(RUNNER_PROTOCOL_VERSION).toBe(1);
  });

  it("treats cursor 0 as 'nothing yet', not as an error", () => {
    // replayFromCursor is lastConsumed + 1, so 0 must be a legal cursor or the
    // very first replay would ask for a frame that does not exist.
    expect(decodeRunnerEnvelope('{"v":1,"kind":"ack","cursor":0}')).toEqual({
      v: 1,
      kind: "ack",
      cursor: 0
    });
    expect(decodeRunnerEnvelope('{"v":1,"kind":"heartbeat","cursor":0}')).toEqual({
      v: 1,
      kind: "heartbeat",
      cursor: 0
    });
  });

  it("rejects command id 0 while accepting resume hint 0", () => {
    // Command ids start at 1 so that 0 can mean "no command received yet".
    expect(() =>
      decodeRunnerEnvelope('{"v":1,"kind":"command","id":0,"op":"env.inspect","payload":{}}')
    ).toThrow(RunnerProtocolError);
    expect(decodeRunnerEnvelope(encodeRunnerEnvelope({
      v: 1,
      kind: "hello",
      deviceAccessToken: "t",
      capabilities,
      resume: { lastReceivedCommandId: 0 }
    }))).toMatchObject({ kind: "hello", resume: { lastReceivedCommandId: 0 } });
  });
});

describe("decodeRunnerEnvelope rejects untrusted input", () => {
  /** Each entry is a wire payload a hostile or buggy peer could send. */
  const malformed: ReadonlyArray<{ name: string; text: string; code: string }> = [
    { name: "non-JSON text", text: "not json", code: "malformed_envelope" },
    { name: "JSON null", text: "null", code: "malformed_envelope" },
    { name: "JSON array", text: "[]", code: "malformed_envelope" },
    { name: "JSON string", text: '"hello"', code: "malformed_envelope" },
    {
      name: "missing version",
      text: '{"kind":"heartbeat","cursor":1}',
      code: "malformed_envelope"
    },
    {
      name: "wrong version",
      text: '{"v":2,"kind":"heartbeat","cursor":1}',
      code: "protocol_version_mismatch"
    },
    {
      name: "unknown kind",
      text: '{"v":1,"kind":"exploit","cursor":1}',
      code: "malformed_envelope"
    },
    {
      name: "missing kind",
      text: '{"v":1,"cursor":1}',
      code: "malformed_envelope"
    },
    {
      // Strictness mirrors parseRunEvent: extra fields are a contract change,
      // not something to ignore, because ignoring them hides version skew.
      name: "unknown extra field",
      text: '{"v":1,"kind":"heartbeat","cursor":1,"extra":true}',
      code: "malformed_envelope"
    },
    {
      name: "cursor as string",
      text: '{"v":1,"kind":"heartbeat","cursor":"1"}',
      code: "malformed_envelope"
    },
    {
      name: "cursor negative",
      text: '{"v":1,"kind":"heartbeat","cursor":-3}',
      code: "malformed_envelope"
    },
    {
      name: "cursor fractional",
      text: '{"v":1,"kind":"heartbeat","cursor":1.5}',
      code: "malformed_envelope"
    },
    {
      name: "command id zero",
      text: '{"v":1,"kind":"command","id":0,"op":"env.inspect","payload":{}}',
      code: "malformed_envelope"
    },
    {
      name: "unknown command op",
      text: '{"v":1,"kind":"command","id":1,"op":"env.exec","payload":{}}',
      code: "malformed_envelope"
    },
    {
      name: "missing command payload",
      text: '{"v":1,"kind":"command","id":1,"op":"env.inspect"}',
      code: "malformed_envelope"
    },
    {
      name: "unknown error code in nack",
      text: '{"v":1,"kind":"nack","code":"wat","message":"x"}',
      code: "malformed_envelope"
    },
    {
      name: "unknown error code in failed outcome",
      text: '{"v":1,"kind":"result","id":1,"cursor":1,"outcome":{"ok":false,"code":"wat","message":"x"}}',
      code: "malformed_envelope"
    },
    {
      name: "unknown close code",
      text: '{"v":1,"kind":"goodbye","code":4999}',
      code: "malformed_envelope"
    },
    {
      name: "unknown progress event type",
      text: '{"v":1,"kind":"event","cursor":1,"event":{"type":"audit.whatever"}}',
      code: "malformed_envelope"
    },
    {
      // `undefined` is not JSON: JSON.parse would reject it, and a producer
      // that tried to send it must learn that at its own boundary.
      name: "undefined inside payload",
      text: '{"v":1,"kind":"command","id":1,"op":"env.inspect","payload":{"f":undefined}}',
      code: "malformed_envelope"
    }
  ];

  it.each(malformed)("rejects $name with $code", ({ text, code }) => {
    expect(() => decodeRunnerEnvelope(text)).toThrow(RunnerProtocolError);
    try {
      decodeRunnerEnvelope(text);
    } catch (error) {
      expect((error as RunnerProtocolError).code).toBe(code);
    }
  });

  it("rejects a frame above the byte cap without parsing it", () => {
    // A huge payload must be refused before JSON.parse so an oversized frame
    // cannot burn CPU or memory on the decode path.
    const oversized = `{"v":1,"kind":"nack","code":"internal","message":"${"x".repeat(
      RUNNER_MAX_FRAME_BYTES + 1
    )}"}`;
    expect(() => decodeRunnerEnvelope(oversized)).toThrow(RunnerProtocolError);
    try {
      decodeRunnerEnvelope(oversized);
    } catch (error) {
      expect((error as RunnerProtocolError).code).toBe("frame_too_large");
    }
  });

  it("rejects an envelope the encoder refuses to produce", () => {
    // The encoder validates too, so a producer cannot emit a frame the peer
    // would reject — the bug surfaces here instead of across the wire.
    expect(() => encodeRunnerEnvelope({ v: 1, kind: "ack", cursor: -1 } as never)).toThrow(
      RunnerProtocolError
    );
    expect(() =>
      encodeRunnerEnvelope({ v: 1, kind: "ack", cursor: 0, extra: 1 } as never)
    ).toThrow(RunnerProtocolError);
  });

  it("rejects a non-JSON-serialisable payload at encode time", () => {
    // undefined is not a JsonValue, so the frame would decode differently than
    // it encoded — the encoder must fail rather than silently drop the key.
    expect(() =>
      encodeRunnerEnvelope({
        v: 1,
        kind: "command",
        id: 1,
        op: "env.inspect",
        payload: { missing: undefined } as never
      })
    ).toThrow(RunnerProtocolError);
  });
});
