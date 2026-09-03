import { describe, expect, it, vi } from "vitest";
import type { RunEventV1 } from "@lecoding/contracts";
import {
  followRunEventStream,
  type RunEventSource
} from "../src/run-stream.js";

function makeEvent(sequence: number, type: RunEventV1["type"] = "status_changed"): RunEventV1 {
  return {
    version: 1,
    sequence,
    runId: "run-1",
    type,
    occurredAt: "2026-01-01T00:00:00.000Z",
    // `null` is the JSON-only representation of "no payload"; the follower
    // only inspects `data`, never the event type's absence of it.
    data: null
  };
}

/**
 * Raised once a scripted source runs out of attempts.
 *
 * A real transport never closes a healthy stream — it either errors or the
 * caller stops on a terminal event — so an exhausted script is the test's
 * signal to stop reconnecting instead of looping forever.
 */
class ScriptExhausted extends Error {
  public constructor() {
    super("scripted source ran out of attempts");
    this.name = "ScriptExhausted";
  }
}

/**
 * Scripted source: each entry is one subscription attempt. An array means
 * "deliver these events then close"; an Error means the attempt fails and
 * forces the reconnect path.
 */
function scriptedSource(
  attempts: Array<RunEventV1[] | Error>
): RunEventSource & { lastEventIds: Array<string | undefined> } {
  const lastEventIds: Array<string | undefined> = [];
  let index = 0;
  return {
    lastEventIds,
    subscribe(_runId, options) {
      void _runId;
      lastEventIds.push(options.lastEventId);
      const attempt = attempts[index];
      index += 1;
      const signal = options.signal;
      return {
        async *[Symbol.asyncIterator]() {
          if (attempt === undefined) {
            throw new ScriptExhausted();
          }
          if (attempt instanceof Error) {
            throw attempt;
          }
          for (const event of attempt) {
            if (signal.aborted) {
              return;
            }
            yield event;
          }
        }
      };
    }
  };
}

/** Stops the follower once the script is exhausted; keeps retrying real failures. */
function continueUntilExhausted(): (error?: unknown) => "continue" | "stop" {
  return (error?: unknown) => (error instanceof ScriptExhausted ? "stop" : "continue");
}

function noWait(): Promise<void> {
  return Promise.resolve();
}

describe("followRunEventStream", () => {
  it("delivers every event exactly once and then returns", async () => {
    const source = scriptedSource([[makeEvent(1), makeEvent(2), makeEvent(3)]]);
    const seen: number[] = [];
    await followRunEventStream({
      source,
      runId: "run-1",
      signal: new AbortController().signal,
      async onEvent(event): Promise<"continue" | "stop"> {
        seen.push(event.sequence);
        return "continue";
      },
      onReconnect: continueUntilExhausted(),
      waitBeforeReconnect: noWait
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("resumes from the last accepted sequence after a transport failure", async () => {
    const source = scriptedSource([
      [makeEvent(1), makeEvent(2)],
      new Error("socket reset"),
      [makeEvent(3)]
    ]);
    const seen: number[] = [];
    await followRunEventStream({
      source,
      runId: "run-1",
      signal: new AbortController().signal,
      async onEvent(event): Promise<"continue" | "stop"> {
        seen.push(event.sequence);
        return "continue";
      },
      onReconnect: continueUntilExhausted(),
      waitBeforeReconnect: noWait
    });
    expect(seen).toEqual([1, 2, 3]);
    // The first attempt has no cursor; the resumption attempt must advertise 2.
    expect(source.lastEventIds[0]).toBeUndefined();
    expect(source.lastEventIds[2]).toBe("2");
  });

  it("suppresses replayed events that the server outbox re-sends after a reconnect", async () => {
    // The server guarantees at-least-once delivery, so a resumed stream may
    // start slightly before the requested cursor.
    const source = scriptedSource([
      [makeEvent(1), makeEvent(2)],
      new Error("socket reset"),
      [makeEvent(2), makeEvent(3)]
    ]);
    const seen: number[] = [];
    await followRunEventStream({
      source,
      runId: "run-1",
      signal: new AbortController().signal,
      async onEvent(event): Promise<"continue" | "stop"> {
        seen.push(event.sequence);
        return "continue";
      },
      onReconnect: continueUntilExhausted(),
      waitBeforeReconnect: noWait
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("stops immediately when onEvent asks to stop, even mid-batch", async () => {
    const source = scriptedSource([[makeEvent(1), makeEvent(2), makeEvent(3)]]);
    const seen: number[] = [];
    await followRunEventStream({
      source,
      runId: "run-1",
      signal: new AbortController().signal,
      async onEvent(event): Promise<"continue" | "stop"> {
        seen.push(event.sequence);
        return event.sequence === 2 ? "stop" : "continue";
      },
      onReconnect: continueUntilExhausted(),
      waitBeforeReconnect: noWait
    });
    expect(seen).toEqual([1, 2]);
  });

  it("stops when onReconnect reports a terminal refresh", async () => {
    const source = scriptedSource([
      new Error("socket reset"),
      [makeEvent(1)],
      [makeEvent(2)]
    ]);
    let reconnectCalls = 0;
    await followRunEventStream({
      source,
      runId: "run-1",
      signal: new AbortController().signal,
      async onEvent(): Promise<"continue" | "stop"> {
        return "continue";
      },
      onReconnect() {
        reconnectCalls += 1;
        return "stop";
      },
      waitBeforeReconnect: noWait
    });
    expect(reconnectCalls).toBe(1);
    // Stopping on reconnect must not open another subscription.
    expect(source.lastEventIds).toHaveLength(1);
  });

  it("hands the disconnect error to onReconnect so callers can classify it", async () => {
    const failure = new Error("socket reset");
    const source = scriptedSource([failure, [makeEvent(1)]]);
    // Retry real failures but stop on script exhaustion, otherwise the
    // follower (correctly) keeps reconnecting forever.
    const onReconnect = vi.fn((error?: unknown): "continue" | "stop" =>
      error instanceof ScriptExhausted ? "stop" : "continue"
    );
    await followRunEventStream({
      source,
      runId: "run-1",
      signal: new AbortController().signal,
      async onEvent(): Promise<"continue" | "stop"> {
        return "continue";
      },
      onReconnect,
      waitBeforeReconnect: noWait
    });
    expect(onReconnect).toHaveBeenCalledWith(failure);
  });

  it("returns without further attempts once the signal aborts", async () => {
    const controller = new AbortController();
    const source = scriptedSource([[makeEvent(1), makeEvent(2)], [makeEvent(1)]]);
    await followRunEventStream({
      source,
      runId: "run-1",
      signal: controller.signal,
      async onEvent(event): Promise<"continue" | "stop"> {
        controller.abort();
        void event;
        return "continue";
      },
      onReconnect: continueUntilExhausted(),
      waitBeforeReconnect: noWait
    });
    // Aborting mid-batch exits the loop before any reconnect attempt.
    expect(source.lastEventIds).toHaveLength(1);
  });

  it("never starts a subscription when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const source = scriptedSource([[makeEvent(1)]]);
    await followRunEventStream({
      source,
      runId: "run-1",
      signal: controller.signal,
      async onEvent(): Promise<"continue" | "stop"> {
        return "continue";
      },
      onReconnect: continueUntilExhausted(),
      waitBeforeReconnect: noWait
    });
    expect(source.lastEventIds).toHaveLength(0);
  });
});
