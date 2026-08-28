import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@lecoding/test-harness";
import {
  createPostgresRunBudgetManager,
  type AgentModel
} from "../src/index.js";

describe("RunEngine budget integration", () => {
  it("fails before a tool side effect when settled model usage exceeds tokens", async () => {
    const database = new PGlite();
    const budgets = await createPostgresRunBudgetManager(database, {
      limits: {
        maxTotalTokens: 10,
        warningCostUsd: 1,
        maxCostUsd: 2,
        maxWallTimeMs: 30 * 60_000,
        maxToolCalls: 60,
        maxActiveRunsPerUser: 2,
        maxActiveRunsPerProject: 5,
        teamMonthlyWarningUsd: 350,
        teamMonthlyMaxUsd: 420
      },
      pricing: {
        modelId: "vendor-model-v1",
        version: "pricing-2026-08-28",
        inputUsdPerMillion: 0.14,
        outputUsdPerMillion: 0.28
      }
    });
    const perform = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const model: AgentModel = {
      async next(input) {
        // Mirrors the production model gateway: usage settles before turn delivery.
        await budgets.recordModelUsage({
          runId: input.runId,
          inputTokens: 10,
          outputTokens: 1
        });
        return {
          type: "tool_call",
          callId: "over-budget-call",
          tool: "execute_command",
          arguments: { argv: ["pnpm", "test"] }
        };
      }
    };
    const harness = await createTestHarness({
      budgets,
      model,
      environment: {
        prepare: async (spec) => ({
          id: `handle-${spec.runId}`,
          environmentId: spec.environmentId
        }),
        perform,
        inspect: async () => ({ changedFiles: [] }),
        dispose: async () => undefined
      }
    });
    const runId = await harness.engine.start(
      {
        projectId: "project-1",
        environmentId: "environment-1",
        task: "Run the tests",
        acceptanceCriteria: ["Tests pass"],
        approvalMode: "auto_review",
        fileAccessScope: "workspace_only"
      },
      { actorId: "user-1" }
    );

    await harness.engine.resume(runId);

    expect(perform).not.toHaveBeenCalled();
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "failed",
      failure: {
        code: "budget_exhausted",
        message: "Run token limit exceeded"
      },
      budget: {
        inputTokens: 10,
        outputTokens: 1,
        totalTokens: 11,
        maxTotalTokens: 10,
        modelId: "vendor-model-v1",
        pricingVersion: "pricing-2026-08-28"
      }
    });
    await database.close();
  });
});
