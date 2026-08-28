# Phase 2 Status

Updated: 2026-08-28

## In progress

| V3 task | Status | Current evidence |
|---|---|---|
| Login and project membership | Complete | GitHub OAuth Web Flow, mandatory organization/email allowlist, hashed expiring sessions and one-time state, HttpOnly cookie/logout, PostgreSQL users/projects/memberships, one-time bootstrap admin, admin membership API/SDK, and all project/Run IDOR surfaces covered by request tests. OAuth replay, callback parameter smuggling, non-allowlisted identity, and unknown auth-mode cases fail closed. |
| Approval flow | Complete | OpenAI Responses and Chat Completions expose an explicit HTTPS endpoint request. Network and command capabilities can be approved/rejected once, for the exact Run fingerprint, or as an exact project rule by an administrator, then resume through provider continuation with attributed decisions. Project-rule versions are PostgreSQL-backed, independently revocable through admin API/SDK/Web settings, and hidden from non-admin callers. `edit_and_allow_once` executes only the normalized replacement: command edits may only remove argv entries and the final argv must pass independent review; network edits must be a strict subdomain on the same HTTPS port. The immutable audit retains both original and edited fingerprints/constraints. API, SDK, and Web expose the complete bounded decision set. |
| `auto_review` and `full_access` | In progress | `auto_review` now uses an independently injected reviewer with validated `allow`/`ask` output and an immutable PostgreSQL audit record; deterministic project/fixed rules run before it. The Web composer exposes manual/auto-review to developers and adds full access only for the selected project's administrator, using the authenticated bootstrap role; the API independently rechecks that authority. Server Runs remain workspace-only. Network IP/loopback/private/metadata targets, credential/browser files, Docker socket, and host-control commands are fixed deny across all modes. A dedicated adversarial evaluator covers command-shape and fixed-deny bypass attempts; the remaining V3 fixed-deny and exfiltration matrix still has to close before this row is complete. |
| Lease, heartbeat, idempotency | Complete | Generation-based PostgreSQL leases enforce one active owner and reject stale renewal/writes. Half-interval heartbeats cover long prepare/perform/inspect/verify/cleanup waits and invalidate immediately on renewal loss. pg-boss durably discovers expired non-terminal Runs with singleton claims. The PostgreSQL tool ledger binds exact `(run_id, call_id, action)` identities: completed results are reused, while a crash-window `executing` claim fails closed as `tool_call_outcome_unknown` and is never replayed. Focused takeover/cancellation/idempotency verification passed 28/28; the requirement-by-requirement evidence is in [`phase-2-lease-idempotency-audit.md`](phase-2-lease-idempotency-audit.md). |
| Artifact and redaction | Complete | Docker capture is hard-bounded to 8 MiB per stream and Run/model/tool-ledger persistence to a 16 KiB UTF-8 prefix. Oversized retained output is redacted before a content-addressed local write; PostgreSQL stores immutable metadata only. Run inspection exposes hash references, while API/SDK/Web reads are bound to the owning Run and project membership and rendered as inert text. Deployment credentials are rejected from original Run/user/tool inputs before persistence, and known credentials plus provider-shaped tokens are redacted from command output. Startup-plus-daily retention removes Artifacts older than seven days and reports deletion/failure counts with residual storage keys. Focused evidence is in [`phase-2-artifact-redaction-audit.md`](phase-2-artifact-redaction-audit.md). |
| Quotas and monitoring | Pending | Token/cost reports exist in golden evals; hard per-Run/user/project limits and metrics remain. |
| Security tests | Pending | Several path/container cases exist; Phase 2 authorization-write and approved-network exfiltration matrix remains. |

The Phase 2 goal remains active until every row and its attached V3 operational
work have direct implementation and verification evidence.

## Verification baseline

- Current focused Artifact/redaction suite: 11/11 tests passed across RunEngine,
  local/PostgreSQL storage, retention, Docker capture, Worker redaction, API, and SDK.
- `pnpm typecheck`: 12/12 workspace tasks passed.
- Repository suite: 302 tests passed and one opt-in live-model test was skipped
  across 65 files. HTTP transport passed 8/8 with loopback-bind permission;
  Docker adapter tests passed 6/8, while the two daemon-backed cases timed out at
  120/30 seconds because the local daemon remained unresponsive. This is the
  explicitly parked target-Linux/Phase 0 environment evidence gap.
