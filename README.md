# LeCoding Agent

Phase 0 implementation of the v3.2 design: a recoverable, policy-enforced coding-agent harness with portable execution-environment contracts.

## Current vertical slices

- A Run reaches `succeeded` only after the Verifier returns `passed`.
- A structured FakeModel command call flows through PolicyEngine and RunEnvironment before verification.
- Manual Runs can pause for one-time approval, resume, reject a tool call without execution, or cancel.
- Agent-loop errors are persisted as queryable Run failures.
- Strict RunEvent V1 envelopes support ordered lifecycle/status evidence and `Last-Event-ID` resume. Approval requests, bounded tool start/completion metadata, verification summaries, and stable Run failures are committed with their matching durable Run state; terminal evidence precedes the terminal status delimiter so complete replay cannot omit it.
- Client SDK exposes a fetch-based event stream usable by Web and Electron clients.
- PostgreSQL event persistence writes its leased delivery outbox atomically.
- PostgreSQL Run snapshots survive Worker replacement with optimistic version checks.
- A pre-execution pending-call snapshot plus durable tool-call ledger prevents model or command replay when a side-effect outcome is unknown.
- An atomic transition writer commits Run state, RunEvent, and delivery outbox together.
- The event dispatcher delivers outbox batches with documented at-least-once semantics.
- The SSE handler combines durable replay with race-safe, deduplicated live delivery.
- RunEvent V1 now records user-message submission, safe-boundary delivery, and Agent questions, so the conversation timeline survives refresh and Worker replacement. Answer and steer commands use client-stable `commandId` values. PostgreSQL atomically persists mailbox submission or waiting-question resolution together with the matching Run snapshot, conversation events, and SSE outbox records; exact retries reuse their durable receipt.
- PolicyEngine hard-denies Docker socket reads even in full-access mode.
- GitWorkspace creates or safely reopens one isolated worktree per Run and leaves the source checkout unchanged.
- Docker creation uses an auditable fixed-security plan; the macOS Docker Desktop PoC verifies non-root/read-only execution, bounded resources, scoped writable mounts, and cancellation.
- A fail-closed Linux-only evidence command builds the project sandbox image, rejects skipped isolation cases, and records target host/Docker/image metadata without accepting Docker Desktop as production evidence.
- A 20-task deterministic golden catalog covers Node and Python changes; stable 5-task representative and category-balanced 12-task acceptance suites run through the isolated, cost-accounted compatible-model executor.
- A provider-neutral OpenAI-compatible gateway maps strict `execute_command` and `request_user_input` function calls into RunEngine turns and durably carries Responses IDs or validated Chat Completions history through tool results.
- `apps/worker` composes the durable PostgreSQL adapters, Docker environment, model gateway, policy, production Verifier, cancellation listener, lease heartbeat, and pg-boss recovery scheduler behind one idempotent process lifecycle.
- The executable Worker host creates a bounded node-postgres Pool plus a rotating dedicated LISTEN session, proves both paths ready before startup, and drains them on SIGINT/SIGTERM without logging the database URI.
- The production Verifier executes every reviewed required argv command in a separate restricted container, while a system-owned host checker revalidates the managed worktree and applies Diff Safety without exposing Git metadata to either container. Uncovered acceptance criteria and infrastructure uncertainty fail closed as `inconclusive`, and Run cancellation aborts an in-flight verification command immediately.
- A loopback-only versioned HTTP control plane creates, inspects, streams, cancels, resolves single-call approvals, resumes persisted user questions, and queues live steering without competing for the active driver's lease while keeping the trusted project identity server-owned.
- The Phase 1 Web console creates Runs through the shared Client SDK, restores the newest Run after refresh, switches among a bounded project history, renders managed-worktree file changes and unified Diff, automatically resumes strict SSE streams from `Last-Event-ID`, suppresses at-least-once duplicates, replays the complete conversation and execution timeline through its terminal status event, renders bounded approval/tool/verification/failure detail plus current verification evidence, exposes cancellation, resolves only the displayed pending approval, answers a displayed `waiting_user` turn, and appends constraints while a Run is queued, preparing, running, or awaiting environment recovery.

## Commands

```bash
pnpm install
pnpm test
pnpm typecheck
```

## Model provider configuration

The model gateway is vendor-neutral at configuration time. Copy `.env.example` to the ignored `.env.local` and set:

```dotenv
LECODING_MODEL_PROTOCOL=openai_responses
LECODING_MODEL_BASE_URL=https://api.provider.example/v1
LECODING_MODEL_API_KEY=replace-with-provider-secret
LECODING_MODEL_ID=provider-model-id
```

Set `LECODING_MODEL_PROTOCOL` to `openai_responses` for `POST /responses`, or to `openai_chat_completions` for providers exposing `POST /chat/completions`. Both adapters require function/tool calling; Responses uses `previous_response_id`, while Chat Completions persists and validates the message history needed to continue its stateless protocol. Before exposing any action, the gateway replays the identical model request at most once when the HTTP body or tool arguments are not valid JSON; schema-invalid or still-malformed output fails closed. Remote endpoints must use HTTPS; local development endpoints may use HTTP on loopback addresses.

Before starting a local Worker, export the ignored file into its process environment with `set -a; source .env.local; set +a`. Worker composition then applies `loadOpenAiCompatibleModelConfig(process.env)` and `createOpenAiCompatibleAgentModel(...)`. The repository does not implicitly parse dotenv files, and a production Worker should receive the same variables from its secret manager.

