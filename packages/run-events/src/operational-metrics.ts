import type {
  JsonValue,
  RunFailure,
  RunOperationalMetrics,
  RunStatus
} from "@lecoding/contracts";
import type { PostgresExecutor } from "./postgres.js";

/** Authenticated callers consume metrics through this content-free read seam. */
export interface RunOperationalMetricsReader {
  read(runId: string): Promise<RunOperationalMetrics | undefined>;
}

/** Durable result-action seam used only after worktree resolution succeeds. */
export interface RunOperationalActionRecorder {
  recordResult(runId: string, outcome: "keep" | "discard"): Promise<void>;
  /** Records a content-free residual-risk signal when result resolution fails. */
  recordResultFailure(runId: string, outcome: "keep" | "discard"): Promise<void>;
}

const OPERATIONAL_ACTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_engine_operational_actions (
  run_id text NOT NULL,
  action_type text NOT NULL CHECK (
    action_type IN ('keep', 'discard', 'keep_failed', 'discard_failed')
  ),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, action_type)
);`;

/** Persists idempotent user result decisions without task, path, or output content. */
export async function createPostgresRunOperationalActionRecorder(
  database: PostgresExecutor,
  options: { now?: () => string } = {}
): Promise<RunOperationalActionRecorder> {
  await database.query(OPERATIONAL_ACTION_SCHEMA_SQL);
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async recordResult(runId, outcome) {
      if (runId.trim() === "" || runId.length > 128) {
        throw new Error("Run ID is invalid");
      }
      const occurredAt = new Date(requireTimestamp(now())).toISOString();
      await database.query(
        `INSERT INTO run_engine_operational_actions
           (run_id, action_type, occurred_at)
         VALUES ($1, $2, $3::timestamptz)
         ON CONFLICT (run_id, action_type) DO NOTHING`,
        [runId, outcome, occurredAt]
      );
    },
    async recordResultFailure(runId, outcome) {
      if (runId.trim() === "" || runId.length > 128) {
        throw new Error("Run ID is invalid");
      }
      const occurredAt = new Date(requireTimestamp(now())).toISOString();
      await database.query(
        `INSERT INTO run_engine_operational_actions
           (run_id, action_type, occurred_at)
         VALUES ($1, $2, $3::timestamptz)
         ON CONFLICT (run_id, action_type) DO NOTHING`,
        [runId, `${outcome}_failed`, occurredAt]
      );
    }
  };
}

/** Builds per-Run operational metrics from the authoritative durable event order. */
export function createPostgresRunOperationalMetricsReader(
  database: PostgresExecutor,
  options: { now?: () => string } = {}
): RunOperationalMetricsReader {
  // Live-state dwell is measured at read time; tests may inject a deterministic clock.
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async read(runId) {
      if (runId.trim() === "" || runId.length > 128) {
        throw new Error("Run ID is invalid");
      }
      const result = await database.query<OperationalEventRow>(
        `SELECT event_type,
                to_char(occurred_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
                data
           FROM run_events
          WHERE run_id = $1
          ORDER BY sequence ASC`,
        [runId]
      );
      if (result.rows.length === 0) {
        return undefined;
      }
      const approvalResult = await database.query<ApprovalAggregateRow>(
        `SELECT
           count(*) AS requested,
           count(*) FILTER (WHERE status = 'decided') AS decided,
           count(*) FILTER (WHERE status = 'decided' AND decision = 'deny') AS denied,
           coalesce(sum(greatest(
             0,
             extract(epoch FROM (decided_at - created_at)) * 1000
           )) FILTER (WHERE status = 'decided'), 0) AS total_wait_ms
         FROM run_engine_approvals
         WHERE run_id = $1`,
        [runId]
      );
      const actionResult = await database.query<ActionAggregateRow>(
        `SELECT
           count(*) FILTER (WHERE action_type = 'keep') AS keeps,
           count(*) FILTER (WHERE action_type = 'discard') AS discards,
           -- Retain failures are operationally distinct; only failed discard
           -- attempts indicate a worktree cleanup residue.
           count(*) FILTER (WHERE action_type = 'discard_failed') AS cleanup_failures,
           to_char(max(occurred_at) AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_action_at,
           CASE
             WHEN count(*) FILTER (WHERE action_type = 'discard') > 0 THEN 'discard'
             WHEN count(*) FILTER (WHERE action_type = 'keep') > 0 THEN 'keep'
             ELSE NULL
           END AS latest_action
         FROM run_engine_operational_actions
         WHERE run_id = $1`,
        [runId]
      );
      const latestEventAt = result.rows.at(-1)!.occurred_at;
      // Observation never precedes durable history if host and database clocks skew.
      const observedAt = new Date(
        Math.max(requireTimestamp(now()), requireTimestamp(latestEventAt))
      ).toISOString();
      const derived = deriveOperationalMetrics(runId, result.rows, observedAt);
      const actions = mapActionMetrics(actionResult.rows[0]);
      return {
        ...derived,
        observedAt:
          actions.lastActionAt && actions.lastActionAt > derived.observedAt
            ? actions.lastActionAt
            : derived.observedAt,
        approvals: mapApprovalMetrics(approvalResult.rows[0]),
        userActions: {
          ...derived.userActions,
          keeps: actions.keeps,
          discards: actions.discards
        },
        worktree: {
          created: derived.worktree.created,
          disposition: actions.disposition,
          cleanupFailures: actions.cleanupFailures
        }
      };
    }
  };
}

interface OperationalEventRow extends Record<string, unknown> {
  event_type: string;
  occurred_at: string;
  data: JsonValue;
}

interface ApprovalAggregateRow extends Record<string, unknown> {
  requested: string | number;
  decided: string | number;
  denied: string | number;
  total_wait_ms: string | number;
}

interface ActionAggregateRow extends Record<string, unknown> {
  keeps: string | number;
  discards: string | number;
  last_action_at: string | null;
  latest_action: string | null;
  cleanup_failures: string | number;
}

const RUN_STATUSES = new Set<RunStatus>([
  "queued",
  "preparing",
  "running",
  "waiting_approval",
  "waiting_user",
  "environment_offline",
  "verifying",
  "succeeded",
  "failed",
  "cancelling",
  "cancelled"
]);

/** Reduces only stable enum/numeric fields; event text never enters the projection. */
function deriveOperationalMetrics(
  runId: string,
  rows: OperationalEventRow[],
  observedAt: string
): RunOperationalMetrics {
  const statusDwellMs: Partial<Record<RunStatus, number>> = {};
  const toolStarts = new Map<string, number>();
  let activeStatus: RunStatus | undefined;
  let activeStatusAt: number | undefined;
  let total = 0;
  let failed = 0;
  let totalDurationMs = 0;
  let outputTruncated = 0;
  let steers = 0;
  let answers = 0;
  let cancellations = 0;
  let worktreeCreated = false;
  const verification = { attempts: 0, passed: 0, failed: 0, inconclusive: 0 };
  const failures: Partial<Record<RunFailure["code"], number>> = {};

  for (const row of rows) {
    const occurredAt = requireTimestamp(row.occurred_at);
    const data = asRecord(row.data);
    if (row.event_type === "status_changed" && isRunStatus(data?.status)) {
      if (activeStatus !== undefined && activeStatusAt !== undefined) {
        statusDwellMs[activeStatus] =
          (statusDwellMs[activeStatus] ?? 0) + Math.max(0, occurredAt - activeStatusAt);
      }
      activeStatus = data.status;
      activeStatusAt = occurredAt;
      if (data.status === "preparing") {
        worktreeCreated = true;
      }
      if (data.status === "cancelled") {
        cancellations += 1;
      }
    } else if (row.event_type === "tool_started" && typeof data?.callId === "string") {
      toolStarts.set(data.callId, occurredAt);
    } else if (
      row.event_type === "tool_completed" &&
      typeof data?.callId === "string"
    ) {
      total += 1;
      if (typeof data.exitCode === "number" && data.exitCode !== 0) {
        failed += 1;
      }
      if (data.outputTruncated === true) {
        outputTruncated += 1;
      }
      const startedAt = toolStarts.get(data.callId);
      if (startedAt !== undefined) {
        totalDurationMs += Math.max(0, occurredAt - startedAt);
        toolStarts.delete(data.callId);
      }
    } else if (row.event_type === "user_message_submitted") {
      if (data?.mode === "steer") steers += 1;
      if (data?.mode === "answer") answers += 1;
    } else if (
      row.event_type === "verification_completed" &&
      isVerificationOutcome(data?.outcome)
    ) {
      verification.attempts += 1;
      verification[data.outcome] += 1;
    } else if (row.event_type === "run_failed" && isRunFailureCode(data?.code)) {
      failures[data.code] = (failures[data.code] ?? 0) + 1;
    }
  }

  if (
    activeStatus !== undefined &&
    activeStatusAt !== undefined &&
    !isTerminalRunStatus(activeStatus)
  ) {
    statusDwellMs[activeStatus] =
      (statusDwellMs[activeStatus] ?? 0) +
      Math.max(0, requireTimestamp(observedAt) - activeStatusAt);
  }

  return {
    runId,
    observedAt,
    statusDwellMs,
    tools: { total, failed, totalDurationMs, outputTruncated },
    // The public factory appends the independently persisted approval aggregate.
    approvals: { requested: 0, decided: 0, denied: 0, totalWaitMs: 0 },
    userActions: { steers, answers, cancellations, keeps: 0, discards: 0 },
    worktree: { created: worktreeCreated, disposition: "unresolved", cleanupFailures: 0 },
    verification,
    failures
  };
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function isVerificationOutcome(
  value: JsonValue | undefined
): value is "passed" | "failed" | "inconclusive" {
  return value === "passed" || value === "failed" || value === "inconclusive";
}

function isRunFailureCode(value: JsonValue | undefined): value is RunFailure["code"] {
  return (
    value === "agent_loop_failed" ||
    value === "policy_denied" ||
    value === "tool_call_outcome_unknown" ||
    value === "budget_exhausted"
  );
}

function mapActionMetrics(row: ActionAggregateRow | undefined) {
  if (!row) {
    throw new Error("PostgreSQL did not return result-action metrics");
  }
  const latest = row.latest_action;
  return {
    keeps: requireNonNegativeNumber(row.keeps, "keep decisions"),
    discards: requireNonNegativeNumber(row.discards, "discard decisions"),
    cleanupFailures: requireNonNegativeNumber(
      row.cleanup_failures,
      "worktree cleanup failures"
    ),
    lastActionAt: row.last_action_at ?? undefined,
    disposition:
      latest === "keep"
        ? ("retained" as const)
        : latest === "discard"
          ? ("discarded" as const)
          : ("unresolved" as const)
  };
}

function mapApprovalMetrics(row: ApprovalAggregateRow | undefined) {
  if (!row) {
    throw new Error("PostgreSQL did not return approval metrics");
  }
  return {
    requested: requireNonNegativeNumber(row.requested, "approval requests"),
    decided: requireNonNegativeNumber(row.decided, "approval decisions"),
    denied: requireNonNegativeNumber(row.denied, "approval denials"),
    totalWaitMs: requireNonNegativeNumber(row.total_wait_ms, "approval wait")
  };
}

function requireNonNegativeNumber(value: string | number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`PostgreSQL returned invalid ${label}`);
  }
  return parsed;
}

function asRecord(value: JsonValue): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function isRunStatus(value: JsonValue | undefined): value is RunStatus {
  return typeof value === "string" && RUN_STATUSES.has(value as RunStatus);
}

function requireTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Run event timestamp is invalid");
  }
  return timestamp;
}
