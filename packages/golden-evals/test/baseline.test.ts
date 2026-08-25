import { describe, expect, it } from "vitest";
import {
  loadGoldenTaskCatalog,
  runGoldenBaseline,
  selectRepresentativeGoldenTasks
} from "../src/index.js";

describe("runGoldenBaseline", () => {
  it("records quality, token, cost, and duration totals for five representatives", async () => {
    const tasks = selectRepresentativeGoldenTasks(loadGoldenTaskCatalog());
    let clock = 0;
    const report = await runGoldenBaseline({
      tasks,
      createdAt: "2026-08-25T08:00:00.000Z",
      nowMs: () => {
        clock += 100;
        return clock;
      },
      executor: {
        execute: async () => ({
          modelId: "provider/model-v1",
          outcome: "passed",
          inputTokens: 1_000,
          outputTokens: 200,
          costUsd: 0.01
        })
      }
    });

    expect(report.summary).toEqual({
      taskCount: 5,
      passed: 5,
      failed: 0,
      passRate: 1,
      inputTokens: 5_000,
      outputTokens: 1_000,
      costUsd: 0.05,
      durationMs: 500
    });
    expect(report.results.map((result) => result.taskId)).toEqual(
      tasks.map((task) => task.id)
    );
  });
});
