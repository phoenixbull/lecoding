# Worker deployment contract

`apps/worker` is now an executable, single-project Phase 1 process. The host owns
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

## Project registration boundary

Each process accepts exactly one administrator-controlled tuple:

- `LECODING_PROJECT_ID`: stable application identifier, not discovered from Agent input.
- `LECODING_PROJECT_CONFIG_PATH`: canonical absolute path to the reviewed source repository's `.ai-agent/project.yaml`.
- `LECODING_WORKTREE_ROOT`: canonical absolute root reserved for managed Run worktrees.

The Worker derives the trusted source repository from the config path and creates
one worktree per Run. Supporting several projects in one process remains a later
registry/scheduler feature; deploy separate Worker processes for separate projects
until that boundary is implemented.

## Shutdown and evidence

`SIGINT` and `SIGTERM` share one idempotent shutdown. Recovery stops first, then
RunEngine subscriptions and environments are disposed, the LISTEN Client ends,
and the Pool drains. Fatal lifecycle reporting uses a stable message and does not
echo the database URI.

Unit tests exercise Pool/LISTEN separation, readiness cleanup, listener rotation,
duplicate signals, and shutdown ordering. A smoke test against the target
PostgreSQL service is still required deployment evidence. The configured local
PostgreSQL container has passed Worker composition/start/stop and initialized all
the original six Worker-owned tables, which is development-host evidence rather than a target
deployment claim.

The steering mailbox adds a seventh table. Its ordering and replacement-Worker
behavior pass the PostgreSQL-compatible integration suite; include it in the next
real PostgreSQL startup smoke before claiming the expanded schema on that service.

## Web and API control plane

Run `pnpm build` before starting the Worker so `apps/web/dist` is available. The
same loopback listener then serves the Web console and these versioned endpoints:

- `GET /api/v1/config` returns the server-owned project and default environment.
- `GET /api/v1/projects/:projectId/runs?limit=20` returns up to 50 newest summaries for refresh recovery.
- `POST /api/v1/projects/:projectId/runs` persists a queued Run and detaches resume.
- `GET /api/v1/runs/:runId` returns current status and verification evidence.
- `GET /api/v1/runs/:runId/changes` returns a bounded file list and unified Git Diff from the managed worktree.
- `GET /api/v1/runs/:runId/events` streams durable, resumable SSE events.
- `POST /api/v1/runs/:runId/commands` accepts cancel, strict single-call approve/reject commands, a matching `answer`, or a bounded `steer`. Browser approval scope must be `once`; Run-wide grants are rejected. Answers carry the displayed request ID so a stale tab cannot answer a newer question. Every answer and steer also carries a client-stable `commandId` of at most 128 characters; the SDK generates a UUID unless the caller supplies one for an explicit retry. Steering resolves the current `waiting_user` question or enters the durable mailbox while a Run is queued, preparing, running, or awaiting environment recovery.

`LECODING_HTTP_HOST` defaults to `127.0.0.1` and rejects non-loopback values until
an authentication boundary exists. `LECODING_HTTP_PORT` defaults to `8787`.
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
project must equal the single project registered by the Worker. Responses contain
task/status metadata only, never model continuation, tool results, approval
internals, or provider data. Inspect, SSE, and command routes independently check
the resolved Run's project before returning data or changing state, so a shared
database does not turn knowledge of another Run ID into access.

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

Required commands run in the independent verification image, but Git metadata is
never mounted there. A host-owned Diff Safety checker revalidates the exact managed
worktree and checks both tracked and untracked changes. After verification, the
runtime container and anonymous dependency volume are deleted while the worktree
is retained for the bounded changes endpoint. A failed cleanup is recorded as
stable inconclusive verification evidence.
