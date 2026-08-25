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
- A durable tool-call ledger prevents automatic replay when a side-effect outcome is unknown.
- An atomic transition writer commits Run state, RunEvent, and delivery outbox together.
- The event dispatcher delivers outbox batches with documented at-least-once semantics.
- The SSE handler combines durable replay with race-safe, deduplicated live delivery.
- PolicyEngine hard-denies Docker socket reads even in full-access mode.
- GitWorkspace creates an isolated worktree and leaves the source checkout unchanged.

## Commands

```bash
pnpm install
pnpm test
pnpm typecheck
```

## Workspace

```text
apps/                 future Web, Worker, Desktop, and Local Runner processes
packages/contracts    versioned shared Run and environment contracts
packages/run-engine   orchestration through the RunEngine interface
packages/run-environment portable execution environment interface
packages/run-events    ordered Run event journal and SSE resume encoding
packages/policy       capability authorization and hard denies
packages/verifier     verification interface
packages/workspace    Git worktree isolation
packages/test-harness in-memory adapters for interface tests
docker/               sandbox image and runtime notes
docs/                 threat model and Phase 0 evidence
```

The current implementation has PostgreSQL adapters for Run snapshots, tool-call idempotency, leases, cancellation, and events, while tests can still use in-memory adapters. A real model gateway, production verifier, pg-boss composition, and the Web/Worker processes remain pending Phase 0/1 work.
