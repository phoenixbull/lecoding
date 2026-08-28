import type { PostgresExecutor } from "./postgres-run-lease.js";

/** Immutable limits copied into each Run so administrator changes are non-retroactive. */
export interface RunBudgetLimits {
  maxTotalTokens: number;
  warningCostUsd: number;
  maxCostUsd: number;
  maxWallTimeMs: number;
  maxToolCalls: number;
  /** Defaults to the V3 limit of three for older composition callers. */
  maxModelRetries?: number;
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
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: number;
  toolCalls: number;
  modelRetries: number;
  elapsedMs: number;
  maxTotalTokens: number;
  warningCostUsd: number;
  maxCostUsd: number;
  maxWallTimeMs: number;
  maxToolCalls: number;
  maxModelRetries: number;
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
  | "retry_warning"
  | "team_monthly_cost_warning";

/** Stable hard-limit categories suitable for Run failure and metrics labels. */
export type RunBudgetLimitReason =
  | "token_limit"
  | "cost_limit"
  | "wall_time_limit"
  | "tool_call_limit"
  | "retry_limit"
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
  /** Atomically reserves the maximum provider exposure before network I/O. */
  reserveModelRequest(input: {
    runId: string;
    requestId: string;
    maxInputTokens: number;
    maxOutputTokens: number;
  }): Promise<RunBudgetDecision>;
  /** Replaces one active reservation with validated provider usage exactly once. */
  settleModelRequest(input: {
    runId: string;
    requestId: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  }): Promise<RunBudgetDecision>;
  /** Charges the full reservation when actual provider usage is unknowable. */
  forfeitModelRequest(input: {
    runId: string;
    requestId: string;
  }): Promise<RunBudgetDecision>;
  /** Charges any active reservation left by a crashed request before recovery. */
  reconcileModelRequests(runId: string): Promise<RunBudgetDecision>;
  recordToolCall(runId: string): Promise<RunBudgetDecision>;
  /** Counts one classified retryable model failure before another attempt. */
  recordModelRetry(runId: string): Promise<RunBudgetDecision>;
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
  cached_input_tokens bigint NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  cost_microusd bigint NOT NULL DEFAULT 0 CHECK (cost_microusd >= 0),
  tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  max_total_tokens bigint NOT NULL CHECK (max_total_tokens > 0),
  warning_cost_microusd bigint NOT NULL CHECK (warning_cost_microusd >= 0),
  max_cost_microusd bigint NOT NULL CHECK (max_cost_microusd > 0),
  max_wall_time_ms bigint NOT NULL CHECK (max_wall_time_ms > 0),
  max_tool_calls integer NOT NULL CHECK (max_tool_calls > 0),
  model_retries integer NOT NULL DEFAULT 0 CHECK (model_retries >= 0),
  max_model_retries integer NOT NULL DEFAULT 3 CHECK (max_model_retries >= 0),
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
const RUN_BUDGET_MODEL_RETRIES_MIGRATION_SQL = `ALTER TABLE run_engine_budgets
  ADD COLUMN IF NOT EXISTS model_retries integer NOT NULL DEFAULT 0
  CHECK (model_retries >= 0);`;
const RUN_BUDGET_MAX_MODEL_RETRIES_MIGRATION_SQL = `ALTER TABLE run_engine_budgets
  ADD COLUMN IF NOT EXISTS max_model_retries integer NOT NULL DEFAULT 3
  CHECK (max_model_retries >= 0);`;
const RUN_BUDGET_CACHED_INPUT_MIGRATION_SQL = `ALTER TABLE run_engine_budgets
  ADD COLUMN IF NOT EXISTS cached_input_tokens bigint NOT NULL DEFAULT 0
  CHECK (cached_input_tokens >= 0);`;

const RUN_MODEL_RESERVATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_engine_model_reservations (
  request_id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES run_engine_budgets(run_id) ON DELETE CASCADE,
  max_input_tokens bigint NOT NULL CHECK (max_input_tokens > 0),
  max_output_tokens bigint NOT NULL CHECK (max_output_tokens > 0),
  reserved_cost_microusd bigint NOT NULL CHECK (reserved_cost_microusd >= 0),
  status text NOT NULL CHECK (status IN ('active', 'settled', 'forfeited')),
  actual_input_tokens bigint CHECK (actual_input_tokens >= 0),
  actual_output_tokens bigint CHECK (actual_output_tokens >= 0),
  actual_cached_input_tokens bigint CHECK (actual_cached_input_tokens >= 0),
  created_at timestamptz NOT NULL,
  settled_at timestamptz
);
`;
const RUN_MODEL_RESERVATION_CACHED_INPUT_MIGRATION_SQL = `ALTER TABLE run_engine_model_reservations
  ADD COLUMN IF NOT EXISTS actual_cached_input_tokens bigint
  CHECK (actual_cached_input_tokens >= 0);`;
const RUN_MODEL_RESERVATION_ACTIVE_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS
  run_engine_model_reservations_one_active_run_idx
  ON run_engine_model_reservations(run_id) WHERE status = 'active';`;

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
  await database.query(RUN_BUDGET_MODEL_RETRIES_MIGRATION_SQL);
  await database.query(RUN_BUDGET_MAX_MODEL_RETRIES_MIGRATION_SQL);
  await database.query(RUN_BUDGET_CACHED_INPUT_MIGRATION_SQL);
  await database.query(RUN_MODEL_RESERVATION_SCHEMA_SQL);
  await database.query(RUN_MODEL_RESERVATION_CACHED_INPUT_MIGRATION_SQL);
  await database.query(RUN_MODEL_RESERVATION_ACTIVE_INDEX_SQL);
  const now = options.now ?? (() => new Date().toISOString());
  const warningCostMicrousd = usdToMicrousd(options.limits.warningCostUsd);
  const maxCostMicrousd = usdToMicrousd(options.limits.maxCostUsd);
  const teamMonthlyMaxMicrousd = usdToMicrousd(
    options.limits.teamMonthlyMaxUsd
  );
  const teamMonthlyWarningMicrousd = usdToMicrousd(
    options.limits.teamMonthlyWarningUsd
  );
  const maxModelRetries = options.limits.maxModelRetries ?? 3;
  if (!Number.isSafeInteger(maxModelRetries) || maxModelRetries < 0) {
    throw new Error("maxModelRetries must be a non-negative integer");
  }

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

