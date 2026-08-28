# Phase 2 Status

Updated: 2026-08-28

## In progress

| V3 task | Status | Current evidence |
|---|---|---|
| Login and project membership | Complete | GitHub OAuth Web Flow, mandatory organization/email allowlist, hashed expiring sessions and one-time state, HttpOnly cookie/logout, PostgreSQL users/projects/memberships, one-time bootstrap admin, admin membership API/SDK, and all project/Run IDOR surfaces covered by request tests. OAuth replay, callback parameter smuggling, non-allowlisted identity, and unknown auth-mode cases fail closed. |
| Approval flow | Complete | OpenAI Responses and Chat Completions expose an explicit HTTPS endpoint request. Network and command capabilities can be approved/rejected once, for the exact Run fingerprint, or as an exact project rule by an administrator, then resume through provider continuation with attributed decisions. Project-rule versions are PostgreSQL-backed, independently revocable through admin API/SDK/Web settings, and hidden from non-admin callers. `edit_and_allow_once` executes only the normalized replacement: command edits may only remove argv entries and the final argv must pass independent review; network edits must be a strict subdomain on the same HTTPS port. The immutable audit retains both original and edited fingerprints/constraints. API, SDK, and Web expose the complete bounded decision set. |
| `auto_review` and `full_access` | In progress | `auto_review` now uses an independently injected reviewer with validated `allow`/`ask` output and an immutable PostgreSQL audit record; deterministic project/fixed rules run before it. The Web composer exposes manual/auto-review to developers and adds full access only for the selected project's administrator, using the authenticated bootstrap role; the API independently rechecks that authority. Server Runs remain workspace-only. Network IP/loopback/private/metadata targets, credential/browser files, Docker socket, and host-control commands are fixed deny across all modes. A dedicated adversarial evaluator covers command-shape and fixed-deny bypass attempts; the remaining V3 fixed-deny and exfiltration matrix still has to close before this row is complete. |
| Lease, heartbeat, idempotency | Evidence audit pending | Existing takeover and no-replay implementation is strong but must be audited against the Phase 2 exit condition. |
| Artifact and redaction | Pending | Bounded Diff/evidence exists; general large-output Artifact storage and redaction remain. |
| Quotas and monitoring | Pending | Token/cost reports exist in golden evals; hard per-Run/user/project limits and metrics remain. |
| Security tests | Pending | Several path/container cases exist; Phase 2 authorization-write and approved-network exfiltration matrix remains. |

The Phase 2 goal remains active until every row and its attached V3 operational
work have direct implementation and verification evidence.

## Verification baseline

- Current focused approval/policy/API/SDK/Web suite: 103/103 tests passed across
  seven test files, including edited-capability audit, legacy scope migration,
  project-rule versioning, and independent reviewer behavior.
- `pnpm typecheck`: 12/12 workspace tasks passed.
- Non-Docker repository suite: 287 tests passed and one opt-in live-model test
  was skipped; HTTP transport passed 8/8 with loopback-bind permission.
- Raw repository suite: 292 tests passed and one opt-in live-model test was
  skipped across 63 files. Two daemon-backed Docker cases timed out because the
  local Docker daemon remained unresponsive; this is the explicitly parked
  target-Linux/Phase 0 evidence gap, not an assertion regression.
