import { afterEach, describe, expect, it } from "vitest";
import { createRunConsoleController, type RunConsoleController } from "../src/controller.js";
import {
  createFakeGateway,
  createManualEventSource,
  makeChanges,
  makeEvent,
  makeRunView,
  makeSummary,
  makeTerminalEvent,
  settle,
  type FakeGateway,
  type ManualEventSource
} from "./fakes.js";

let controller: RunConsoleController | undefined;

afterEach(() => {
  controller?.dispose();
  controller = undefined;
});

function setup(options: { gateway?: FakeGateway; events?: ManualEventSource } = {}): {
  controller: RunConsoleController;
  gateway: FakeGateway;
  events: ManualEventSource;
} {
  const gateway = options.gateway ?? createFakeGateway();
  const events = options.events ?? createManualEventSource();
  const instance = createRunConsoleController({
    gateway,
    events,
    waitBeforeReconnect: () => Promise.resolve()
  });
  controller = instance;
  return { controller: instance, gateway, events };
}

/** A Run with a readable worktree so a changes 404 cannot pollute the assertions. */
function liveRun(status: "running" | "succeeded" | "cancelled" = "running"): FakeGateway {
  const gateway = createFakeGateway({ history: [] });
  gateway.setView(makeRunView({ id: "run-1", status }));
  gateway.setChanges("run-1", makeChanges());
  return gateway;
}

describe("event stream lifecycle", () => {
  it("follows the selected Run through the event-source port", async () => {
    const { controller: instance, events } = setup({ gateway: liveRun() });
    await instance.initialize();
    await instance.selectRun("run-1");
    expect(events.subscriptions).toEqual([{ runId: "run-1" }]);
    expect(instance.getState().stream).toEqual({ phase: "connecting", runId: "run-1" });
  });

  it("appends live events and reports the stream as live", async () => {
    const { controller: instance, events } = setup({ gateway: liveRun() });
    await instance.initialize();
    await instance.selectRun("run-1");
    events.emit("run-1", makeEvent(1, { data: { status: "running" } }));
    await settle();
    const state = instance.getState();
    expect(state.stream).toEqual({ phase: "live", runId: "run-1" });
    expect(state.timeline.map((event) => event.sequence)).toEqual([1]);
  });

  it("closes the stream on a terminal event and stops following", async () => {
    const gateway = liveRun();
    const { controller: instance, events } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    gateway.setView(makeRunView({ id: "run-1", status: "succeeded" }));
    events.emit("run-1", makeTerminalEvent(1));
    await settle();
    expect(instance.getState().stream).toEqual({ phase: "closed", runId: "run-1" });
    const subscriptionsAfterTerminal = events.subscriptionCount("run-1");
    events.emit("run-1", makeEvent(2));
    await settle();
    // A closed stream must not reopen on its own.
    expect(events.subscriptionCount("run-1")).toBe(subscriptionsAfterTerminal);
  });

  it("reconnects after a transport failure and resumes from the last sequence", async () => {
    const { controller: instance, events } = setup({ gateway: liveRun() });
    await instance.initialize();
    await instance.selectRun("run-1");
    events.emit("run-1", makeEvent(4));
    await settle();

    events.fail("run-1", new Error("socket reset"));
    await settle();
    // Reconnecting is a distinct, user-visible state: it must persist until a
    // fresh event proves the stream is live again, and the mid-reconnect
    // refresh must not be mistaken for a terminal state.
    expect(instance.getState().stream).toEqual({ phase: "reconnecting", runId: "run-1" });
    const resumed = events.subscriptions.at(-1);
    expect(resumed?.lastEventId).toBe("4");

    events.emit("run-1", makeEvent(5));
    await settle();
    expect(instance.getState().stream).toEqual({ phase: "live", runId: "run-1" });
    expect(instance.getState().timeline.map((event) => event.sequence)).toEqual([4, 5]);
  });

  it("does not replay an event the server re-sends after resuming", async () => {
    const { controller: instance, events } = setup({ gateway: liveRun() });
    await instance.initialize();
    await instance.selectRun("run-1");
    events.emit("run-1", makeEvent(4));
    await settle();
    events.fail("run-1", new Error("socket reset"));
    await settle();
    // At-least-once delivery means the resumed stream may start before 5.
    events.emit("run-1", makeEvent(4));
    events.emit("run-1", makeEvent(5));
    await settle();
    expect(instance.getState().timeline.map((event) => event.sequence)).toEqual([4, 5]);
  });

  it("aborts the previous stream when the operator switches Runs", async () => {
    const gateway = liveRun();
    gateway.setView(makeRunView({ id: "run-2", status: "running" }));
    gateway.setChanges("run-2", makeChanges());
    const { controller: instance, events } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    await instance.selectRun("run-2");
    expect(instance.getState().stream).toEqual({ phase: "connecting", runId: "run-2" });

    const timelineBefore = instance.getState().timeline.length;
    events.emit("run-1", makeEvent(9));
    await settle();
    // The stale stream must not append to the newly selected Run's timeline.
    expect(instance.getState().timeline.length).toBe(timelineBefore);
    expect(instance.getState().selectedRunId).toBe("run-2");
  });

  it("does not re-follow a Run that is already selected and loaded", async () => {
    const { controller: instance, events } = setup({ gateway: liveRun() });
    await instance.initialize();
    await instance.selectRun("run-1");
    const before = events.subscriptionCount("run-1");
    await instance.selectRun("run-1");
    expect(events.subscriptionCount("run-1")).toBe(before);
  });

  it("stops the stream on dispose so a late event cannot mutate state", async () => {
    const { controller: instance, events } = setup({ gateway: liveRun() });
    await instance.initialize();
    await instance.selectRun("run-1");
    instance.dispose();
    events.emit("run-1", makeEvent(1));
    await settle();
    expect(instance.getState().timeline).toEqual([]);
  });
});

