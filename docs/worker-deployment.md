# Worker deployment contract

`apps/worker` is now an executable, multi-project Phase 1 process. The host owns
one bounded PostgreSQL Pool for ordinary queries and one dedicated Client for
LISTEN/NOTIFY. If the listener disconnects, the cancellation bus reconnects
through a newly created Client rather than trying to reuse the failed session.

## Required configuration

Load `.env.local` into the process environment during local development, or
inject the equivalent values from the production secret/config manager:

```bash
set -a
source .env.local
set +a
pnpm --filter @lecoding/worker start
```

In addition to the model, project, worktree, and immutable image settings listed
in `.env.example`, the executable requires `LECODING_DATABASE_URL`. Keep the URI
out of source control and logs because it normally contains credentials.
`LECODING_DATABASE_POOL_MAX` defaults to 10 and is constrained to 1–100;
`LECODING_DATABASE_CONNECT_TIMEOUT_MS` defaults to 5000 and is constrained to
100–120000 milliseconds.

Production image references should use `registry/name@sha256:<manifest-digest>`.
For local Docker development, the Worker also accepts the exact immutable
`sha256:<image-id>` reported by `docker image inspect`; mutable tags remain rejected.

The database role must be able to connect and create/update the Worker-owned Run,
lease, tool-call, and event tables. Startup connects the dedicated listener and
runs `SELECT 1` through the otherwise-lazy Pool before schema initialization.
Any failure aborts startup and closes both resources.

Startup also migrates the pinned pg-boss 10.4.2 schema through the same Worker-owned
Pool before opening HTTP. One durable `lecoding-run-recovery-scan` job chains the
next scan using `startAfter`; expired non-terminal leases become singleton-keyed
`lecoding-run-recovery` jobs. pg-boss claims them with PostgreSQL `SKIP LOCKED`,
applies bounded exponential retry, and runs only one Run per callback so one failure
cannot retry successful peers. Terminal snapshots are excluded before enqueue.
`LECODING_RECOVERY_INTERVAL_MS` defaults to 5000, accepts 1–3600000, and is
rounded up to whole seconds.

## Project registration boundary

Prefer a versioned administrator-controlled registry:

- `LECODING_PROJECT_REGISTRY_PATH`: canonical absolute path to a strict JSON file shaped like [`project-registry.example.json`](project-registry.example.json).
- The first entry is the default project returned for backward-compatible clients.
- Each entry supplies a stable `id`, canonical `configPath`, and canonical `worktreeRoot`.

When no registry path is set, the process accepts the legacy single-project tuple:

- `LECODING_PROJECT_ID`: stable application identifier, not discovered from Agent input.
- `LECODING_PROJECT_CONFIG_PATH`: canonical absolute path to the reviewed source repository's `.ai-agent/project.yaml`.
- `LECODING_WORKTREE_ROOT`: canonical absolute root reserved for managed Run worktrees.

The Worker resolves every configured path through filesystem realpath before
accepting work. Duplicate IDs/configs/sources, aliased or nested worktree roots,
and any source/worktree overlap fail startup. It then derives each trusted source
repository from its config path and routes every Run to that project's own
worktree factory, verification plan, Diff Safety checker, and change reader.

## Shutdown and evidence

`SIGINT` and `SIGTERM` share one idempotent shutdown. Recovery stops first, then
RunEngine subscriptions and environments are disposed, the LISTEN Client ends,
and the Pool drains. Fatal lifecycle reporting uses a stable message and does not
echo the database URI.

Malformed provider JSON retries are written to stderr as one-line structured
events. Each retry chain emits `retrying`, followed by either `recovered` or
`exhausted`:

```json
{"event":"model_malformed_json_retry","runId":"run-123","protocol":"openai_chat_completions","retryCount":1,"failureCategory":"tool_arguments_invalid_json","outcome":"recovered"}
```

The fixed projection contains only Run identity, protocol, count, stable failure
category, and outcome. It deliberately excludes model ID, endpoint, API key,
request/response bodies, and tool arguments. Forward these JSON lines to the
deployment log backend and alert on `outcome: "exhausted"` or a sustained rise
in `retrying`; telemetry receiver failures are isolated from Run execution.

Unit tests exercise Pool/LISTEN separation, readiness cleanup, listener rotation,
duplicate signals, and shutdown ordering. The reusable `pnpm smoke:postgres`
command has also passed against the PostgreSQL service configured in `.env.local`:
production composition/start/stop created all seven Worker-owned tables, migrated
the `pgboss` schema, and registered both recovery queues. See
[`evidence/postgres-worker-smoke-2026-08-27.md`](evidence/postgres-worker-smoke-2026-08-27.md).
This is configured-service evidence rather than a claim about a different target
deployment; rerun the command with that deployment's injected environment.

