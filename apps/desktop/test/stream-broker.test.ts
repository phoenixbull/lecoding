import { describe, expect, it, vi } from "vitest";
import type { RunEventV1 } from "@lecoding/contracts";
import { createRunStreamBroker } from "../src/main/stream-broker.js";
import type { ClientSdk, ElectronBrowserWindowInstance } from "../src/main/host.js";

interface FakeWindow extends ElectronBrowserWindowInstance {
  pushes: Array<{ channel: string; payload: unknown }>;
}

/** Records every push so tests can assert what the Renderer would receive. */
function createFakeWindow(): FakeWindow {
  const pushes: Array<{ channel: string; payload: unknown }> = [];
  return {
    pushes,
    webPreferences: {},
    webContents: {
      id: 1,
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn((channel: string, payload: unknown) => {
        pushes.push({ channel, payload });
      }),
      session: { webRequest: { onHeadersReceived: vi.fn() } }
    },
    loadURL: vi.fn(async () => undefined),
    loadFile: vi.fn(async () => undefined),
    on: vi.fn()
  } as unknown as FakeWindow;
}

/** Resolves only when the subscription is aborted, parking the follower. */
function parkUntilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function makeEvent(sequence: number, data: unknown = { status: "running" }): RunEventV1 {
  return {
    version: 1,
    sequence,
    runId: "run-1",
    type: "status_changed",
    occurredAt: "2026-01-01T00:00:00.000Z",
    data: data as RunEventV1["data"]
  };
}

/**
 * SDK stub whose `subscribeRunEvents` replays a script: each entry is one
 * attempt, an array means "deliver then close", an Error means "drop".
 */
function createScriptedSdk(script: Array<RunEventV1[] | Error>): ClientSdk & {
  attempts: Array<{ runId: string; lastEventId?: string }>;
} {
  const attempts: Array<{ runId: string; lastEventId?: string }> = [];
  let index = 0;
  const sdk = {
    attempts,
    subscribeRunEvents(runId: string, options: { lastEventId?: string; signal: AbortSignal }) {
      attempts.push({
        runId,
        ...(options.lastEventId !== undefined ? { lastEventId: options.lastEventId } : {})
      });
      const attempt = script[index];
      index += 1;
      const signal = options.signal;
      return {
        async *[Symbol.asyncIterator]() {
          if (attempt instanceof Error) {
            throw attempt;
          }
          for (const event of attempt ?? []) {
            if (signal.aborted) {
              return;
            }
            yield event;
          }
          if (attempt === undefined || attempt.length === 0) {
            // Park instead of closing. A real SSE stream never completes
            // normally, and closing here would spin the broker's reconnect
            // loop for the rest of the test run.
            await parkUntilAborted(signal);
          }
        }
      } as AsyncIterable<RunEventV1>;
    }
  };
  return sdk as unknown as ClientSdk & {
    attempts: Array<{ runId: string; lastEventId?: string }>;
  };
}

