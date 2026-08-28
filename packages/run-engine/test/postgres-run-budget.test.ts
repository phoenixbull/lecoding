import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createPostgresRunBudgetManager } from "../src/postgres-run-budget.js";

describe("PostgreSQL Run budget manager", () => {
  it("atomically records provider usage and closes the token hard limit", async () => {
    const database = new PGlite();
    const budgets = await createPostgresRunBudgetManager(database, {
      limits: {
        maxTotalTokens: 150,
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
      },
      now: () => "2026-08-28T08:00:00.000Z"
    });
    await budgets.open({
      runId: "run-1",
      projectId: "project-1",
      userId: "user-1"
    });

    await expect(
      budgets.recordModelUsage({
        runId: "run-1",
        inputTokens: 100,
        outputTokens: 20
      })
    ).resolves.toMatchObject({
      allowed: true,
      snapshot: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
    });
    await expect(
      budgets.recordModelUsage({
        runId: "run-1",
        inputTokens: 30,
        outputTokens: 1
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: "token_limit",
      snapshot: {
        inputTokens: 130,
        outputTokens: 21,
        totalTokens: 151,
        pricingVersion: "pricing-2026-08-28"
      }
    });
    await expect(budgets.get("run-1")).resolves.toMatchObject({
      totalTokens: 151,
      maxTotalTokens: 150
    });
    await database.close();
  });

  it("warns at the configured cost threshold and rejects above the hard limit", async () => {
    const database = new PGlite();
    const budgets = await createPostgresRunBudgetManager(database, {
      limits: {
        maxTotalTokens: 10_000,
        warningCostUsd: 0.00001,
        maxCostUsd: 0.00002,
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
      },
      now: () => "2026-08-28T08:00:00.000Z"
    });
    await budgets.open({
      runId: "run-cost",
      projectId: "project-1",
      userId: "user-1"
    });

    await expect(
      budgets.recordModelUsage({
        runId: "run-cost",
        inputTokens: 100,
        outputTokens: 20
      })
    ).resolves.toMatchObject({
      allowed: true,
      snapshot: { costUsd: 0.00002, warnings: ["cost_warning"] }
    });
    await expect(
      budgets.recordModelUsage({
        runId: "run-cost",
        inputTokens: 1,
        outputTokens: 0
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: "cost_limit",
      snapshot: { costUsd: 0.000021 }
    });
    await database.close();
  });

  it("counts every model tool request before allowing another step", async () => {
    const database = new PGlite();
    const budgets = await createPostgresRunBudgetManager(database, {
      limits: {
        maxTotalTokens: 10_000,
        warningCostUsd: 1,
        maxCostUsd: 2,
        maxWallTimeMs: 30 * 60_000,
        maxToolCalls: 2,
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
    await budgets.open({
      runId: "run-tools",
      projectId: "project-1",
      userId: "user-1"
    });

    await expect(budgets.recordToolCall("run-tools")).resolves.toMatchObject({
      allowed: true,
      snapshot: { toolCalls: 1 }
    });
    await expect(budgets.recordToolCall("run-tools")).resolves.toMatchObject({
      allowed: true,
      snapshot: { toolCalls: 2, warnings: ["tool_call_warning"] }
    });
    await expect(budgets.recordToolCall("run-tools")).resolves.toMatchObject({
      allowed: false,
      reason: "tool_call_limit",
      snapshot: { toolCalls: 3 }
    });
    await database.close();
  });

  it("keeps the wall-clock deadline across later checks", async () => {
    const database = new PGlite();
    let now = "2026-08-28T08:00:00.000Z";
    const budgets = await createPostgresRunBudgetManager(database, {
      limits: {
        maxTotalTokens: 10_000,
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
      },
      now: () => now
    });
    await budgets.open({
      runId: "run-time",
      projectId: "project-1",
      userId: "user-1"
    });

    now = "2026-08-28T08:30:00.000Z";
    await expect(budgets.check("run-time")).resolves.toMatchObject({
      allowed: true,
      snapshot: { elapsedMs: 1_800_000, warnings: ["wall_time_warning"] }
    });
    now = "2026-08-28T08:30:00.001Z";
    await expect(budgets.check("run-time")).resolves.toMatchObject({
      allowed: false,
      reason: "wall_time_limit",
      snapshot: { elapsedMs: 1_800_001 }
    });
    await database.close();
  });

  it("atomically rejects user concurrency until an active Run closes", async () => {
    const database = new PGlite();
    const budgets = await createPostgresRunBudgetManager(database, {
      limits: {
        maxTotalTokens: 10_000,
        warningCostUsd: 1,
        maxCostUsd: 2,
        maxWallTimeMs: 30 * 60_000,
        maxToolCalls: 60,
        maxActiveRunsPerUser: 1,
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

    await expect(
      budgets.open({
        runId: "run-active",
        projectId: "project-1",
        userId: "user-1"
      })
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      budgets.open({
        runId: "run-blocked",
        projectId: "project-2",
        userId: "user-1"
      })
    ).resolves.toEqual({
      allowed: false,
      reason: "user_concurrency_limit",
      activeRuns: 1,
      limit: 1
    });
    await expect(budgets.get("run-blocked")).resolves.toBeUndefined();

    await budgets.close("run-active");
    await expect(
      budgets.open({
        runId: "run-blocked",
        projectId: "project-2",
        userId: "user-1"
      })
    ).resolves.toMatchObject({ allowed: true });
    await database.close();
  });

  it("counts active Runs across users against the project concurrency limit", async () => {
    const database = new PGlite();
    const budgets = await createPostgresRunBudgetManager(database, {
      limits: {
        maxTotalTokens: 10_000,
        warningCostUsd: 1,
        maxCostUsd: 2,
        maxWallTimeMs: 30 * 60_000,
        maxToolCalls: 60,
        maxActiveRunsPerUser: 5,
        maxActiveRunsPerProject: 1,
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
    await budgets.open({
      runId: "run-project-active",
      projectId: "project-shared",
      userId: "user-1"
    });

    await expect(
      budgets.open({
        runId: "run-project-blocked",
        projectId: "project-shared",
        userId: "user-2"
      })
    ).resolves.toEqual({
      allowed: false,
      reason: "project_concurrency_limit",
      activeRuns: 1,
      limit: 1
    });
    // Admission rejection must not leave a phantom row that blocks later work.
    await expect(budgets.get("run-project-blocked")).resolves.toBeUndefined();
    await database.close();
  });

  it("stops new Runs after the team monthly hard budget is reached", async () => {
    const database = new PGlite();
    const budgets = await createPostgresRunBudgetManager(database, {
      limits: {
        maxTotalTokens: 10_000,
        warningCostUsd: 1,
        maxCostUsd: 2,
        maxWallTimeMs: 30 * 60_000,
        maxToolCalls: 60,
        maxActiveRunsPerUser: 2,
        maxActiveRunsPerProject: 5,
        teamMonthlyWarningUsd: 0.00001,
        teamMonthlyMaxUsd: 0.00002
      },
      pricing: {
        modelId: "vendor-model-v1",
        version: "pricing-2026-08-28",
        inputUsdPerMillion: 0.14,
        outputUsdPerMillion: 0.28
      },
      now: () => "2026-08-28T08:00:00.000Z"
    });
    await budgets.open({
      runId: "run-spent",
      projectId: "project-1",
      userId: "user-1"
    });
    await budgets.recordModelUsage({
      runId: "run-spent",
      inputTokens: 100,
      outputTokens: 20
    });
    await budgets.close("run-spent");

    await expect(
      budgets.open({
        runId: "run-next",
        projectId: "project-2",
        userId: "user-2"
      })
    ).resolves.toEqual({
      allowed: false,
      reason: "team_monthly_cost_limit",
      spentUsd: 0.00002,
      limitUsd: 0.00002
    });
    await expect(budgets.get("run-next")).resolves.toBeUndefined();
    await database.close();
  });

  it("stops the active Run when usage crosses the team monthly limit", async () => {
    const database = new PGlite();
    const budgets = await createPostgresRunBudgetManager(database, {
      limits: {
        maxTotalTokens: 10_000,
        warningCostUsd: 1,
        maxCostUsd: 2,
        maxWallTimeMs: 30 * 60_000,
        maxToolCalls: 60,
        maxActiveRunsPerUser: 2,
        maxActiveRunsPerProject: 5,
        teamMonthlyWarningUsd: 0.00001,
        teamMonthlyMaxUsd: 0.00002
      },
      pricing: {
        modelId: "vendor-model-v1",
        version: "pricing-2026-08-28",
        inputUsdPerMillion: 0.14,
        outputUsdPerMillion: 0.28
      },
      now: () => "2026-08-28T08:00:00.000Z"
    });
    await budgets.open({
      runId: "run-cross-team-limit",
      projectId: "project-1",
      userId: "user-1"
    });

    await expect(
      budgets.recordModelUsage({
        runId: "run-cross-team-limit",
        inputTokens: 103,
        outputTokens: 20
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: "team_monthly_cost_limit",
      snapshot: {
        costUsd: 0.000021,
        teamMonthlyCostUsd: 0.000021,
        teamMonthlyMaxUsd: 0.00002,
        warnings: ["team_monthly_cost_warning"]
      }
    });
    await database.close();
  });
});
