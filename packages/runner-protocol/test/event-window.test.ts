import { describe, expect, it } from "vitest";
import { createEventWindow } from "../src/event-window.js";
import type { RunnerProgressEvent } from "../src/envelope.js";

const audit: RunnerProgressEvent = {
  type: "audit.host_access",
  runId: "r1",
  path: "/tmp/outside",
  kind: "write",
  outOfScope: true,
  recordedAt: "2026-09-03T00:00:00.000Z"
};

const result = { ok: true as const, value: { exitCode: 0 } };

describe("createEventWindow", () => {
  it("starts empty with a latest cursor of 0", () => {
    const window = createEventWindow();
    expect(window.latest()).toBe(0);
    expect(window.size()).toBe(0);
    expect(window.after(0)).toEqual([]);
  });

  it("assigns cursors starting at 1 and increasing by one", () => {
    // Cursor 0 is reserved for "nothing yet", so the first frame is 1 and
    // replayFromCursor = lastAcked + 1 is correct at the origin.
    const window = createEventWindow();
    expect(window.record({ kind: "event", event: audit }).cursor).toBe(1);
    expect(window.record({ kind: "result", id: 9, outcome: result }).cursor).toBe(2);
    expect(window.latest()).toBe(2);
  });

  it("shares one cursor sequence across results and events", () => {
    // Replay order must be the order the Runner produced, not per-kind order.
    const window = createEventWindow();
    window.record({ kind: "result", id: 1, outcome: result });
    window.record({ kind: "event", event: audit });
    window.record({ kind: "result", id: 2, outcome: result });

    expect(window.after(0).map((frame) => [frame.kind, frame.cursor])).toEqual([
      ["result", 1],
      ["event", 2],
      ["result", 3]
    ]);
  });

  it("replays only frames strictly after the given cursor", () => {
    const window = createEventWindow();
    for (let i = 0; i < 5; i += 1) {
      window.record({ kind: "event", event: audit });
    }
    expect(window.after(3).map((frame) => frame.cursor)).toEqual([4, 5]);
    expect(window.after(5)).toEqual([]);
  });

  it("returns a copy so callers cannot corrupt the window", () => {
    const window = createEventWindow();
    window.record({ kind: "event", event: audit });
    const frames = window.after(0);
    frames.length = 0;
    expect(window.size()).toBe(1);
  });

  it("trims frames the peer has acknowledged", () => {
    const window = createEventWindow();
    for (let i = 0; i < 4; i += 1) {
      window.record({ kind: "event", event: audit });
    }

    window.trim(2);
    expect(window.size()).toBe(2);
    expect(window.after(0).map((frame) => frame.cursor)).toEqual([3, 4]);
  });

  it("keeps the latest cursor after trimming so cursors never regress", () => {
    // Trimming must not rewind the allocator, or a replayed cursor would
    // collide with a future frame's cursor.
    const window = createEventWindow();
    window.record({ kind: "event", event: audit });
    window.record({ kind: "event", event: audit });
    window.trim(2);

    expect(window.latest()).toBe(2);
    expect(window.record({ kind: "event", event: audit }).cursor).toBe(3);
  });

  it("clears everything when trimmed past the latest cursor", () => {
    const window = createEventWindow();
    window.record({ kind: "event", event: audit });
    window.trim(99);
    expect(window.size()).toBe(0);
    expect(window.latest()).toBe(1);
  });

  it("drops the oldest frame when the peer stops acknowledging, and says so", () => {
    // Silent loss would break the "never lose an event" guarantee. The window
    // keeps serving (it cannot block execution) but records the overflow so the
    // session can fail loudly instead of pretending the stream was complete.
    const window = createEventWindow({ maxFrames: 3 });
    for (let i = 0; i < 5; i += 1) {
      window.record({ kind: "event", event: audit });
    }

    expect(window.size()).toBe(3);
    expect(window.overflowed()).toBe(2);
    expect(window.after(0).map((frame) => frame.cursor)).toEqual([3, 4, 5]);
  });

  it("stops overflowing once the peer resumes acknowledging", () => {
    const window = createEventWindow({ maxFrames: 2 });
    window.record({ kind: "event", event: audit });
    window.record({ kind: "event", event: audit });
    window.record({ kind: "event", event: audit });
    expect(window.overflowed()).toBe(1);

    window.trim(3);
    window.record({ kind: "event", event: audit });
    expect(window.overflowed()).toBe(1);
    expect(window.size()).toBe(1);
  });

  it("preserves frame contents through replay", () => {
    const window = createEventWindow();
    const recorded = window.record({ kind: "result", id: 42, outcome: result });
    expect(window.after(0)[0]).toEqual(recorded);
    expect(recorded).toMatchObject({ v: 1, kind: "result", id: 42, cursor: 1 });
  });
});
