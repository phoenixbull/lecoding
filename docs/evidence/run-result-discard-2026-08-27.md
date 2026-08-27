# Run Result Discard Evidence — 2026-08-27

This slice closes the V3 Phase 1 requirement that every retained terminal Run
result can be discarded without changing the source checkout.

## Proven boundary

- `POST /api/v1/runs/:id/result` accepts only a one-field `keep` or `discard`
  body and rejects non-terminal Runs before touching Workspace state.
- Worker routing derives the trusted project from the durable Run; neither HTTP
  nor SDK callers can supply a repository or worktree path.
- Workspace resolution rejects path-shaped Run IDs, canonicalizes registered
  roots, revalidates Git ownership, and removes only the exact managed worktree.
- Discard is idempotent after a successful removal. Keep preserves the worktree.
- A real temporary Git repository test changes the Run worktree, discards it,
  retries discard, and proves the source checkout content is unchanged.
- The shared Client SDK owns the versioned request. The Web console exposes a
  confirmed destructive action only for successful or failed Runs.

## Verification

```text
Focused Workspace/API/SDK/Web tests: 31 passed
HTTP SDK integration tests:           5 passed
Repository tests:                     239 passed, 1 skipped
Typecheck:                            12 package tasks passed
Web production build:                 passed
git diff --check:                     passed
```

The ordinary sandbox cannot bind a loopback listener, so the first aggregate
invocation reported `EPERM` for three listener cases. A complete rerun with
loopback and Docker access passed all 56 enabled files and 239 tests, including
the public Client SDK result-discard request and both daemon-backed Docker cases.
