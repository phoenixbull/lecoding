import type { PostgresExecutor } from "./postgres-run-lease.js";

/** Immutable limits copied into each Run so administrator changes are non-retroactive. */
export interface RunBudgetLimits {
  maxTotalTokens: number;
  warningCostUsd: number;
  maxCostUsd: number;
  maxWallTimeMs: number;
  maxToolCalls: number;
  maxActiveRunsPerUser: number;
  maxActiveRunsPerProject: number;
  teamMonthlyWarningUsd: number;
  teamMonthlyMaxUsd: number;
}

/** Versioned provider price snapshot used for auditable cost accounting. */
export interface RunModelPricing {
  modelId: string;
  version: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

/** Public, bounded projection shared by RunEngine, API, and monitoring. */
export interface RunBudgetSnapshot {
  runId: string;
  projectId: string;
  userId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  toolCalls: number;
  elapsedMs: number;
  maxTotalTokens: number;
  warningCostUsd: number;
  maxCostUsd: number;
  maxWallTimeMs: number;
  maxToolCalls: number;
  teamMonthlyCostUsd: number;
  teamMonthlyWarningUsd: number;
  teamMonthlyMaxUsd: number;
  modelId: string;
  pricingVersion: string;
  active: boolean;
  warnings: RunBudgetWarning[];
}

/** Stable near-limit labels rendered without exposing pricing internals. */
export type RunBudgetWarning =
  | "token_warning"
  | "cost_warning"
  | "wall_time_warning"
  | "tool_call_warning"
  | "team_monthly_cost_warning";

/** Stable hard-limit categories suitable for Run failure and metrics labels. */
export type RunBudgetLimitReason =
  | "token_limit"
  | "cost_limit"
  | "wall_time_limit"
  | "tool_call_limit"
  | "user_concurrency_limit"
  | "project_concurrency_limit"
  | "team_monthly_cost_limit";

/** Every mutation returns the authoritative persisted snapshot and gate decision. */
export type RunBudgetDecision =
  | { allowed: true; snapshot: RunBudgetSnapshot }
  | { allowed: false; reason: RunBudgetLimitReason; snapshot: RunBudgetSnapshot };

/** Admission result exposes bounded counts without creating a rejected Run row. */
export type RunBudgetAdmission =
  | { allowed: true; snapshot: RunBudgetSnapshot }
  | {
      allowed: false;
      reason: "user_concurrency_limit" | "project_concurrency_limit";
      activeRuns: number;
      limit: number;
    }
  | {
      allowed: false;
      reason: "team_monthly_cost_limit";
      spentUsd: number;
      limitUsd: number;
    };

/** Durable budget interface; provider usage must be recorded before its turn is used. */
export interface RunBudgetManager {
  open(input: {
    runId: string;
    projectId: string;
    userId: string;
  }): Promise<RunBudgetAdmission>;
  recordModelUsage(input: {
    runId: string;
    inputTokens: number;
    outputTokens: number;
  }): Promise<RunBudgetDecision>;
  recordToolCall(runId: string): Promise<RunBudgetDecision>;
  check(runId: string): Promise<RunBudgetDecision>;
  close(runId: string): Promise<void>;
  get(runId: string): Promise<RunBudgetSnapshot | undefined>;
}

/** PostgreSQL-backed marker retained for composition and API type clarity. */
export interface PostgresRunBudgetManager extends RunBudgetManager {}

/** PostgreSQL source of truth for per-Run usage and snapshotted limits/pricing. */
export const RUN_BUDGET_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_engine_budgets (
  run_id text PRIMARY KEY,
  project_id text NOT NULL,
  user_id text NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_microusd bigint NOT NULL DEFAULT 0 CHECK (cost_microusd >= 0),
  tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  max_total_tokens bigint NOT NULL CHECK (max_total_tokens > 0),
  warning_cost_microusd bigint NOT NULL CHECK (warning_cost_microusd >= 0),
  max_cost_microusd bigint NOT NULL CHECK (max_cost_microusd > 0),
  max_wall_time_ms bigint NOT NULL CHECK (max_wall_time_ms > 0),
  max_tool_calls integer NOT NULL CHECK (max_tool_calls > 0),
  team_monthly_warning_microusd bigint NOT NULL CHECK (team_monthly_warning_microusd >= 0),
  team_monthly_max_microusd bigint NOT NULL CHECK (team_monthly_max_microusd > 0),
  model_id text NOT NULL,
  pricing_version text NOT NULL,
  input_usd_per_million numeric(18, 6) NOT NULL CHECK (input_usd_per_million >= 0),
  output_usd_per_million numeric(18, 6) NOT NULL CHECK (output_usd_per_million >= 0),
  started_at timestamptz NOT NULL,
  finished_at timestamptz
);
`;

const RUN_BUDGET_ACTIVE_USER_INDEX_SQL = `CREATE INDEX IF NOT EXISTS
  run_engine_budgets_active_user_idx ON run_engine_budgets (user_id)
  WHERE finished_at IS NULL;`;
const RUN_BUDGET_ACTIVE_PROJECT_INDEX_SQL = `CREATE INDEX IF NOT EXISTS
  run_engine_budgets_active_project_idx ON run_engine_budgets (project_id)
  WHERE finished_at IS NULL;`;

/** Creates a manager with deployment-owned limits and one immutable price version. */
export async function createPostgresRunBudgetManager(
  database: PostgresExecutor,
  options: {
    limits: RunBudgetLimits;
    pricing: RunModelPricing;
    now?: () => string;
  }
): Promise<PostgresRunBudgetManager> {
  validateLimits(options.limits);
  validatePricing(options.pricing);
  await database.query(RUN_BUDGET_SCHEMA_SQL);
  await database.query(RUN_BUDGET_ACTIVE_USER_INDEX_SQL);
  await database.query(RUN_BUDGET_ACTIVE_PROJECT_INDEX_SQL);
  const now = options.now ?? (() => new Date().toISOString());
  const warningCostMicrousd = usdToMicrousd(options.limits.warningCostUsd);
  const maxCostMicrousd = usdToMicrousd(options.limits.maxCostUsd);
  const teamMonthlyMaxMicrousd = usdToMicrousd(
    options.limits.teamMonthlyMaxUsd
  );
  const teamMonthlyWarningMicrousd = usdToMicrousd(
    options.limits.teamMonthlyWarningUsd
  );

  const get = async (runId: string): Promise<RunBudgetSnapshot | undefined> => {
    validateIdentifier(runId, "Run ID");
    const result = await database.query<RunBudgetRow>(
      `SELECT budget.*,
              (SELECT COALESCE(sum(peer.cost_microusd), 0)
                 FROM run_engine_budgets peer
                WHERE peer.started_at >= date_trunc('month', budget.started_at)
                  AND peer.started_at < date_trunc('month', budget.started_at) + interval '1 month'
              ) AS team_monthly_cost
         FROM run_engine_budgets budget
        WHERE budget.run_id = $1`,
      [runId]
    );
    return result.rows[0] ? mapSnapshot(result.rows[0], requireNow(now)) : undefined;
  };

  return {
    async open(input) {
      validateIdentifier(input.runId, "Run ID");
      validateIdentifier(input.projectId, "Project ID");
      validateIdentifier(input.userId, "User ID");
      const startedAt = requireNow(now);
      const admitted = await database.query<RunBudgetRow>(
        `WITH admission_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(1279345491::bigint)
         ), existing AS MATERIALIZED (
           SELECT budget.*
             FROM run_engine_budgets budget, admission_lock
            WHERE budget.run_id = $1
         ), active_counts AS MATERIALIZED (
           SELECT
             count(*) FILTER (WHERE user_id = $3 AND finished_at IS NULL) AS user_active,
             count(*) FILTER (WHERE project_id = $2 AND finished_at IS NULL) AS project_active,
             COALESCE(sum(cost_microusd) FILTER (
               WHERE started_at >= date_trunc('month', $13::timestamptz)
                 AND started_at < date_trunc('month', $13::timestamptz) + interval '1 month'
             ), 0) AS monthly_cost
             FROM run_engine_budgets, admission_lock
         ), inserted AS (
           INSERT INTO run_engine_budgets
             (run_id, project_id, user_id, max_total_tokens,
              warning_cost_microusd, max_cost_microusd, max_wall_time_ms,
              max_tool_calls, team_monthly_warning_microusd,
              team_monthly_max_microusd, model_id, pricing_version, input_usd_per_million,
              output_usd_per_million, started_at)
           SELECT $1, $2, $3, $4::bigint, $5::bigint, $6::bigint, $7::bigint,
                  $8::integer, $17::bigint, $16::bigint,
                  $9, $10, $11::numeric, $12::numeric,
                  $13::timestamptz
             FROM active_counts
            WHERE user_active < $14::integer
              AND project_active < $15::integer
              AND monthly_cost < $16::bigint
              AND NOT EXISTS (SELECT 1 FROM existing)
           ON CONFLICT (run_id) DO NOTHING
           RETURNING *
         )
         SELECT * FROM existing
         UNION ALL
         SELECT * FROM inserted
         LIMIT 1`,
        [
          input.runId,
          input.projectId,
          input.userId,
          options.limits.maxTotalTokens,
          warningCostMicrousd,
          maxCostMicrousd,
          options.limits.maxWallTimeMs,
          options.limits.maxToolCalls,
          options.pricing.modelId,
          options.pricing.version,
          options.pricing.inputUsdPerMillion,
          options.pricing.outputUsdPerMillion,
          startedAt,
          options.limits.maxActiveRunsPerUser,
          options.limits.maxActiveRunsPerProject,
          teamMonthlyMaxMicrousd,
          teamMonthlyWarningMicrousd
        ]
      );
      const row = admitted.rows[0];
      if (!row) {
        const counts = await database.query<{
          user_active: string | number;
          project_active: string | number;
          monthly_cost: string | number;
        }>(
          `SELECT
             count(*) FILTER (WHERE user_id = $1 AND finished_at IS NULL) AS user_active,
             count(*) FILTER (WHERE project_id = $2 AND finished_at IS NULL) AS project_active,
             COALESCE(sum(cost_microusd) FILTER (
               WHERE started_at >= date_trunc('month', $3::timestamptz)
                 AND started_at < date_trunc('month', $3::timestamptz) + interval '1 month'
             ), 0) AS monthly_cost
             FROM run_engine_budgets`,
          [input.userId, input.projectId, startedAt]
        );
        const userActive = safeInteger(
          counts.rows[0]?.user_active ?? -1,
          "active user Run count"
        );
        const projectActive = safeInteger(
          counts.rows[0]?.project_active ?? -1,
          "active project Run count"
        );
        const monthlyCost = safeInteger(
          counts.rows[0]?.monthly_cost ?? -1,
          "team monthly cost"
        );
        return monthlyCost >= teamMonthlyMaxMicrousd
          ? {
              allowed: false,
              reason: "team_monthly_cost_limit",
              spentUsd: microusdToUsd(monthlyCost),
              limitUsd: options.limits.teamMonthlyMaxUsd
            }
          : userActive >= options.limits.maxActiveRunsPerUser
          ? {
              allowed: false,
              reason: "user_concurrency_limit",
              activeRuns: userActive,
              limit: options.limits.maxActiveRunsPerUser
            }
          : {
              allowed: false,
              reason: "project_concurrency_limit",
              activeRuns: projectActive,
              limit: options.limits.maxActiveRunsPerProject
            };
      }
      const persisted = await get(input.runId);
      if (
        !persisted ||
        persisted.projectId !== input.projectId ||
        persisted.userId !== input.userId ||
        persisted.maxTotalTokens !== options.limits.maxTotalTokens ||
        persisted.maxCostUsd !== options.limits.maxCostUsd ||
        persisted.modelId !== options.pricing.modelId ||
        persisted.pricingVersion !== options.pricing.version
      ) {
        throw new Error("Run budget identity changed after persistence");
      }
      return { allowed: true, snapshot: persisted };
    },

    async recordModelUsage(input) {
      validateIdentifier(input.runId, "Run ID");
      validateTokenCount(input.inputTokens, "Input token count");
      validateTokenCount(input.outputTokens, "Output token count");
      const costMicrousd = Math.ceil(
        input.inputTokens * options.pricing.inputUsdPerMillion +
          input.outputTokens * options.pricing.outputUsdPerMillion
      );
      const result = await database.query<RunBudgetRow>(
        `UPDATE run_engine_budgets
            SET input_tokens = input_tokens + $2::bigint,
                output_tokens = output_tokens + $3::bigint,
                cost_microusd = cost_microusd + $4::bigint
          WHERE run_id = $1 AND finished_at IS NULL
          RETURNING *`,
        [input.runId, input.inputTokens, input.outputTokens, costMicrousd]
      );
      if (!result.rows[0]) {
        throw new Error("Run budget is not active");
      }
      const snapshot = await get(input.runId);
      if (!snapshot) {
        throw new Error("Run budget disappeared after usage persistence");
      }
      return decide(snapshot);
    },

    async recordToolCall(runId) {
      validateIdentifier(runId, "Run ID");
      const result = await database.query<RunBudgetRow>(
        `UPDATE run_engine_budgets
            SET tool_calls = tool_calls + 1
          WHERE run_id = $1 AND finished_at IS NULL
          RETURNING *`,
        [runId]
      );
      if (!result.rows[0]) {
        throw new Error("Run budget is not active");
      }
      const snapshot = await get(runId);
      if (!snapshot) {
        throw new Error("Run budget disappeared after tool-count persistence");
      }
      return decide(snapshot);
    },

    async check(runId) {
      const snapshot = await get(runId);
      if (!snapshot || !snapshot.active) {
        throw new Error("Run budget is not active");
      }
      return decide(snapshot);
    },

    async close(runId) {
      validateIdentifier(runId, "Run ID");
      await database.query(
        `UPDATE run_engine_budgets
            SET finished_at = COALESCE(finished_at, $2::timestamptz)
          WHERE run_id = $1`,
        [runId, requireNow(now)]
      );
    },

    get
  };
}

interface RunBudgetRow extends Record<string, unknown> {
  run_id: string;
  project_id: string;
  user_id: string;
  input_tokens: string | number;
  output_tokens: string | number;
  cost_microusd: string | number;
  tool_calls: string | number;
  max_total_tokens: string | number;
  warning_cost_microusd: string | number;
  max_cost_microusd: string | number;
  max_wall_time_ms: string | number;
  max_tool_calls: string | number;
  team_monthly_warning_microusd: string | number;
  team_monthly_max_microusd: string | number;
  team_monthly_cost: string | number;
  model_id: string;
  pricing_version: string;
  started_at: string | Date;
  finished_at: string | Date | null;
}

function mapSnapshot(row: RunBudgetRow, observedAt: string): RunBudgetSnapshot {
  const inputTokens = safeInteger(row.input_tokens, "input tokens");
  const outputTokens = safeInteger(row.output_tokens, "output tokens");
  const startedAt = new Date(row.started_at).getTime();
  const snapshot = {
    runId: row.run_id,
    projectId: row.project_id,
    userId: row.user_id,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: microusdToUsd(safeInteger(row.cost_microusd, "cost")),
    toolCalls: safeInteger(row.tool_calls, "tool calls"),
    elapsedMs: Math.max(0, Date.parse(observedAt) - startedAt),
    maxTotalTokens: safeInteger(row.max_total_tokens, "token limit"),
    warningCostUsd: microusdToUsd(
      safeInteger(row.warning_cost_microusd, "cost warning")
    ),
    maxCostUsd: microusdToUsd(
      safeInteger(row.max_cost_microusd, "cost limit")
    ),
    maxWallTimeMs: safeInteger(row.max_wall_time_ms, "wall-time limit"),
    maxToolCalls: safeInteger(row.max_tool_calls, "tool-call limit"),
    teamMonthlyCostUsd: microusdToUsd(
      safeInteger(row.team_monthly_cost, "team monthly cost")
    ),
    teamMonthlyWarningUsd: microusdToUsd(
      safeInteger(
        row.team_monthly_warning_microusd,
        "team monthly cost warning"
      )
    ),
    teamMonthlyMaxUsd: microusdToUsd(
      safeInteger(row.team_monthly_max_microusd, "team monthly cost limit")
    ),
    modelId: row.model_id,
    pricingVersion: row.pricing_version,
    active: row.finished_at === null
  };
  return { ...snapshot, warnings: warningsFor(snapshot) };
}

function warningsFor(
  snapshot: Omit<RunBudgetSnapshot, "warnings">
): RunBudgetWarning[] {
  const warnings: RunBudgetWarning[] = [];
  if (snapshot.totalTokens >= snapshot.maxTotalTokens * 0.8) {
    warnings.push("token_warning");
  }
  if (snapshot.costUsd >= snapshot.warningCostUsd) {
    warnings.push("cost_warning");
  }
  if (snapshot.elapsedMs >= snapshot.maxWallTimeMs * 0.8) {
    warnings.push("wall_time_warning");
  }
  if (snapshot.toolCalls >= snapshot.maxToolCalls * 0.8) {
    warnings.push("tool_call_warning");
  }
  if (snapshot.teamMonthlyCostUsd >= snapshot.teamMonthlyWarningUsd) {
    warnings.push("team_monthly_cost_warning");
  }
  return warnings;
}

function decide(snapshot: RunBudgetSnapshot): RunBudgetDecision {
  if (snapshot.totalTokens > snapshot.maxTotalTokens) {
    return { allowed: false, reason: "token_limit", snapshot };
  }
  if (snapshot.costUsd > snapshot.maxCostUsd) {
    return { allowed: false, reason: "cost_limit", snapshot };
  }
  if (snapshot.teamMonthlyCostUsd > snapshot.teamMonthlyMaxUsd) {
    return { allowed: false, reason: "team_monthly_cost_limit", snapshot };
  }
  if (snapshot.elapsedMs > snapshot.maxWallTimeMs) {
    return { allowed: false, reason: "wall_time_limit", snapshot };
  }
  if (snapshot.toolCalls > snapshot.maxToolCalls) {
    return { allowed: false, reason: "tool_call_limit", snapshot };
  }
  return { allowed: true, snapshot };
}

function validateLimits(limits: RunBudgetLimits): void {
  for (const [label, value] of [
    ["maxTotalTokens", limits.maxTotalTokens],
    ["maxWallTimeMs", limits.maxWallTimeMs],
    ["maxToolCalls", limits.maxToolCalls],
    ["maxActiveRunsPerUser", limits.maxActiveRunsPerUser],
    ["maxActiveRunsPerProject", limits.maxActiveRunsPerProject]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${label} must be a positive integer`);
    }
  }
  for (const [label, value] of [
    ["warningCostUsd", limits.warningCostUsd],
    ["maxCostUsd", limits.maxCostUsd],
    ["teamMonthlyWarningUsd", limits.teamMonthlyWarningUsd],
    ["teamMonthlyMaxUsd", limits.teamMonthlyMaxUsd]
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${label} must be a non-negative finite amount`);
    }
  }
  if (
    limits.maxCostUsd <= 0 ||
    limits.warningCostUsd > limits.maxCostUsd ||
    limits.teamMonthlyMaxUsd <= 0 ||
    limits.teamMonthlyWarningUsd > limits.teamMonthlyMaxUsd
  ) {
    throw new Error("Run budget warning thresholds must not exceed hard limits");
  }
}

function validatePricing(pricing: RunModelPricing): void {
  validateIdentifier(pricing.modelId, "Model ID");
  validateIdentifier(pricing.version, "Pricing version");
  if (
    !Number.isFinite(pricing.inputUsdPerMillion) ||
    pricing.inputUsdPerMillion < 0 ||
    !Number.isFinite(pricing.outputUsdPerMillion) ||
    pricing.outputUsdPerMillion < 0
  ) {
    throw new Error("Model pricing must contain non-negative finite rates");
  }
}

function validateIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_.:@/-]{1,256}$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function validateTokenCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function safeInteger(value: string | number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`PostgreSQL returned invalid ${label}`);
  }
  return parsed;
}

function usdToMicrousd(value: number): number {
  return Math.ceil(value * 1_000_000);
}

function microusdToUsd(value: number): number {
  return value / 1_000_000;
}

function requireNow(now: () => string): string {
  const value = now();
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("Run budget clock must return an ISO timestamp");
  }
  return value;
}
