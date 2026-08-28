# Phase 2 Quota and Monitoring Audit

Updated: 2026-08-28

## Closed quota controls

- A PostgreSQL Run budget is opened before work starts and stores immutable model
  and pricing-version identity with Run/user/project ownership.
- Every provider request atomically reserves its maximum input/output token and
  cost envelope before network I/O. Valid usage settles the exact reservation;
  missing or unreadable usage forfeits the full envelope, and recovery reconciles
  reservations left active by a crashed Worker.
- Per-Run hard stops cover total tokens, cost, wall-clock time, tool calls, and
  three classified model retries. The retry counter is persisted before replay,
  so restart, resume, or Worker replacement cannot reset it.
- Active-Run admission is atomic for user and project concurrency. Team monthly
  admission and request reservation include active exposure, preventing parallel
  requests from oversubscribing the configured hard limit.
- Provider usage above a reservation is still charged before the request fails
  closed; close/cancellation races settle an active reservation exactly once.

## Monitoring surface

Authenticated Run reads expose current input/output/total tokens, Run and team
cost, elapsed wall time, tool calls, model retries, their hard limits, model id,
and pricing version. Stable 80-percent warning labels are rendered by the Web
quota card without reflecting provider-controlled content. Retry telemetry uses
only Run id, protocol, retry count, failure category, and outcome.

Deployment policy is configured through `LECODING_MODEL_MAX_INPUT_TOKENS`,
`LECODING_MODEL_MAX_OUTPUT_TOKENS`, the `LECODING_RUN_*` limits (including
`LECODING_RUN_MAX_MODEL_RETRIES`), user/project concurrency limits, and team
monthly warning/hard limits. `.env.local` remains ignored; `.env.example`
documents non-secret defaults.

## Verification evidence

- Focused quota/retry/Worker/Web tests: 63/63 passed.
- Workspace typecheck: 12/12 tasks passed.
- Repository suite: 327 passed and three skipped. Five HTTP cases could not bind
  loopback inside the workspace sandbox and passed 8/8 in the permitted rerun.

## Remaining monitoring work

This audit closes quota enforcement and its live Run projection. The wider V3
observability inventory remains open: per-tool failure rate and duration, Run
state dwell time, approval latency/rejection rate, worktree cleanup residue,
verification failure classification, and aggregated steer/cancel/keep/discard
rates still need durable records and an operational export surface.
