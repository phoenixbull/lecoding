# Phase 2 Status

Updated: 2026-08-28

## In progress

| V3 task | Status | Current evidence |
|---|---|---|
| Login and project membership | Complete | GitHub OAuth Web Flow, mandatory organization/email allowlist, hashed expiring sessions and one-time state, HttpOnly cookie/logout, PostgreSQL users/projects/memberships, one-time bootstrap admin, admin membership API/SDK, and all project/Run IDOR surfaces covered by request tests. OAuth replay, callback parameter smuggling, non-allowlisted identity, and unknown auth-mode cases fail closed. |
| Approval flow | In progress | Exact normalized capability fingerprints now support `allow_for_run` and `deny_for_run` without bypassing fixed deny. Approval requests and attributed once/run decisions use a PostgreSQL single-decision audit ledger. Explicit network capability requests, edit/project scopes, and the UI card remain. |
| `auto_review` and `full_access` | Pending | Basic deterministic policy exists; independent reviewer, admin gate, adversarial evaluation, and full fixed-deny matrix remain. |
| Lease, heartbeat, idempotency | Evidence audit pending | Existing takeover and no-replay implementation is strong but must be audited against the Phase 2 exit condition. |
| Artifact and redaction | Pending | Bounded Diff/evidence exists; general large-output Artifact storage and redaction remain. |
| Quotas and monitoring | Pending | Token/cost reports exist in golden evals; hard per-Run/user/project limits and metrics remain. |
| Security tests | Pending | Several path/container cases exist; Phase 2 authorization-write and approved-network exfiltration matrix remains. |

The Phase 2 goal remains active until every row and its attached V3 operational
work have direct implementation and verification evidence.

## Verification baseline

- `pnpm typecheck`: 12/12 workspace tasks passed.
- Non-Docker suite: 255/255 tests passed across 58 test files; the live model
  baseline remains explicitly opt-in.
- Raw `pnpm test`: 260 tests passed, one opt-in test skipped, and the two
  daemon-backed Docker cases timed out because the local Docker daemon was
  unresponsive. This is the previously parked target-Linux/Phase 0 environment
  evidence gap, not an assertion regression in the Phase 2 implementation.