The real pg-boss adapter additionally has PGlite integration evidence for
expired-lease discovery, terminal filtering, job claiming, and graceful shutdown.
The steering mailbox's ordering and replacement-Worker behavior also pass the
PostgreSQL-compatible integration suite.

`pnpm smoke:postgres-failover` has passed against the configured real PostgreSQL
service with two independent connections and recovery consumers. One UUID-scoped
expired Run produced exactly one replacement lease claimant, after which the
dedicated jobs, queues, lease, and Run were deleted and absence was rechecked. See
[`evidence/postgres-failover-smoke-2026-08-27.md`](evidence/postgres-failover-smoke-2026-08-27.md).
The smoke uses explicit queue names and an exact Run allowlist so it cannot consume
production recovery work.

`pnpm smoke:postgres-cancel` has also passed with two independent real LISTEN
sessions. Cancellation fanout reached both sessions in both publisher directions;
after one Worker's owned listener was deliberately ended, its cancel bus rotated
the client, re-LISTENed, and restored two-recipient fanout while the other Worker
remained online. See
[`evidence/postgres-cancel-reconnect-smoke-2026-08-27.md`](evidence/postgres-cancel-reconnect-smoke-2026-08-27.md).
The diagnostic disconnect cannot close the query Pool or another Worker's session.

`pnpm smoke:postgres-steering` has passed against the same configured service.
Worker A inserted two ordered commands and retried one command ID idempotently;
Worker B read both, then resumed after the first durable sequence. Exactly two
submitted-message events had matching outbox rows. The UUID-scoped mailbox,
event/outbox, and counter fixtures were deleted and absence was rechecked. See
[`evidence/postgres-steering-smoke-2026-08-27.md`](evidence/postgres-steering-smoke-2026-08-27.md).

## Web and API control plane

Run `pnpm build` before starting the Worker so `apps/web/dist` is available. The
same loopback listener then serves the Web console and these versioned endpoints:

- `GET /api/v1/config` returns the server-owned default project, registered project allowlist, and default environment.
- `GET /api/v1/auth/github/start` begins a GitHub OAuth Web Flow with a hashed, expiring, one-time state; the callback creates an application session in an HttpOnly cookie.
- `POST /api/v1/auth/logout` revokes the presented database session and clears its cookie.
- `GET /api/v1/projects/:projectId/memberships` lists memberships for project administrators; `PUT` or `DELETE /api/v1/projects/:projectId/memberships/:userId` assigns or removes an exact `viewer`, `developer`, or `admin` role.
- `GET /api/v1/projects/:projectId/runs?limit=20` returns up to 50 newest summaries for refresh recovery.
- `POST /api/v1/projects/:projectId/runs` persists a queued Run and detaches resume.
- `GET /api/v1/runs/:runId` returns current status and verification evidence.
- `GET /api/v1/runs/:runId/changes` returns a bounded file list and unified Git Diff from the managed worktree.
- `GET /api/v1/runs/:runId/events` streams durable, resumable SSE events.
- `POST /api/v1/runs/:runId/result` accepts exactly `{ "outcome": "keep" | "discard" }` for a terminal Run. `discard` immediately removes the revalidated managed worktree and is idempotent for safe retries; neither outcome accepts a caller-controlled filesystem path.
- `POST /api/v1/runs/:runId/commands` accepts cancel, strict single-call approve/reject commands, a matching `answer`, or a bounded `steer`. Browser approval scope must be `once`; Run-wide grants are rejected. Answers carry the displayed request ID so a stale tab cannot answer a newer question. Every answer and steer also carries a client-stable `commandId` of at most 128 characters; the SDK generates a UUID unless the caller supplies one for an explicit retry. Steering resolves the current `waiting_user` question or enters the durable mailbox while a Run is queued, preparing, running, or awaiting environment recovery.

`LECODING_HTTP_HOST` defaults to `127.0.0.1` and `LECODING_HTTP_PORT` defaults to
`8787`. Loopback remains unauthenticated when `LECODING_HTTP_AUTH_TOKEN` is empty.
Setting a 32–512 character visible-ASCII token protects every `/api/*` route,
including config, history, inspect, changes, result resolution, SSE, and commands, with a constant-time
Bearer comparison. Static assets remain public so the login shell can load; they
contain no Run or provider data. The Web console stores the entered token only in
the current tab's `sessionStorage` and the Client SDK sends it only in the
`Authorization` header, never a URL.

A non-loopback host additionally requires `LECODING_HTTP_BEHIND_TLS_PROXY=1`.
This flag is an explicit operator assertion, not TLS implementation: terminate
HTTPS at a trusted reverse proxy, restrict direct access to the Worker port, and
forward the Authorization header unchanged. Without both the token and assertion,
startup fails before binding. Rotate the token through the deployment secret
manager and reload the Worker; do not place it in source control or proxy access
logs.