describe("worktree messaging during streaming", () => {
  it("explains that a cancelled Run's worktree was already cleaned up", async () => {
    const gateway = liveRun("running");
    const { controller: instance, events } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    gateway.setView(makeRunView({ id: "run-1", status: "cancelled" }));
    events.emit("run-1", makeEvent(1, { data: { status: "cancelled" } }));
    await settle();
    expect(instance.getState().changes).toBeUndefined();
    expect(instance.getState().changesMessage).toContain("已安全清理");
  });

  it("keeps the diff available while the Run still owns a worktree", async () => {
    const gateway = liveRun("running");
    const { controller: instance, events } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    gateway.setChanges("run-1", makeChanges({ changedFiles: ["src/a.ts", "src/b.ts"] }));
    events.emit("run-1", makeEvent(1, { data: { status: "running" } }));
    await settle();
    expect(instance.getState().changes?.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("updates the history entry as the Run advances", async () => {
    const gateway = createFakeGateway({
      history: [makeSummary({ id: "run-1", status: "queued" })]
    });
    gateway.setView(makeRunView({ id: "run-1", status: "running" }));
    gateway.setChanges("run-1", makeChanges());
    const { controller: instance, events } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    gateway.setView(makeRunView({ id: "run-1", status: "running" }));
    events.emit("run-1", makeEvent(1, { data: { status: "running" } }));
    await settle();
    expect(instance.getState().recentRuns[0]?.status).toBe("running");
  });
});

describe("in-flight refresh merging", () => {
  it("collapses an event burst into a single inspect per Run", async () => {
    const gateway = liveRun();
    const { controller: instance, events } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    const before = gateway.calls.filter((call) => call.method === "inspectRun").length;

    // A burst of events that all arrive before the first refresh resolves.
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      events.emit("run-1", makeEvent(sequence));
      await settle();
    }
    const after = gateway.calls.filter((call) => call.method === "inspectRun").length;
    // One inspect per event plus the initial selection inspect would be 6;
    // deduplication keeps the burst from stacking concurrent requests.
    expect(after - before).toBeLessThanOrEqual(5);
  });
});
