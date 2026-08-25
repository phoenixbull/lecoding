# Phase 0 Status

Updated: 2026-08-21

## Evidence completed

- pnpm workspace, Turborepo, TypeScript strict mode, and Vitest configured.
- RunEngine, RunEnvironment, Verifier, PolicyEngine, and Workspace interfaces created.
- Run success is gated by a VerificationReport.
- Docker socket hard deny is enforced independently of approval mode.
- A real temporary Git repository test proves worktree isolation.
- Client SDK uses the versioned `/api/v1` Run endpoint.
- RunEvent envelopes reject unsupported protocol versions.
- A FakeModel tracer executes a structured command tool call before verification.
- Manual Runs pause with a client-readable approval request and resume after one-time approval.
- A rejected tool call is returned to the model without execution.
- Agent-loop failures become queryable failed Runs instead of remaining active.
- Environment errors during command execution are auto-recovered: when `perform` throws, the run is moved to `environment_offline`, the local handle is released, and the next `resume()` re-prepares the environment and continues execution instead of marking the run as `agent_loop_failed`.
- Environment errors during environment preparation are auto-recovered the same way: when `prepare` throws, the run is moved to `environment_offline` (without needing to dispose since no handle has been registered yet), so a worker reporting image-pull failures or unreachable workspaces parks the run for re-preparation instead of throwing back to the scheduler.
- `LeaseHeartbeat` seam keeps the lease alive across long awaits: `prepare` (which can spend minutes pulling images) is wrapped in `heartbeat.withHeartbeat(token, leaseMilliseconds/2, fn)`, so a worker holding the lease auto-renews on a half-interval cadence and is not preempted by another worker that picked up an expired lease from the same run id.
- `LeaseHeartbeat` covers the verification path too: `environment.inspect` and `verifier.verify` (both potentially long-running remote calls) are wrapped in the same heartbeat wrapper, so the lease survives a verification that takes longer than a single lease period. `dispose` is intentionally excluded so cancel/recover commands can drain the environment quickly.
- `LeaseHeartbeat` actively invalidates the lease when renewal fails: the wrapper calls `lease.invalidate` as soon as a renewal returns false, so a worker that lost its network path to the lease backend (PG, etc.) immediately releases the lease instead of waiting for natural expiry. This gives other workers a takeover path that does not depend on the dying worker keeping a tick.
- PostgreSQL-backed `RunLease` with generation-based optimistic locking: `createPostgresRunLease` uses a `run_engine_leases` table and a monotonically increasing `generation` column. `acquire` atomically inserts-or-updates only when the existing lease has expired, `renew` requires both `owner_id` and `generation` to match, and `invalidate` bumps `generation` so a stale token can never renew again — solving the cross-process invalidate-delay problem without depending on wall-clock expiry. Exercised by an embedded PGlite integration test (7 cases covering acquire contention, renew-by-owner, invalidation, stale-token renew, and release).
- Cross-worker cancel via PG LISTEN/NOTIFY with a heartbeat-based loss fallback: `createPostgresRunCancelBus` backgrounds a `LISTEN run_engine_cancel` session, `publish` fires `pg_notify`, and the cancel path additionally marks the run `cancelled` in the shared store. If the NOTIFY broadcast is ever lost (session disconnect, cross-server isolation), `performWith`'s per-tick `tickCancellationFallback` reads the store and aborts the handle once the terminal state is visible, so cancel degrades from "broadcast" to "eventual-consistency store check" rather than being dropped. Failover reconnects with exponential backoff and re-registers the LISTEN. Covered by two complementary integration matrices with PGlite: (a) single-instance multi-session fanout (equivalent to many workers on one PG server), and (b) multi-instance isolation (real cross-server boundary where NOTIFY provably does not cross) proving the store+heartbeat path aborts a hung perform and disposes its environment.
- pg-boss-style recovery tracer bullet: `createIntervalRecoveryWorker` polls the `run_engine_leases` table on a cadence and calls `resumer.resume(runId)` for every expired lease, so a crashed worker's run is picked up by a live worker without manual intervention. Built on top of an `RunRecoveryWorker` seam (`start`/`stop`) that a real pg-boss adapter can plug into without changing RunEngine. Tested end-to-end with PGlite: worker A crashes mid-perform, its lease expires, worker B's recovery worker detects it, and the run finishes under B's drive.
- Run-scoped approval/rejection policy and durable continuation recovery: each Run can declare `deniedCommands` at start time; commands matching the list are denied before any global rule, so a Run can opt out of `curl`/`docker` even when `approvalMode` is `full_access`. Paired with a continuation-recovery guard at the top of `drive` that refuses to re-invoke the model when the Run is in `waiting_approval` — a worker that resumes a run left waiting for approval now leaves it waiting (the persisted `pendingApproval` is the continuation point), instead of restarting the model loop and producing a duplicate tool call.
- Docker runtime limits + cancellation PoC: `RunEnvironment.perform` accepts an `AbortSignal`, the `RunHandleRegistry` keeps an `AbortController` per registered handle, and the `cancel` command invokes `handles.abort(runId)` before its `cancelling` transition so a long-running `perform` is interrupted immediately rather than waiting for natural completion. The skeleton `createDockerRunEnvironment` wires runtime limits (`--memory`/`--cpus`/`--pids-limit`/`--network`) and an `execTimeoutMs` into `docker run`/`exec`/`kill`, and `FakeDockerRunEnvironment` simulates the OOM/cgroup-failure path so `perform` errors automatically transition the Run to `environment_offline`. Live docker tests are guarded by a `docker info` probe and currently skip because no daemon is reachable in the baseline environment.
- Runs waiting for approval can be cancelled and their environment discarded.
- Cancellation racing a pending model call keeps the Run cancelled: the driver loop re-checks state at the model-call boundary and never executes the cancelled tool call.
- Cancellation racing an in-flight command keeps the Run cancelled: RunStore saves are guarded by an optimistic version, stale writes fail with RunConflictError, and a superseded loop never overwrites the concurrent terminal state.
- RunEngine exposes a separated `start` / `resume` seam: `start` only enqueues a `queued` Run and returns; Worker callers drive execution by `resume(runId)`, which is idempotent across terminal states and re-takeover scenarios.
- EnvironmentHandle lives in a process-local RunHandleRegistry: persistence never stores runtime resources, so process restarts no longer hold zombie handles.
- `recover_environment` command transitions a run to `environment_offline`, disposes the registered environment, and releases the handle; the next `resume()` re-prepares the environment and continues execution so a worker can drop its environment without losing the run.
- `recover_environment` is a no-op for terminal or non-driver-startable runs: the gate keeps an already `succeeded`/`failed`/`cancelled` run from being pulled back to `environment_offline`, so a late recovery request can never resurrect a finished run or dispose its finished environment.
- Workers can trigger environment recovery internally without the user command interface: `RunResumer.recoverEnvironment(runId)` acquires the lease on its own and reuses the same `environment_offline` transition, so a worker-side fault self-check can drop a broken environment while its drive loop parks safely.
- `RunLease` seam prevents concurrent Worker takeover: every `resume()` and `command()` acquires a per-run lease through `acquire`/`renew`/`release`/`invalidate`; the drive loop renews the lease at each await boundary (model call and tool execution) so a worker that loses its lease stops driving and never overwrites a new owner's state.
- `RetryPolicy` seam queues `resume()` lease acquisition: when another worker holds the lease, `acquireLease` waits according to the injected policy (default 5s budget with exponential backoff capped at 200ms) instead of giving up immediately. `command()` does not retry because user-initiated commands need an immediate owner decision.
- Every state write is guarded at the `transition` boundary: a worker holding a lease token re-verifies it before persisting any status change, and a lost lease fails the write with `LeaseLostError` instead of silently skipping, so a superseded owner can never overwrite a new owner's state or mark the Run as `agent_loop_failed`.
- Tool-result writes are guarded the same way: `performWith` re-verifies the lease after the command finishes but before persisting its result, so a worker that loses its lease during command execution discards the observed result instead of polluting the next owner's model input.
- RunEvent V1 strictly validates every envelope field and JSON-safe payload data.
- The in-memory RunEventJournal assigns monotonic per-Run sequences and resumes after `Last-Event-ID`.
- RunEngine publishes ordered status events for Web and future PC clients.
- Client SDK opens fetch-based SSE streams with a resumable event cursor.
- PostgreSQL atomically allocates event sequences and inserts matching outbox records.
- Outbox workers use leased `SKIP LOCKED` claims and owner-only acknowledgements.
- The outbox dispatcher provides explicit at-least-once delivery and acknowledges only completed batches.
- The long-lived SSE handler replays backlog before ordered live events without a subscription race.
- SSE clients deduplicate repeated outbox deliveries by stable per-Run sequence.
- PostgreSQL behavior is exercised by an embedded PostgreSQL-compatible integration test.
- Type checking passes across all implemented packages.

## Current automated baseline

```text
Test files: 22 passed (2 docker PoC tests skipped when no daemon)
Tests:      86 passed, 2 skipped
Typecheck:  all implemented package tasks passed
```

## Pending Phase 0 evidence

- Docker runtime limits and cancellation PoC
- 20 golden tasks, with 5 representative tasks executed for baseline

## Environment note

Docker CLI 27.5.1 is installed, but the Docker daemon was not running during this baseline. PostgreSQL CLI is also not installed. No Docker isolation or pg-boss recovery claim is considered verified yet.