  const manager: PostgresRunBudgetManager = {
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
             ), 0) + COALESCE((
               SELECT sum(reservation.reserved_cost_microusd)
                 FROM run_engine_model_reservations reservation
                 JOIN run_engine_budgets owner ON owner.run_id = reservation.run_id
                WHERE reservation.status = 'active'
                  AND owner.started_at >= date_trunc('month', $13::timestamptz)
                  AND owner.started_at < date_trunc('month', $13::timestamptz) + interval '1 month'
             ), 0) AS monthly_cost
             FROM run_engine_budgets, admission_lock
         ), inserted AS (
           INSERT INTO run_engine_budgets
             (run_id, project_id, user_id, max_total_tokens,
              warning_cost_microusd, max_cost_microusd, max_wall_time_ms,
              max_tool_calls, max_model_retries, team_monthly_warning_microusd,
              team_monthly_max_microusd, model_id, pricing_version, input_usd_per_million,
              output_usd_per_million, started_at)
           SELECT $1, $2, $3, $4::bigint, $5::bigint, $6::bigint, $7::bigint,
                  $8::integer, $18::integer, $17::bigint, $16::bigint,
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
          teamMonthlyWarningMicrousd,
          maxModelRetries
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
             ), 0) + COALESCE((
               SELECT sum(reservation.reserved_cost_microusd)
                 FROM run_engine_model_reservations reservation
                 JOIN run_engine_budgets owner ON owner.run_id = reservation.run_id
                WHERE reservation.status = 'active'
                  AND owner.started_at >= date_trunc('month', $3::timestamptz)
                  AND owner.started_at < date_trunc('month', $3::timestamptz) + interval '1 month'
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

    async reserveModelRequest(input) {
      validateIdentifier(input.runId, "Run ID");
      validateIdentifier(input.requestId, "Model request ID");
      validatePositiveTokenCount(input.maxInputTokens, "Maximum input token count");
      validatePositiveTokenCount(input.maxOutputTokens, "Maximum output token count");
      const reservedCostMicrousd = Math.ceil(
        input.maxInputTokens * options.pricing.inputUsdPerMillion +
          input.maxOutputTokens * options.pricing.outputUsdPerMillion
      );
      const createdAt = requireNow(now);
      const result = await database.query<ModelReservationRow>(
        `WITH admission_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(1279345491::bigint)
         ), budget AS MATERIALIZED (
           SELECT budget.*
             FROM run_engine_budgets budget, admission_lock
            WHERE budget.run_id = $1 AND budget.finished_at IS NULL
         ), team AS MATERIALIZED (
           SELECT COALESCE(sum(peer.cost_microusd), 0) AS actual_cost,
                  COALESCE((
                    SELECT sum(reservation.reserved_cost_microusd)
                      FROM run_engine_model_reservations reservation
                      JOIN run_engine_budgets owner ON owner.run_id = reservation.run_id
                     WHERE reservation.status = 'active'
                       AND owner.started_at >= date_trunc('month', $6::timestamptz)
                       AND owner.started_at < date_trunc('month', $6::timestamptz) + interval '1 month'
                  ), 0) AS reserved_cost
             FROM run_engine_budgets peer, admission_lock
            WHERE peer.started_at >= date_trunc('month', $6::timestamptz)
              AND peer.started_at < date_trunc('month', $6::timestamptz) + interval '1 month'
         )
         INSERT INTO run_engine_model_reservations
           (request_id, run_id, max_input_tokens, max_output_tokens,
            reserved_cost_microusd, status, created_at)
         SELECT $2, budget.run_id, $3::bigint, $4::bigint, $5::bigint,
                'active', $6::timestamptz
           FROM budget, team
          WHERE budget.input_tokens + budget.output_tokens + $3::bigint + $4::bigint
                  <= budget.max_total_tokens
            AND budget.cost_microusd + $5::bigint <= budget.max_cost_microusd
            AND team.actual_cost + team.reserved_cost + $5::bigint
                  <= budget.team_monthly_max_microusd
            AND NOT EXISTS (
              SELECT 1 FROM run_engine_model_reservations active
               WHERE active.run_id = budget.run_id AND active.status = 'active'
            )
         ON CONFLICT (request_id) DO NOTHING
         RETURNING *`,
        [
          input.runId,
          input.requestId,
          input.maxInputTokens,
          input.maxOutputTokens,
          reservedCostMicrousd,
          createdAt
        ]
      );
      const inserted = result.rows[0];
      if (!inserted) {
        const existing = await readReservation(database, input.requestId);
        if (existing) {
          if (
            existing.run_id !== input.runId ||
            safeInteger(existing.max_input_tokens, "reserved input tokens") !==
              input.maxInputTokens ||
            safeInteger(existing.max_output_tokens, "reserved output tokens") !==
              input.maxOutputTokens ||
            existing.status !== "active"
          ) {
            throw new Error("Model request reservation identity changed");
          }
          const snapshot = await requireActiveBudget(get, input.runId);
          return { allowed: true, snapshot };
        }
        const snapshot = await requireActiveBudget(get, input.runId);
        const current = decide(snapshot);
        if (!current.allowed) {
          return current;
        }
        if (
          snapshot.totalTokens + input.maxInputTokens + input.maxOutputTokens >
          snapshot.maxTotalTokens
        ) {
          return { allowed: false, reason: "token_limit", snapshot };
        }
        if (
          usdToMicrousd(snapshot.costUsd) + reservedCostMicrousd >
          usdToMicrousd(snapshot.maxCostUsd)
        ) {
          return { allowed: false, reason: "cost_limit", snapshot };
        }
        const activeTeamReservations = await sumActiveReservationCost(
          database,
          createdAt
        );
        if (
          usdToMicrousd(snapshot.teamMonthlyCostUsd) +
            activeTeamReservations +
            reservedCostMicrousd >
          usdToMicrousd(snapshot.teamMonthlyMaxUsd)
        ) {
          return {
            allowed: false,
            reason: "team_monthly_cost_limit",
            snapshot
          };
        }
        throw new Error("Run already has an active model request reservation");
      }
      const snapshot = await requireActiveBudget(get, input.runId);
      return { allowed: true, snapshot };
    },

    async settleModelRequest(input) {
      validateIdentifier(input.runId, "Run ID");
      validateIdentifier(input.requestId, "Model request ID");
      validateTokenCount(input.inputTokens, "Input token count");
      validateTokenCount(input.outputTokens, "Output token count");
      const cachedInputTokens = input.cachedInputTokens ?? 0;
      validateTokenCount(cachedInputTokens, "Cached input token count");
      if (cachedInputTokens > input.inputTokens) {
        throw new Error("Cached input tokens must be a subset of input tokens");
      }
      const costMicrousd = Math.ceil(
        input.inputTokens * options.pricing.inputUsdPerMillion +
          input.outputTokens * options.pricing.outputUsdPerMillion
      );
      const settledAt = requireNow(now);
      const result = await database.query<RunBudgetRow>(
        `WITH settled AS (
           UPDATE run_engine_model_reservations
              SET status = 'settled',
                  actual_input_tokens = $3::bigint,
                  actual_output_tokens = $4::bigint,
                  actual_cached_input_tokens = $5::bigint,
                  settled_at = $7::timestamptz
            WHERE request_id = $2 AND run_id = $1 AND status = 'active'
            RETURNING run_id
         )
         UPDATE run_engine_budgets budget
            SET input_tokens = input_tokens + $3::bigint,
                output_tokens = output_tokens + $4::bigint,
                cached_input_tokens = cached_input_tokens + $5::bigint,
                cost_microusd = cost_microusd + $6::bigint
           FROM settled
          WHERE budget.run_id = settled.run_id AND budget.finished_at IS NULL
         RETURNING budget.*`,
        [
          input.runId,
          input.requestId,
          input.inputTokens,
          input.outputTokens,
          cachedInputTokens,
          costMicrousd,
          settledAt
        ]
      );
      const existing = await readReservation(database, input.requestId);
      if (!result.rows[0]) {
        if (
          !existing ||
          existing.run_id !== input.runId ||
          existing.status !== "settled" ||
          safeInteger(existing.actual_input_tokens ?? -1, "settled input tokens") !==
            input.inputTokens ||
          safeInteger(existing.actual_output_tokens ?? -1, "settled output tokens") !==
            input.outputTokens ||
          safeInteger(
              existing.actual_cached_input_tokens ?? -1,
              "settled cached input tokens"
            ) !== cachedInputTokens
        ) {
          throw new Error("Model request reservation is not active");
        }
      }
      if (!existing || existing.run_id !== input.runId) {
        throw new Error("Model request reservation disappeared after settlement");
      }
      const snapshot = await get(input.runId);
      if (!snapshot) {
        throw new Error("Run budget disappeared after model settlement");
      }
      if (
        input.inputTokens >
          safeInteger(existing.max_input_tokens, "reserved input tokens") ||
        input.outputTokens >
          safeInteger(existing.max_output_tokens, "reserved output tokens")
      ) {
        return { allowed: false, reason: "token_limit", snapshot };
      }
      return decide(snapshot);
    },

    async forfeitModelRequest(input) {
      validateIdentifier(input.runId, "Run ID");
      validateIdentifier(input.requestId, "Model request ID");
      const settledAt = requireNow(now);
      const result = await database.query<RunBudgetRow>(
        `WITH forfeited AS (
           UPDATE run_engine_model_reservations
              SET status = 'forfeited', settled_at = $3::timestamptz
            WHERE request_id = $2 AND run_id = $1 AND status = 'active'
            RETURNING run_id, max_input_tokens, max_output_tokens,
                      reserved_cost_microusd
         )
         UPDATE run_engine_budgets budget
            SET input_tokens = input_tokens + forfeited.max_input_tokens,
                output_tokens = output_tokens + forfeited.max_output_tokens,
                cost_microusd = cost_microusd + forfeited.reserved_cost_microusd
           FROM forfeited
          WHERE budget.run_id = forfeited.run_id AND budget.finished_at IS NULL
         RETURNING budget.*`,
        [input.runId, input.requestId, settledAt]
      );
      if (!result.rows[0]) {
        const existing = await readReservation(database, input.requestId);
        if (
          !existing ||
          existing.run_id !== input.runId ||
          (existing.status !== "forfeited" && existing.status !== "settled")
        ) {
          throw new Error("Model request reservation is not active");
        }
      }
      const snapshot = await get(input.runId);
      if (!snapshot) {
        throw new Error("Run budget disappeared after model request forfeiture");
      }
      return decide(snapshot);
    },

    async reconcileModelRequests(runId) {
      validateIdentifier(runId, "Run ID");
      const active = await database.query<{ request_id: string }>(
        `SELECT request_id
           FROM run_engine_model_reservations
          WHERE run_id = $1 AND status = 'active'`,
        [runId]
      );
      const requestId = active.rows[0]?.request_id;
      if (requestId) {
        return manager.forfeitModelRequest({ runId, requestId });
      }
      return manager.check(runId);
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

    async recordModelRetry(runId) {
      validateIdentifier(runId, "Run ID");
      const result = await database.query<RunBudgetRow>(
        `UPDATE run_engine_budgets
            SET model_retries = model_retries + 1
          WHERE run_id = $1 AND finished_at IS NULL
          RETURNING *`,
        [runId]
      );
      if (!result.rows[0]) {
        throw new Error("Run budget is not active");
      }
      const snapshot = await get(runId);
      if (!snapshot) {
        throw new Error("Run budget disappeared after retry persistence");
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
        `WITH forfeited AS (
           UPDATE run_engine_model_reservations
              SET status = 'forfeited', settled_at = $2::timestamptz
            WHERE run_id = $1 AND status = 'active'
            RETURNING max_input_tokens, max_output_tokens,
                      reserved_cost_microusd
         )
         UPDATE run_engine_budgets
            SET input_tokens = input_tokens + COALESCE(
                  (SELECT sum(max_input_tokens) FROM forfeited), 0
                ),
                output_tokens = output_tokens + COALESCE(
                  (SELECT sum(max_output_tokens) FROM forfeited), 0
                ),
                cost_microusd = cost_microusd + COALESCE(
                  (SELECT sum(reserved_cost_microusd) FROM forfeited), 0
                ),
                finished_at = COALESCE(finished_at, $2::timestamptz)
          WHERE run_id = $1`,
        [runId, requireNow(now)]
      );
    },

    get
  };
  return manager;
}

interface RunBudgetRow extends Record<string, unknown> {
  run_id: string;
  project_id: string;
  user_id: string;
  input_tokens: string | number;
  output_tokens: string | number;
  cached_input_tokens: string | number;
  cost_microusd: string | number;
  tool_calls: string | number;
  model_retries: string | number;
  max_total_tokens: string | number;
  warning_cost_microusd: string | number;
  max_cost_microusd: string | number;
  max_wall_time_ms: string | number;
  max_tool_calls: string | number;
  max_model_retries: string | number;
  team_monthly_warning_microusd: string | number;
  team_monthly_max_microusd: string | number;
  team_monthly_cost: string | number;
  model_id: string;
  pricing_version: string;
  started_at: string | Date;
  finished_at: string | Date | null;
}

interface ModelReservationRow extends Record<string, unknown> {
  request_id: string;
  run_id: string;
  max_input_tokens: string | number;
  max_output_tokens: string | number;
  reserved_cost_microusd: string | number;
  status: "active" | "settled" | "forfeited";
  actual_input_tokens: string | number | null;
  actual_output_tokens: string | number | null;
  actual_cached_input_tokens: string | number | null;
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
    cachedInputTokens: safeInteger(row.cached_input_tokens, "cached input tokens"),
    totalTokens: inputTokens + outputTokens,
    costUsd: microusdToUsd(safeInteger(row.cost_microusd, "cost")),
    toolCalls: safeInteger(row.tool_calls, "tool calls"),
    modelRetries: safeInteger(row.model_retries, "model retries"),
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
    maxModelRetries: safeInteger(row.max_model_retries, "model retry limit"),
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
  if (
    snapshot.maxModelRetries > 0 &&
    snapshot.modelRetries >= snapshot.maxModelRetries * 0.8
  ) {
    warnings.push("retry_warning");
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
  if (snapshot.modelRetries > snapshot.maxModelRetries) {
    return { allowed: false, reason: "retry_limit", snapshot };
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

function validatePositiveTokenCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

async function readReservation(
  database: PostgresExecutor,
  requestId: string
): Promise<ModelReservationRow | undefined> {
  const result = await database.query<ModelReservationRow>(
    `SELECT * FROM run_engine_model_reservations WHERE request_id = $1`,
    [requestId]
  );
  return result.rows[0];
}

async function requireActiveBudget(
  get: (runId: string) => Promise<RunBudgetSnapshot | undefined>,
  runId: string
): Promise<RunBudgetSnapshot> {
  const snapshot = await get(runId);
  if (!snapshot?.active) {
    throw new Error("Run budget is not active");
  }
  return snapshot;
}

async function sumActiveReservationCost(
  database: PostgresExecutor,
  observedAt: string
): Promise<number> {
  const result = await database.query<{ reserved_cost: string | number }>(
    `SELECT COALESCE(sum(reservation.reserved_cost_microusd), 0) AS reserved_cost
       FROM run_engine_model_reservations reservation
       JOIN run_engine_budgets budget ON budget.run_id = reservation.run_id
      WHERE reservation.status = 'active'
        AND budget.started_at >= date_trunc('month', $1::timestamptz)
        AND budget.started_at < date_trunc('month', $1::timestamptz) + interval '1 month'`,
    [observedAt]
  );
  return safeInteger(result.rows[0]?.reserved_cost ?? -1, "reserved team cost");
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