For Phase 2 multi-user mode, set `LECODING_AUTH_MODE=database_sessions` and do
not set `LECODING_HTTP_AUTH_TOKEN`. Configure the HTTPS
`LECODING_PUBLIC_ORIGIN`, GitHub OAuth client ID/secret, and at least one
organization or email login allowlist. The callback verifies a primary GitHub
email, checks the configured organization/email allowlist, and replaces the
short-lived provider credential with a 24-hour application session. PostgreSQL
stores only SHA-256 session/state digests; state is consumed atomically and
cannot be replayed. Provider response bodies and tokens are never copied into
public failures.

`LECODING_GITHUB_BOOTSTRAP_ADMIN_EMAILS` is a separate explicit bootstrap
allowlist. When one of those identities first logs in, it may atomically claim
the initial `admin` membership for a registered project only while that
project's bootstrap flag is unused. Later logins cannot claim it, even if the
membership is subsequently removed. Successful login by any other allowed
identity grants no repository access until a project administrator creates a
membership. Every config, history, create, inspect, SSE, changes, result, and
command request rechecks membership and returns the same 404 surface for a
missing project and a cross-project IDOR attempt.
SSE delivery is at least once; clients deduplicate by the event sequence and may
resume with `Last-Event-ID`. The Web console reconnects after transport EOF or
failure, refreshes status during the retry window, and stops after replaying the
terminal status event. The same stream persists conversation events plus
`approval_requested`, `tool_started`, `tool_completed`,
`verification_completed`, and `run_failed`, so reopening a terminal Run
reconstructs its execution evidence instead of showing only current status. Raw
tool argv/output is excluded; the Web formatter accepts only known primitive
fields and bounds displayed text. Terminal evidence is ordered before the
terminal status event that closes replay. Browser disconnection never owns Run
execution.

History is a bounded read-only projection from durable Run snapshots. The path
project must belong to the Worker registry. Responses contain
task/status metadata only, never model continuation, tool results, approval
internals, or provider data. Inspect, SSE, changes, result, and command routes independently
check that the resolved Run belongs to this Worker's allowlist before returning data
or changing state. The Web selector is populated only from the same bootstrap list
and aborts the previous project's SSE before loading another project's history.

Model questions are persisted as a minimal `{id, prompt}` projection and survive
Worker replacement. The provider continuation stays server-side. Answering or
steering consumes that one pending question, recreates an offline Run environment
when necessary, and continues the same model turn. Live steering uses an independent
PostgreSQL sequence, so it does not acquire or invalidate the active Run lease and
cannot interrupt an in-flight command. The driver stages ordered messages into its
durable snapshot and injects them into Responses or Chat Completions at the next
safe model boundary. A message submitted after the model's final boundary may lose
the race with terminal verification and is then rejected by the resulting status.

For live steering, one PostgreSQL CTE inserts the mailbox row, allocates the RunEvent
sequence, persists `user_message_submitted`, and queues its SSE outbox record. The
unique `(run_id, command_id)` key makes a byte-identical retry return the original
mailbox sequence without another event. When resolving `waiting_user`, the Run
snapshot records a bounded command receipt and consumes the question/tool continuation
in the same transaction that writes its status plus submitted/delivered events and
outbox rows. The delivery boundary likewise commits the mailbox cursor and
`user_message_delivered` together. Reusing any receipt key with different type,
question, or content fails closed, including after the Run reaches a terminal state.

The change reader derives `<worktreeRoot>/<runId>` itself, rejects path-shaped Run
IDs, and revalidates the Git common directory against the registered source on
every request. It never creates a missing worktree. Responses include at most 500
file paths and approximately 256k Diff characters; larger output is marked
truncated. New untracked files use Git `--no-index` output, and all browser
rendering uses text rather than HTML.

Result resolution uses the same server-owned routing. The API first verifies that
the durable Run belongs to a registered project and is terminal. The Workspace
manager then derives the path again, resolves the source and worktree roots, and
asks Git to prove the exact directory belongs to that source before `discard` can
remove it. Repeated discard requests converge after the worktree is gone. The Web
console requires a destructive-action confirmation and exposes discard only for
successful or failed Runs; cancelled Runs have already released their worktree.

Required commands run in the independent verification image, but Git metadata is
never mounted there. A host-owned Diff Safety checker revalidates the exact managed
worktree and checks both tracked and untracked changes. After verification, the
runtime container and anonymous dependency volume are deleted while the worktree
is retained for the bounded changes endpoint. A failed cleanup is recorded as
stable inconclusive verification evidence.