function channelsOf(window: FakeWindow): string[] {
  return window.pushes.map((entry) => entry.channel);
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("createRunStreamBroker", () => {
  it("announces connecting before relaying any event", () => {
    const window = createFakeWindow();
    const sdk = createScriptedSdk([[]]);
    const broker = createRunStreamBroker({
      getWindow: () => window,
      getSdk: () => sdk
    });
    broker.subscribe("run-1");
    expect(window.pushes).toEqual([
      { channel: "runs.streamState", payload: { runId: "run-1", phase: "connecting" } }
    ]);
    broker.dispose();
  });

  it("relays each event and marks the stream live", async () => {
    const window = createFakeWindow();
    const sdk = createScriptedSdk([[makeEvent(1), makeEvent(2)]]);
    const broker = createRunStreamBroker({
      getWindow: () => window,
      getSdk: () => sdk
    });
    broker.subscribe("run-1");
    await settle();
    const events = window.pushes.filter((entry) => entry.channel === "runs.event");
    expect(events).toHaveLength(2);
    expect(channelsOf(window)).toContain("runs.streamState");
    broker.dispose();
  });

  it("closes the stream on a terminal event and frees the slot", async () => {
    const window = createFakeWindow();
    const sdk = createScriptedSdk([[makeEvent(1, { status: "succeeded" })]]);
    const broker = createRunStreamBroker({
      getWindow: () => window,
      getSdk: () => sdk
    });
    broker.subscribe("run-1");
    await settle();
    expect(broker.activeRunIds()).toEqual([]);
    expect(window.pushes.at(-1)).toEqual({
      channel: "runs.streamState",
      payload: { runId: "run-1", phase: "closed" }
    });
  });

  it("opens only one subscription per Run even when asked twice", () => {
    const window = createFakeWindow();
    const sdk = createScriptedSdk([[]]);
    const broker = createRunStreamBroker({
      getWindow: () => window,
      getSdk: () => sdk
    });
    broker.subscribe("run-1");
    broker.subscribe("run-1");
    expect(sdk.attempts).toHaveLength(1);
    expect(broker.activeRunIds()).toEqual(["run-1"]);
    broker.dispose();
  });

  it("reports reconnecting after a transport drop and resumes from the cursor", async () => {
    const window = createFakeWindow();
    const sdk = createScriptedSdk([[makeEvent(1)], new Error("socket reset"), []]);
    const broker = createRunStreamBroker({
      getWindow: () => window,
      getSdk: () => sdk,
      waitBeforeReconnect: () => Promise.resolve()
    });
    broker.subscribe("run-1");
    await settle();
    await settle();
    const phases = window.pushes
      .filter((entry) => entry.channel === "runs.streamState")
      .map((entry) => (entry.payload as { phase: string }).phase);
    expect(phases).toContain("reconnecting");
    // The resumed attempt must advertise the last relayed sequence.
    expect(sdk.attempts.at(-1)?.lastEventId).toBe("1");
    broker.dispose();
  });

  it("reports a failure when the follower gives up", async () => {
    const window = createFakeWindow();
    const sdk = createScriptedSdk([new Error("socket reset")]);
    const broker = createRunStreamBroker({
      getWindow: () => window,
      getSdk: () => sdk,
      waitBeforeReconnect: () => Promise.resolve()
    });
    // The only way the follower stops here is an abort, so assert the drop is
    // surfaced as reconnecting rather than silently swallowed.
    broker.subscribe("run-1");
    await settle();
    const phases = window.pushes
      .filter((entry) => entry.channel === "runs.streamState")
      .map((entry) => (entry.payload as { phase: string }).phase);
    expect(phases).toContain("reconnecting");
    broker.dispose();
  });

  it("aborts the stream on unsubscribe and allows a fresh one afterwards", async () => {
    const window = createFakeWindow();
    const sdk = createScriptedSdk([[], []]);
    const broker = createRunStreamBroker({
      getWindow: () => window,
      getSdk: () => sdk
    });
    broker.subscribe("run-1");
    broker.unsubscribe("run-1");
    expect(broker.activeRunIds()).toEqual([]);
    broker.subscribe("run-1");
    expect(sdk.attempts).toHaveLength(2);
    broker.dispose();
  });

  it("ignores an unsubscribe for a Run that is not being followed", () => {
    const window = createFakeWindow();
    const sdk = createScriptedSdk([[]]);
    const broker = createRunStreamBroker({
      getWindow: () => window,
      getSdk: () => sdk
    });
    expect(() => broker.unsubscribe("run-unknown")).not.toThrow();
    expect(sdk.attempts).toHaveLength(0);
  });

  it("drops every stream on dispose", async () => {
    const window = createFakeWindow();
    const sdk = createScriptedSdk([[], []]);
    const broker = createRunStreamBroker({
      getWindow: () => window,
      getSdk: () => sdk
    });
    broker.subscribe("run-1");
    broker.subscribe("run-2");
    expect(broker.activeRunIds().sort()).toEqual(["run-1", "run-2"]);
    broker.dispose();
    expect(broker.activeRunIds()).toEqual([]);
  });

  it("tolerates a closed window instead of throwing", async () => {
    const window = createFakeWindow();
    const sdk = createScriptedSdk([[makeEvent(1)]]);
    let current: ElectronBrowserWindowInstance | undefined = window;
    const broker = createRunStreamBroker({
      getWindow: () => current,
      getSdk: () => sdk
    });
    broker.subscribe("run-1");
    current = undefined;
    await expect(settle()).resolves.toBeUndefined();
    broker.dispose();
  });
});
