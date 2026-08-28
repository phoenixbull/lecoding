import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createPostgresRunBudgetManager } from "../src/postgres-run-budget.js";

describe("PostgreSQL Run budget manager", () => {
  it("atomically reserves worst-case model tokens and releases them on settlement", async () => {
    const database = new PGlite();
    const budgets = await createPostgresRunBudgetManager(database, {
      limits: {
        maxTotalTokens: 250,
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
    await budgets.open({
      runId: "run-reserve",
      projectId: "project-1",
      userId: "user-1"
    });

    await expect(
      budgets.reserveModelRequest({
        runId: "run-reserve",
        requestId: "request-1",
        maxInputTokens: 200,
        maxOutputTokens: 50
      })
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      budgets.settleModelRequest({
        runId: "run-reserve",
        requestId: "request-1",
        inputTokens: 10,
        outputTokens: 5
      })
    ).resolves.toMatchObject({
      allowed: true,
      snapshot: { totalTokens: 15 }
    });
    await expect(
      budgets.reserveModelRequest({
        runId: "run-reserve",
        requestId: "request-2",
        maxInputTokens: 200,
        maxOutputTokens: 50
      })
    ).resolves.toMatchObject({ allowed: false, reason: "token_limit" });
    await database.close();
  });

  it("fails closed when provider usage exceeds its reserved request envelope", async () => {
    const database = new PGlite();
    const budgets = await createPostgresRunBudgetManager(database, {
      limits: {
        maxTotalTokens: 1_000,
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
    await budgets.open({
      runId: "run-provider-overage",
      projectId: "project-1",
      userId: "user-1"
    });
    await budgets.reserveModelRequest({
      runId: "run-provider-overage",
      requestId: "request-provider-overage",
      maxInputTokens: 100,
      maxOutputTokens: 20
    });

    await expect(
      budgets.settleModelRequest({
        runId: "run-provider-overage",
        requestId: "request-provider-overage",
        inputTokens: 101,
        outputTokens: 20
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: "token_limit",
      snapshot: { inputTokens: 101, outputTokens: 20, totalTokens: 121 }
    });
    await database.close();
  });

  it("conservatively forfeits unknown provider usage exactly once", async () => {
    const database = new PGlite();
    const budgets = await createPostgresRunBudgetManager(database, {
      limits: {
        maxTotalTokens: 1_000,
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
    await budgets.open({
      runId: "run-forfeit",
      projectId: "project-1",
      userId: "user-1"
    });
    await budgets.reserveModelRequest({
      runId: "run-forfeit",
      requestId: "request-unknown",
      maxInputTokens: 100,
      maxOutputTokens: 20
    });

    await expect(
      budgets.forfeitModelRequest({
        runId: "run-forfeit",
        requestId: "request-unknown"
      })
    ).resolves.toMatchObject({
      allowed: true,
      snapshot: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
    });
    await budgets.forfeitModelRequest({
      runId: "run-forfeit",
      requestId: "request-unknown"
    });
    await expect(budgets.get("run-forfeit")).resolves.toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUsd: 0.00002
    });
    await database.close();
  });

  it("charges an in-flight reservation before terminal budget closure", async () => {
    const database = new PGlite();
    const budgets = await createPostgresRunBudgetManager(database, {
      limits: {
        maxTotalTokens: 1_000,
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
    await budgets.open({
      runId: "run-cancelled-request",
      projectId: "project-1",
      userId: "user-1"
    });
    await budgets.reserveModelRequest({
      runId: "run-cancelled-request",
      requestId: "request-in-flight",
      maxInputTokens: 100,
      maxOutputTokens: 20
    });

    await budgets.close("run-cancelled-request");

    await expect(budgets.get("run-cancelled-request")).resolves.toMatchObject({
      active: false,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUsd: 0.00002
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

    await budgets.reserveModelRequest({
      runId: "run-cost",
      requestId: "request-cost-1",
      maxInputTokens: 100,
      maxOutputTokens: 20
    });
    await expect(
      budgets.settleModelRequest({
        runId: "run-cost",
        requestId: "request-cost-1",
        inputTokens: 100,
        outputTokens: 20
      })
    ).resolves.toMatchObject({
      allowed: true,
      snapshot: { costUsd: 0.00002, warnings: ["cost_warning"] }
    });
    await expect(
      budgets.reserveModelRequest({
        runId: "run-cost",
        requestId: "request-cost-2",
        maxInputTokens: 1,
        maxOutputTokens: 1
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: "cost_limit",
      snapshot: { costUsd: 0.00002 }
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

  it("allows three retryable model errors across a Run and rejects the fourth", async () => {
    const database = new PGlite();
    const budgets = await createPostgresRunBudgetManager(database, {
      limits: {
        maxTotalTokens: 10_000,
        warningCostUsd: 1,
        maxCostUsd: 2,
        maxWallTimeMs: 30 * 60_000,
        maxToolCalls: 60,
        maxModelRetries: 3,
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
      runId: "run-retries",
      projectId: "project-1",
      userId: "user-1"
    });

    await expect(budgets.recordModelRetry("run-retries")).resolves.toMatchObject({
      allowed: true,
      snapshot: { modelRetries: 1, maxModelRetries: 3 }
    });
    await budgets.recordModelRetry("run-retries");
    await expect(budgets.recordModelRetry("run-retries")).resolves.toMatchObject({
      allowed: true,
      snapshot: { modelRetries: 3, warnings: ["retry_warning"] }
    });
    await expect(budgets.recordModelRetry("run-retries")).resolves.toMatchObject({
      allowed: false,
      reason: "retry_limit",
      snapshot: { modelRetries: 4, maxModelRetries: 3 }
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
    await budgets.reserveModelRequest({
      runId: "run-spent",
      requestId: "request-spent",
      maxInputTokens: 100,
      maxOutputTokens: 20
    });
    await budgets.settleModelRequest({
      runId: "run-spent",
      requestId: "request-spent",
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

  it("counts active model reservations when admitting a new team Run", async () => {
    const database = new PGlite();
    const budgets = await createPostgresRunBudgetManager(database, {
      limits: {
        maxTotalTokens: 10_000,
        warningCostUsd: 1,
        maxCostUsd: 2,
        maxWallTimeMs: 30 * 60_000,
        maxToolCalls: 60,
        maxActiveRunsPerUser: 5,
        maxActiveRunsPerProject: 5,
        teamMonthlyWarningUsd: 0.000016,
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
      runId: "run-reserved-team-cost",
      projectId: "project-1",
      userId: "user-1"
    });
    await budgets.reserveModelRequest({
      runId: "run-reserved-team-cost",
      requestId: "request-reserved-team-cost",
      maxInputTokens: 100,
      maxOutputTokens: 20
    });

    await expect(
      budgets.open({
        runId: "run-after-reservation",
        projectId: "project-2",
        userId: "user-2"
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: "team_monthly_cost_limit",
      spentUsd: 0.00002,
      limitUsd: 0.00002
    });
    await database.close();
  });

  it("accounts provider overage in the team month before failing the request", async () => {
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

    await budgets.reserveModelRequest({
      runId: "run-cross-team-limit",
      requestId: "request-cross-team-limit",
      maxInputTokens: 100,
      maxOutputTokens: 20
    });
    await expect(
      budgets.settleModelRequest({
        runId: "run-cross-team-limit",
        requestId: "request-cross-team-limit",
        inputTokens: 103,
        outputTokens: 20
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: "token_limit",
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
