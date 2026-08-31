# Operations Runbook

Updated: 2026-08-28

This runbook is the operational counterpart to
[`worker-deployment.md`](worker-deployment.md). It tells a new operator how to
back up, recover, upgrade, and clean a live Worker deployment without losing
durable Run evidence. Every command or identifier in this document is sourced
from the Worker process, `apps/worker`, and the `@lecoding/run-engine`,
`@lecoding/run-events`, `apps/web`, and `apps/worker` packages. Where the
process owns data, the runbook quotes the schema name and constant from
source so a reviewer can verify the operation against the code base.

All commands assume the operator has loaded `.env.local` (or the production
secret manager equivalent) into the shell and that
`LECODING_DATABASE_URL` resolves to the same PostgreSQL instance the Worker
uses. When the database lives on a separate host, replace `psql` invocations
with the equivalent connection wrapper (`pg_dump --dbname=$LECODING_DATABASE_URL`).

## B1 Backup

The Worker keeps two independent stores. PostgreSQL holds all durable Run
metadata, leases, tool-call ledger, approval ledger, project policy rules,
Artifact identity, Run event journals and outbox, budget records, steering
mailbox, and pg-boss recovery queues. The host filesystem holds only the
Artifact bytes under `<worktreeRoot>/artifacts` (mode `0600`) and the managed
Git worktrees under `<worktreeRoot>/<runId>`.

### B1.1 Snapshot the database

```bash
pg_dump --no-owner --quote-all-identifiers \
  --file=backup-$(date -u +%Y%m%dT%H%M%SZ).sql \
  "$LECODING_DATABASE_URL"
```

`pg_dump --no-owner` keeps the SQL file portable; the role that runs the
Worker does not need to match the role that restores it. The Worker relies on
`pg-boss` for queue management and the standard `CREATE TABLE IF NOT EXISTS`
clauses declared in every `*_SCHEMA_SQL` constant, so reinitializing a freshly
restored database does not require manual schema work — start the Worker once
and it migrates both Run-owned tables and `pgboss` automatically.

### B1.2 Snapshot the host filesystem

```bash
tar --create --preserve-permissions --file=artifacts-$(date -u +%Y%m%dT%H%M%SZ).tar \
  "$LECODING_WORKTREE_ROOT/artifacts"
```

The Artifact store writes only bounded, redacted bytes and their SHA-256 hash;
restoring them without the corresponding PostgreSQL rows is harmless because
every Artifact access revalidates the hash and the owning Run. Conversely, the
database is useless without its Artifact bytes because Artifact identity is a
content hash, not an inline copy.

### B1.3 Snapshot cadence

- `pg_dump` every 6 hours during active development, daily otherwise.
- `artifacts-*.tar` daily. Retain seven days locally; mirror to off-host object
  storage weekly.
- Take an extra snapshot before any schema upgrade (see B3) and after every
  production incident response.

### B1.4 Encryption and storage hygiene

- Encrypt backups at rest (the database URI may include credentials; the
  Artifact bytes may include redacted but recognisable substrings).
- Never echo the database URI into logs or shell history. Use the secret
  manager's expansion mechanism.
- Do not commit backups to source control even when sanitised.

## R1 Recovery

The Worker is designed to survive a Worker host loss without losing Run
progress. The recovery story has two parts: in-process recovery for short
outages (handled automatically) and full host recovery for a crashed or
replaced Worker instance.

### R1.1 In-process recovery (lease expiry and worker replacement)

`apps/worker` starts a single durable pg-boss job
`lecoding-run-recovery-scan` via `startAfter`; expired non-terminal leases are
republished as singleton-keyed `lecoding-run-recovery` jobs. pg-boss claims
them with PostgreSQL `SKIP LOCKED`, applies bounded exponential retry, and
runs only one Run per callback so a single failure cannot retry successful
peers. Terminal snapshots are excluded before enqueue.

`LECODING_RECOVERY_INTERVAL_MS` defaults to 5000 (rounded up to whole seconds),
accepts 1–3600000, and is the only knob that affects this loop. Operators do
not need to drain queues manually.

### R1.2 Restore from backup

