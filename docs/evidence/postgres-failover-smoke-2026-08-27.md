# PostgreSQL Two-Worker Failover Evidence — 2026-08-27

The real PostgreSQL service configured in the ignored root `.env.local` file was
exercised with two independent database connections and two pg-boss recovery
consumers:

```bash
pnpm smoke:postgres-failover
```

## Result

The command exited successfully with these fixed, secret-free assertions:

- two recovery Workers were registered against one durable queue domain;
- one synthetic expired Run produced exactly one successful lease claim;
- exactly one replacement Worker became the claimant;
- the UUID-scoped Run, lease, jobs, and dedicated pg-boss queues were deleted;
- a post-cleanup database query confirmed that none of those fixtures remained.

The recovery scanner receives an exact Run allowlist and UUID-specific queue names,
so it cannot claim unrelated expired Runs or consume jobs from production recovery
queues. The claimant uses the same PostgreSQL compare-and-swap lease condition as
the production recovery gate, but deliberately performs no model request, Git
worktree operation, verification, or Docker action.

## Claim boundary

This proves durable queue competition and single lease takeover for two recovery
consumers against the currently configured PostgreSQL service. It is not a process
crash/host-loss drill and does not replace target-Linux isolation evidence. A
different deployment database must rerun the command with its own injected secrets.
