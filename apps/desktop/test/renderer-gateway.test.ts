import { describe, expect, it } from "vitest";
import type { RunEventV1 } from "@lecoding/contracts";
import { createIpcRunEventSource } from "../src/renderer/gateway/ipc-event-source.js";
import { createIpcRunGateway } from "../src/renderer/gateway/ipc-gateway.js";
import { createFakeBridge } from "./renderer-bridge.js";

function makeEvent(sequence: number): RunEventV1 {
  return {
    version: 1,
    sequence,
    runId: "run-1",
    type: "status_changed",
    occurredAt: "2026-01-01T00:00:00.000Z",
    data: { status: "running" }
  };
}

/** Drains at most one pending event from an iterator. */
async function next(
  iterator: AsyncIterator<RunEventV1>
): Promise<RunEventV1 | undefined> {
  const result = await iterator.next();
  return result.done ? undefined : result.value;
}

describe("createIpcRunGateway", () => {
  it("routes each controller action to its documented channel", async () => {
    const bridge = createFakeBridge();
    const gateway = createIpcRunGateway(bridge);

    await gateway.getControlPlaneConfig();
    await gateway.inspectRun("run-1");
    await gateway.approveRun("run-1", "approval-1", "run");
    await gateway.steerRun("run-1", "保持旧版错误结构");
    await gateway.revokeDevice("device-1");

    expect(bridge.calls.map((call) => call.channel)).toEqual([
      "config.load",
      "runs.inspect",
      "runs.approve",
      "runs.steer",
      "devices.revoke"
    ]);
  });

  it("omits an undefined history limit instead of sending null", async () => {
    const bridge = createFakeBridge();
    const gateway = createIpcRunGateway(bridge);
    await gateway.listRuns("project-a");
    await gateway.listRuns("project-a", 10);
    expect(bridge.calls[0]?.payload).toEqual({ projectId: "project-a" });
    expect(bridge.calls[1]?.payload).toEqual({ projectId: "project-a", limit: 10 });
  });
});

describe("createIpcRunEventSource", () => {
  it("starts and stops the Main-owned stream with the iterator lifetime", async () => {
    const bridge = createFakeBridge();
    const source = createIpcRunEventSource(bridge);
    const controller = new AbortController();
    const iterator = source.subscribe("run-1", { signal: controller.signal })[
      Symbol.asyncIterator
    ]();

    await Promise.resolve();
    expect(bridge.calls).toContainEqual({
      channel: "runs.subscribe",
      payload: { runId: "run-1" }
    });

    controller.abort();
    await iterator.next();
    await Promise.resolve();
    expect(bridge.calls).toContainEqual({
      channel: "runs.unsubscribe",
      payload: { runId: "run-1" }
    });
  });

  it("delivers only events for the subscribed Run", async () => {
    const bridge = createFakeBridge();
    const source = createIpcRunEventSource(bridge);
    const controller = new AbortController();
    const iterator = source.subscribe("run-1", { signal: controller.signal })[
      Symbol.asyncIterator
    ]();

    bridge.emitRunEvent({ runId: "run-other", event: makeEvent(1) });
    bridge.emitRunEvent({ runId: "run-1", event: makeEvent(2) });
    await expect(next(iterator)).resolves.toMatchObject({ sequence: 2 });
    controller.abort();
  });

  it("ends the iteration when main reports the stream failed", async () => {
    const bridge = createFakeBridge();
    const source = createIpcRunEventSource(bridge);
    const controller = new AbortController();
    const iterator = source.subscribe("run-1", { signal: controller.signal })[
      Symbol.asyncIterator
    ]();

    bridge.emitStreamState({ runId: "run-1", phase: "failed" });
    // Ending the iteration is what lets the shared follower surface
    // "reconnecting" and refresh the Run instead of showing a stale "live".
    await expect(iterator.next()).rejects.toThrow(/lost the Run event stream/);
    controller.abort();
  });

  it("ends the iteration without an error when main closes a finished Run", async () => {
    const bridge = createFakeBridge();
    const source = createIpcRunEventSource(bridge);
    const controller = new AbortController();
    const iterator = source.subscribe("run-1", { signal: controller.signal })[
      Symbol.asyncIterator
    ]();

    bridge.emitStreamState({ runId: "run-1", phase: "closed" });
    await expect(next(iterator)).resolves.toBeUndefined();
    controller.abort();
  });

  it("ignores a stream-state report for a different Run", async () => {
    const bridge = createFakeBridge();
    const source = createIpcRunEventSource(bridge);
    const controller = new AbortController();
    const iterator = source.subscribe("run-1", { signal: controller.signal })[
      Symbol.asyncIterator
    ]();

    bridge.emitStreamState({ runId: "run-other", phase: "failed" });
    bridge.emitRunEvent({ runId: "run-1", event: makeEvent(1) });
    await expect(next(iterator)).resolves.toMatchObject({ sequence: 1 });
    controller.abort();
  });

  it("detaches its listeners when the signal aborts", async () => {
    const bridge = createFakeBridge();
    const source = createIpcRunEventSource(bridge);
    const controller = new AbortController();
    const iterator = source.subscribe("run-1", { signal: controller.signal })[
      Symbol.asyncIterator
    ]();

    controller.abort();
    await expect(next(iterator)).resolves.toBeUndefined();
    // After aborting, pushes must not accumulate for a dead subscription.
    bridge.emitRunEvent({ runId: "run-1", event: makeEvent(1) });
    await expect(next(iterator)).resolves.toBeUndefined();
  });
});