1. Stop the Worker: send `SIGTERM` (or `SIGINT` once). The Worker treats both
   as one idempotent shutdown that stops the recovery loop, runs the daily
   Artifact retention pass, disposes RunEngine subscriptions and environments,
   closes the dedicated LISTEN client, and drains the pool. See
   [`worker-deployment.md`](worker-deployment.md#shutdown-and-evidence) for
   the full lifecycle.
2. Drop and re-create the Worker database, then apply the SQL backup:

   ```bash
   createdb "$LECODING_DATABASE_NAME"
   psql "$LECODING_DATABASE_URL" --file=backup-YYYYMMDDTHHMMSSZ.sql
   ```
3. Extract the Artifact bytes to the configured root:

   ```bash
   tar --extract --preserve-permissions --file=artifacts-YYYYMMDDTHHMMSSZ.tar \
     --directory="$(dirname "$LECODING_WORKTREE_ROOT")"
   ```
4. Start the Worker. Startup re-runs `CREATE TABLE IF NOT EXISTS` for every
   `*_SCHEMA_SQL` constant and migrates the pinned `pg-boss` 10.4.2 schema,
   then performs a `SELECT 1` through the otherwise-lazy pool before binding
   the loopback listener.
5. Resume Runs through the API or by re-running `pnpm --filter
   @lecoding/worker start`. Any Run that was `running` when the previous
   Worker died has an expired lease and is enqueued for
   `lecoding-run-recovery`; the lease token's `generation` ensures a
   replacement Worker will not double-execute in-flight provider requests
   (the postgres budget manager reconciles worst-case charges).

### R1.3 Verify recovery health

After restart, confirm the Worker is healthy before declaring success:

```bash
curl --silent --fail http://127.0.0.1:8787/api/v1/config
psql "$LECODING_DATABASE_URL" \
  --command="SELECT count(*) FROM pgboss.job WHERE name = 'lecoding-run-recovery';"
```

Replace the curl endpoint with whatever the build exposes for readiness; the
exact endpoint name lives in `apps/worker` and `apps/web`. Confirm the recovery
queue is empty within one `LECODING_RECOVERY_INTERVAL_MS` cycle; persistent
enqueue means a Run is genuinely stuck and needs manual inspection via
`/api/v1/runs/:runId`.

### R1.4 Failure recovery contract

| Symptom | First response |
|---|---|
| Worker will not bind the loopback listener | `LECODING_HTTP_PORT` is in use or `LECODING_HTTP_BEHIND_TLS_PROXY=1` was set without a proxy; abort, set both correctly, restart |
| Database connection refused | Confirm `LECODING_DATABASE_URL`, restart only after the database accepts `SELECT 1`; the Worker refuses to bind if startup fails |
| Recovery queue grows unbounded | Stop the Worker, inspect `runs` for stuck `running` rows, delete orphan leases, restart |
| Artifacts referenced by Run rows are missing on disk | Restore from the most recent `artifacts-*.tar`; the Worker will refuse to serve bytes that fail SHA-256 verification |

## U1 Upgrade

The Worker migrates its own database on every startup. There is no manual
schema work, but the upgrade order matters because the Worker pulls, builds,
and restarts itself in place.

### U1.1 Read the changelog

Every release notes three pieces of information:

1. Any new `*_SCHEMA_SQL` or migration statement that will run on startup.
2. Any breaking change to the Web/HTTP API or its SDK.
3. Any change to required environment variables, model defaults, or the
   reviewed project registry schema.

Read the entire section before proceeding.

### U1.2 Take a labelled backup

```bash
pg_dump --no-owner --quote-all-identifiers \
  --file=backup-pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ).sql \
  "$LECODING_DATABASE_URL"
tar --create --preserve-permissions \
  --file=artifacts-pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ).tar \
  "$LECODING_WORKTREE_ROOT/artifacts"
```

### U1.3 Drain and stop the Worker

Send `SIGTERM` once. Wait for the log line that records the orderly shutdown
(the same structured shutdown event emitted on every clean exit; see `apps/worker/src/worker-host.ts`).
Do not send `SIGKILL`; the Worker only flushes in-flight leases and Run
events during graceful shutdown, and `SIGKILL` forces R1.1 in-process
recovery on the next Worker boot, which is fine but adds avoidable churn.

### U1.4 Pull, install, build

```bash
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` produces `apps/web/dist` which the loopback listener serves
alongside the HTTP API. A Web-only change still requires `pnpm build` so the
static bundle is in place before the Worker starts.

### U1.5 Start the Worker

```bash
pnpm --filter @lecoding/worker start
```

Startup migrates Worker-owned tables (`RUN_STORE_SCHEMA_SQL`,
`RUN_EVENT_SCHEMA_SQL`, `RUN_LEASE_SCHEMA_SQL`,
`TOOL_CALL_LEDGER_SCHEMA_SQL`, `APPROVAL_LEDGER_SCHEMA_SQL`,
`POLICY_REVIEW_AUDIT_SCHEMA_SQL`, `ARTIFACT_SCHEMA_SQL`,
`RUN_BUDGET_SCHEMA_SQL`, `PROJECT_POLICY_RULES_SCHEMA_SQL`,
`RUN_STEER_MAILBOX_SCHEMA_SQL`) and the `pg-boss` 10.4.2 schema, all in one
pass. New constants added by the release are applied on this single startup;
operators do not run them by hand.

### U1.6 Roll back

If the upgrade breaks and the previous release must be restored:

1. Stop the Worker (`SIGTERM`).
2. Restore the pre-upgrade database backup and Artifact archive using the
   steps in R1.2.
3. `git checkout <previous-tag> && pnpm install --frozen-lockfile && pnpm build`.
4. Start the Worker. The schema is backward compatible with the previous
   version (rollback only restores data, never new columns); if a column is
   added in the new release and the rollback removes it, operators must run
   the matching `ALTER TABLE ... DROP COLUMN IF EXISTS` from the previous
   release's migration notes.

## C1 Cleanup

Cleanup is automatic by design; the runbook only documents the knobs and the
hard-stop behaviour. There is no manual `vacuum` step in normal operation.

### C1.1 Daily retention

Artifact retention runs once during startup and then daily. It removes local
bytes and PostgreSQL metadata older than seven days and writes one fixed
structured record containing `deletedCount`, `failureCount`, and residual
storage keys. Operators forward the record to the log backend and alert on
non-zero `failureCount`.

```bash
psql "$LECODING_DATABASE_URL" \
  --command="SELECT id, content_hash, byte_size FROM run_engine_artifacts WHERE created_at < now() - interval '8 days';"
```

The query above is a read-only diagnostic. The retention worker itself
deletes these rows; operators should never delete by hand.

### C1.2 Discarding a worktree

`POST /api/v1/runs/:runId/result` accepts exactly `{"outcome": "keep"}` or
`{"outcome": "discard"}` for a terminal Run. `discard` immediately removes
the revalidated managed worktree and is idempotent for safe retries; neither
outcome accepts a caller-controlled filesystem path. The Workspace manager
derives the path again, resolves the source and worktree roots, and asks Git
to prove the exact directory belongs to that source before `discard` can
remove it. Repeated discard requests converge after the worktree is gone.

The Web console requires a destructive-action confirmation and exposes
discard only for successful or failed Runs; cancelled Runs have already
released their worktree.

### C1.3 Manual worktree cleanup after a bug

If a bug ever leaks a worktree past `discard`, follow these steps. They are
**last-resort** operations and must not become routine.

1. Confirm the worktree is leaked (the Worker has stopped and the Run is
   terminal with a still-present directory):

   ```bash
   ls "$LECODING_WORKTREE_ROOT/<runId>"
   ```
2. Confirm the path belongs to the registered source:

   ```bash
   git --git-dir="$LECODING_WORKTREE_ROOT/<runId>/.git" rev-parse --show-toplevel
   ```
3. Delete the worktree only if `rev-parse` returns a directory under the
   registered source root. Never delete blindly; an attacker who controls a
   Run task can try to trick an operator into deleting a non-worktree path.

   ```bash
   rm --recursive "$LECODING_WORKTREE_ROOT/<runId>"
   ```
4. Record the manual cleanup in the change log; the next retention cycle will
   reconcile the database row to the deleted state on its next pass.

### C1.4 Pruning the Run event journal

`pg-boss` and the Worker-owned Run event journal are not pruned by retention
by default; they are bounded by the 30-day Run-event retention policy in the
PRD. To prune early (for example, before an upgrade that adds a new column):

```bash
psql "$LECODING_DATABASE_URL" \
  --command="DELETE FROM run_events WHERE occurred_at < now() - interval '30 days';"
```

Take a labelled backup before this command. The Worker keeps a strict
projection that never logs raw tool output or model bodies, so pruning the
journal loses execution history without losing compliance evidence.

### C1.5 Stopping the Worker for planned maintenance

Send `SIGTERM` once. The Worker treats it as one idempotent shutdown:

1. Recovery stops first.
2. The daily Artifact retention pass runs once.
3. RunEngine subscriptions and environments dispose their worker handles.
4. The dedicated LISTEN client closes.
5. The query Pool drains.
6. Fatal lifecycle reporting uses a stable message and does not echo the
   database URI.

A second `SIGTERM` (or `SIGINT`) during shutdown is a no-op; do not escalate
to `SIGKILL` unless shutdown stalls for more than 30 seconds, because leases
only release cleanly during graceful shutdown.

## V1 Verification checklist

After any backup, recovery, or upgrade, the operator confirms the four
acceptance lines below match the Worker deployment's actual behaviour:

- [ ] `psql "$LECODING_DATABASE_URL" --command="SELECT count(*) FROM run_engine_runs;"`
      returns a non-negative integer and matches the dashboard projection.
- [ ] `ls "$LECODING_WORKTREE_ROOT/artifacts" | wc -l` matches the count of
      unreferenced Artifact rows minus the seven-day retention horizon.
- [ ] `psql "$LECODING_DATABASE_URL" --command="SELECT count(*) FROM pgboss.job WHERE name = 'lecoding-run-recovery';"`
      returns zero within one `LECODING_RECOVERY_INTERVAL_MS` cycle.
- [ ] `curl --silent --fail http://127.0.0.1:8787/api/v1/config` returns 200.

A clean run on all four lines is the Phase 3 "new operator can finish the
four operations" acceptance gate.