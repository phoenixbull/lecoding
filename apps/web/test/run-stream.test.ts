import { describe, expect, it, vi } from "vitest";
import type { LeCodingClient } from "@lecoding/client-sdk";
import type { RunEventV1 } from "@lecoding/contracts";
import { followRunEventStream } from "../src/run-stream.js";

function event(sequence: number): RunEventV1 {
  return {
    version: 1,
    sequence,
    runId: "run-1",
    type: "status_changed",
    occurredAt: `2026-08-26T06:00:0${sequence}.000Z`,
    data: { status: sequence === 2 ? "succeeded" : "running" }
  };
}

describe("followRunEventStream", () => {
  it("reconnects from the last cursor, suppresses repeats, and stops at terminal state", async () => {
    const subscriptions: Array<string | undefined> = [];
    let connection = 0;
    const client = {
      async *subscribeRunEvents(
        _runId: string,
        options?: { lastEventId?: string }
      ) {
        subscriptions.push(options?.lastEventId);
        connection += 1;
        if (connection === 1) {
          yield event(1);
          return;
        }
        // At-least-once delivery may repeat the cursor event during handoff.
        yield event(1);
        yield event(2);
      }
    } as unknown as LeCodingClient;
    const received: number[] = [];
    const onReconnect = vi.fn();
    const waitBeforeReconnect = vi.fn(async () => undefined);

    await followRunEventStream({
      client,
      runId: "run-1",
      signal: new AbortController().signal,
      onEvent(receivedEvent) {
        received.push(receivedEvent.sequence);
        return receivedEvent.sequence === 2 ? "stop" : "continue";
      },
      onReconnect,
      waitBeforeReconnect
    });

    expect(subscriptions).toEqual([undefined, "1"]);
    expect(received).toEqual([1, 2]);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(waitBeforeReconnect).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when the caller aborts a failed connection", async () => {
    const controller = new AbortController();
    const client = {
      async *subscribeRunEvents(): AsyncGenerator<RunEventV1> {
        throw new Error("connection lost");
      }
    } as unknown as LeCodingClient;
    const onReconnect = vi.fn(() => controller.abort());

    await followRunEventStream({
      client,
      runId: "run-1",
      signal: controller.signal,
      onEvent: vi.fn(() => "continue" as const),
      onReconnect,
      waitBeforeReconnect: vi.fn(async () => undefined)
    });

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("stops when a reconnect status refresh observes a terminal Run", async () => {
    const subscribeRunEvents = vi.fn(async function* (): AsyncGenerator<RunEventV1> {
      return;
    });
    const waitBeforeReconnect = vi.fn(async () => undefined);

    await followRunEventStream({
      client: { subscribeRunEvents } as unknown as LeCodingClient,
      runId: "run-1",
      signal: new AbortController().signal,
      onEvent: vi.fn(() => "continue" as const),
      onReconnect: vi.fn(async () => "stop" as const),
      waitBeforeReconnect
    });

    expect(subscribeRunEvents).toHaveBeenCalledTimes(1);
    expect(waitBeforeReconnect).not.toHaveBeenCalled();
  });
});
