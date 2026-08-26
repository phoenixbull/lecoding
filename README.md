# LeCoding Agent

Phase 0 implementation of the v3.2 design: a recoverable, policy-enforced coding-agent harness with portable execution-environment contracts.

## Current vertical slices

- A Run reaches `succeeded` only after the Verifier returns `passed`.
- A structured FakeModel command call flows through PolicyEngine and RunEnvironment before verification.
- Manual Runs can pause for one-time approval, resume, reject a tool call without execution, or cancel.
- Agent-loop errors are persisted as queryable Run failures.
- Strict RunEvent V1 envelopes support ordered status events and `Last-Event-ID` resume.
- Client SDK exposes a fetch-based event stream usable by Web and Electron clients.
- PostgreSQL event persistence writes its leased delivery outbox atomically.
- PostgreSQL Run snapshots survive Worker replacement with optimistic version checks.
- A pre-execution pending-call snapshot plus durable tool-call ledger prevents model or command replay when a side-effect outcome is unknown.
- An atomic transition writer commits Run state, RunEvent, and delivery outbox together.
- The event dispatcher delivers outbox batches with documented at-least-once semantics.
- The SSE handler combines durable replay with race-safe, deduplicated live delivery.
- PolicyEngine hard-denies Docker socket reads even in full-access mode.
- GitWorkspace creates an isolated worktree and leaves the source checkout unchanged.
- Docker creation uses an auditable fixed-security plan; the macOS Docker Desktop PoC verifies non-root/read-only execution, bounded resources, scoped writable mounts, and cancellation.
- A fail-closed Linux-only evidence command builds the project sandbox image, rejects skipped isolation cases, and records target host/Docker/image metadata without accepting Docker Desktop as production evidence.
- A 20-task deterministic golden catalog covers Node and Python changes; five stable cross-category representatives can run through an isolated, cost-accounted Codex CLI executor.
- A provider-neutral OpenAI-compatible gateway maps strict `execute_command` function calls into RunEngine turns and durably carries Responses IDs or validated Chat Completions history through tool results.
- `apps/worker` composes the durable PostgreSQL adapters, Docker environment, model gateway, policy, production Verifier, cancellation listener, lease heartbeat, and recovery scanner behind one idempotent process lifecycle.
- The production Verifier executes every reviewed required argv command plus a system-owned `git diff --check` in a separate restricted container; uncovered acceptance criteria and infrastructure uncertainty fail closed as `inconclusive`.

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

Set `LECODING_MODEL_PROTOCOL` to `openai_responses` for `POST /responses`, or to `openai_chat_completions` for providers exposing `POST /chat/completions`. Both adapters require function/tool calling; Responses uses `previous_response_id`, while Chat Completions persists and validates the message history needed to continue its stateless protocol. Remote endpoints must use HTTPS; local development endpoints may use HTTP on loopback addresses.

Before starting a local Worker, export the ignored file into its process environment with `set -a; source .env.local; set +a`. Worker composition then applies `loadOpenAiCompatibleModelConfig(process.env)` and `createOpenAiCompatibleAgentModel(...)`. The repository does not implicitly parse dotenv files, and a production Worker should receive the same variables from its secret manager.

The Worker also requires `LECODING_WORKER_ID`, canonical `LECODING_WORKTREE_ROOT` and `LECODING_WORKSPACE_PATH` values, plus an immutable `LECODING_DOCKER_IMAGE` digest; see `.env.example`. The workspace must be a dedicated strict child of the registered root. `composeProductionWorker(...)` takes ownership of an injected PostgreSQL query pool and a separate LISTEN connection, initializes every durable adapter before accepting work, and closes them after recovery and engine subscriptions stop.

## Workspace

```text
apps/worker           production Worker composition and lifecycle root
apps/                 future Web, Desktop, and Local Runner processes
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

The current implementation has PostgreSQL adapters for Run snapshots, tool-call idempotency, leases, cancellation, and events, while tests can still use in-memory adapters. The Worker and production Verifier composition seams are implemented, but the deployment host must still supply concrete PostgreSQL connections and a provider for committed/admin-reviewed project verification plans; pg-boss remains a later replacement for interval recovery. The golden-task catalog, Codex CLI and provider-native evaluation adapters, and RunEngine-native OpenAI-compatible model gateway are implemented. The configured third-party model passed the five-task Phase 0 development baseline; see [`docs/evidence/golden-baseline-2026-08-25.md`](docs/evidence/golden-baseline-2026-08-25.md). A project YAML plan loader, pg-boss adapter, executable Web/deployment hosts, and target-Linux isolation evidence remain pending Phase 0/1 work.