The HTTP control plane remains unauthenticated on loopback by default. Set a
32-character-or-longer `LECODING_HTTP_AUTH_TOKEN` to protect API and SSE routes.
Non-loopback binding also requires `LECODING_HTTP_BEHIND_TLS_PROXY=1` and a trusted
HTTPS reverse proxy; the Worker flag only records that deployment assertion. The
Web console asks for the token and retains it only for the current tab session.

The Worker also requires `LECODING_DATABASE_URL`, `LECODING_WORKER_ID`, immutable `LECODING_DOCKER_IMAGE` and `LECODING_VERIFICATION_IMAGE` references, plus either `LECODING_PROJECT_REGISTRY_PATH` or the legacy single-project tuple; see `.env.example`. Every registered project has its own reviewed config, source repository, and canonical worktree root, and every Run gets `<worktreeRoot>/<runId>`. Build the verification image from `docker/verification.Dockerfile` whenever a reviewed lockfile or workspace manifest changes. It restores image-prepared dependencies through a disposable nested volume while the Run worktree remains the source of truth and network stays disabled. The executable host uses a bounded PostgreSQL Pool for normal queries and a replaceable dedicated Client for LISTEN/NOTIFY, initializes every durable adapter before accepting work, and closes them after recovery and engine subscriptions stop.

After exporting the reviewed environment, start the process with:

```bash
pnpm build
pnpm --filter @lecoding/worker start
```

Open `http://127.0.0.1:8787` after startup. The executable serves the prebuilt
Web console and `/api/v1` from the same origin. Loopback may remain unauthenticated;
non-loopback binding requires a strong token and trusted TLS-proxy assertion. The
port defaults to `8787` and can be changed with `LECODING_HTTP_PORT`.

The host loads a versioned administrator-owned project allowlist and the Web console can switch among those exact IDs. If no registry path is set, the legacy single-project variables preserve the existing deployment. `SIGINT` and `SIGTERM` trigger the same idempotent shutdown path; database startup and lifecycle errors are reported without echoing the connection URI. See [`docs/worker-deployment.md`](docs/worker-deployment.md) for the deployment contract.

## Project verification configuration

Set `LECODING_PROJECT_REGISTRY_PATH` to a trusted JSON registry such as [`docs/project-registry.example.json`](docs/project-registry.example.json), or use `LECODING_PROJECT_ID`, `LECODING_PROJECT_CONFIG_PATH`, and `LECODING_WORKTREE_ROOT` for one-project compatibility. Every resolved config/source path must be outside every managed worktree root. Worker startup canonicalizes the registry and parses and caches each verification plan before accepting work, so no Agent can weaken verification by editing a worktree copy:

```yaml
version: 1
verify:
  required:
    - name: tests
      argv: [pnpm, test]
      covers: ["*"]
    - name: typecheck
      argv: [pnpm, typecheck]
      covers: ["*"]
```

Commands are structured argv arrays and are executed without an implicit shell. `covers` may list exact acceptance criteria; the explicit administrator-reviewed `"*"` means that check supplies evidence for every task criterion. Unknown fields, string commands, empty plans, duplicate command names, configs inside the managed worktree root, and files larger than 64 KiB are rejected during startup.

## Workspace

```text
apps/worker           production Worker, HTTP API, and process lifecycle root
apps/web              Phase 1 single-user Run console
apps/                 future Desktop and Local Runner processes
packages/contracts    versioned shared Run and environment contracts
packages/run-engine   orchestration through the RunEngine interface
packages/run-environment portable execution environment interface
packages/run-events    ordered Run event journal and SSE resume encoding
packages/policy       capability authorization and hard denies
packages/verifier     reviewed-plan production verification and reports
packages/workspace    Git worktree isolation
packages/test-harness in-memory adapters for interface tests
packages/golden-evals deterministic task fixtures and real-model baseline runner seams
packages/openai-model strict Responses and Chat Completions transports and AgentModel adapters
docker/               sandbox image and runtime notes
docs/                 threat model and Phase 0 evidence
```

The current implementation has PostgreSQL adapters for Run snapshots, tool-call idempotency, leases, cancellation, ordered steering mailboxes, events, and pg-boss recovery, while tests can still use in-memory adapters. The executable Worker, canonical multi-project registration boundary with legacy fallback, project-routed worktree/environment/Verifier/Diff ownership, trusted project-YAML plan loader, dependency-prepared offline verification image, immediate verification cancellation, authenticated HTTP/API boundary, durable recovery scheduling, and minimum Web console are implemented. The configured local PostgreSQL service has passed the earlier Worker composition/start/stop and schema-initialization smoke; the pg-boss schema still needs inclusion in the next target-service smoke. The configured third-party model passed the five-task Phase 0 development baseline; the 12/20 acceptance suite then passed 10/12 and 11/12 before malformed-JSON retry hardening, followed by a 12/12 post-change run; see [`docs/evidence/golden-baseline-2026-08-25.md`](docs/evidence/golden-baseline-2026-08-25.md) and [`docs/evidence/golden-acceptance-2026-08-27.md`](docs/evidence/golden-acceptance-2026-08-27.md). Real browser-driven Runs covered create, manual approval, SSE lifecycle, managed Diff, verification evidence, cancellation, host Diff Safety, terminal container cleanup, and a clean committed-baseline transition to `succeeded`; see [`docs/evidence/browser-e2e-2026-08-26.md`](docs/evidence/browser-e2e-2026-08-26.md). The project owner accepted target-Linux isolation as tracked environmental evidence debt on 2026-08-26 so it does not block subsequent Phase 1 work.
