# Phase 2 Status

Updated: 2026-08-28

## In progress

| V3 task | Status | Current evidence |
|---|---|---|
| Login and project membership | Complete | GitHub OAuth Web Flow, mandatory organization/email allowlist, hashed expiring sessions and one-time state, HttpOnly cookie/logout, PostgreSQL users/projects/memberships, one-time bootstrap admin, admin membership API/SDK, and all project/Run IDOR surfaces covered by request tests. OAuth replay, callback parameter smuggling, non-allowlisted identity, and unknown auth-mode cases fail closed. |
| Approval flow | In progress | OpenAI Responses and Chat Completions expose an explicit HTTPS endpoint request. Network and command capabilities can be approved/rejected once or for the exact Run fingerprint, resume through provider continuation, and persist attributed decisions. The Web card shows capability, risk, policy reason, exact target, and bounded scope. Edit-and-allow and project-level rules remain. |
| `auto_review` and `full_access` | In progress | `full_access` is project-admin-only and server Runs remain workspace-only. Network IP/loopback/private/metadata targets, credential/browser files, Docker socket, and host-control commands are fixed deny across all modes. Independent reviewer audit and the complete adversarial matrix remain. |
| Lease, heartbeat, idempotency | Evidence audit pending | Existing takeover and no-replay implementation is strong but must be audited against the Phase 2 exit condition. |
| Artifact and redaction | Pending | Bounded Diff/evidence exists; general large-output Artifact storage and redaction remain. |
| Quotas and monitoring | Pending | Token/cost reports exist in golden evals; hard per-Run/user/project limits and metrics remain. |
| Security tests | Pending | Several path/container cases exist; Phase 2 authorization-write and approved-network exfiltration matrix remains. |

The Phase 2 goal remains active until every row and its attached V3 operational
work have direct implementation and verification evidence.

## Verification baseline

- `pnpm typecheck`: 12/12 workspace tasks passed.
- Non-Docker suite: 264/264 tests passed across 58 test files; the live model
  baseline remains explicitly opt-in.
- Raw `pnpm test`: 269 tests passed, one opt-in test skipped, and the two
  daemon-backed Docker cases timed out because the local Docker daemon was
  unresponsive. This is the previously parked target-Linux/Phase 0 environment
  evidence gap, not an assertion regression in the Phase 2 implementation.
