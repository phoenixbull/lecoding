import { describe, expect, it } from "vitest";
import { parseRunEvent } from "../src/index.js";

describe("RunEvent contract", () => {
  it("rejects an unsupported envelope version", () => {
    expect(() =>
      parseRunEvent({
        version: 2,
        sequence: 1,
        runId: "run-1",
        type: "progress",
        occurredAt: "2026-08-19T00:00:00.000Z",
        data: { summary: "Preparing workspace" }
      })
    ).toThrow("Unsupported RunEvent version: 2");
  });

  it("rejects malformed version-one envelopes", () => {
    const valid = {
      version: 1,
      sequence: 1,
      runId: "run-1",
      type: "status_changed",
      occurredAt: "2026-08-19T00:00:00.000Z",
      data: { status: "running" }
    } as const;

    // Each sample violates one protocol invariant while leaving the others valid.
    const malformed = [
      { ...valid, sequence: 0 },
      { ...valid, runId: "" },
      { ...valid, type: "unknown_event" },
      { ...valid, occurredAt: "yesterday" },
      { ...valid, data: undefined },
      { ...valid, extra: true }
    ];

    const accepted = malformed.map((event) => {
      try {
        parseRunEvent(event);
        return true;
      } catch {
        return false;
      }
    });

    expect(accepted).toEqual([false, false, false, false, false, false]);
  });
});
