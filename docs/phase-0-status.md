# Phase 0 Status

Updated: 2026-08-19

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
- Runs waiting for approval can be cancelled and their environment discarded.
- RunEvent V1 strictly validates every envelope field and JSON-safe payload data.
- The in-memory RunEventJournal assigns monotonic per-Run sequences and resumes after `Last-Event-ID`.
- RunEngine publishes ordered status events for Web and future PC clients.
- Client SDK opens fetch-based SSE streams with a resumable event cursor.
- Type checking passes across all implemented packages.

## Current automated baseline

```text
Test files: 6 passed
Tests:      14 passed
Typecheck:  all implemented package tasks passed
```

## Pending Phase 0 evidence

- PostgreSQL + pg-boss lease/recovery tracer bullet
- PostgreSQL event repository, transactional outbox, and long-lived SSE HTTP handler
- Run-scoped approval/rejection policy and durable continuation recovery
- Docker runtime limits and cancellation PoC
- 20 golden tasks, with 5 representative tasks executed for baseline
- Cost baseline using the configured model provider

## Environment note

Docker CLI 27.5.1 is installed, but the Docker daemon was not running during this baseline. PostgreSQL CLI is also not installed. No Docker isolation or pg-boss recovery claim is considered verified yet.
