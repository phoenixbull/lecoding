import { describe, expect, it } from "vitest";
import { createTestHarness, InMemoryRunStore } from "@lecoding/test-harness";
import type { RunTransitionWriter } from "../src/index.js";

describe("RunEngine transition persistence", () => {
  it("delegates status and event ownership to the atomic transition seam", async () => {
    const store = new InMemoryRunStore();
    let transitionCount = 0;
    const transitions: RunTransitionWriter = {
      async persist(run, status) {
        // The seam owns both state persistence and event publication in production.
        transitionCount += 1;
        run.status = status;
        return store.save(run);
      },
      async persistEvents(run) {
        return store.save(run);
      }
    };
    const harness = await createTestHarness({ store, transitions });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Persist atomically",
      acceptanceCriteria: ["No split state/event write"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });

    expect(transitionCount).toBe(1);
    // The injected transition writer owns the event; the legacy journal is untouched.
    await expect(harness.events.resume(runId)).resolves.toBe("");
  });
});
