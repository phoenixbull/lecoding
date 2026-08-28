# Phase 2 Lease, Heartbeat, and Idempotency Audit

Updated: 2026-08-28

## Exit condition

V3 requires a replacement Worker to take over an interrupted Run without
repeating a tool side effect. The implemented guarantee is deliberately
**at-most-once**, not an unprovable distributed exactly-once claim:

- a completed `(run_id, call_id)` returns its durable result without execution;
- an `executing` claim left by a crashed Worker becomes
  `tool_call_outcome_unknown` and is never replayed automatically;
- only an expired generation lease can be acquired by a replacement Worker;
- every state/result write revalidates the current lease token;
- long prepare, perform, inspect, verify, and terminal-cleanup waits renew at
  half the lease interval;
- cancellation uses PostgreSQL notification for latency and the durable Run
  snapshot as the loss-tolerant fallback.

## Requirement evidence

| Requirement | Result | Direct evidence |
|---|---|---|
| One active Worker per Run | Proven | `postgres-run-lease.test.ts` covers first acquisition, contention, owner-only renewal/release, invalidation, generation takeover, and stale-token rejection. |
| Replacement after expiry | Proven | The PostgreSQL recovery test lets Worker B acquire the expired lease while Worker A is suspended. The two-Worker failover smoke reports one distinct claimant. |
| No model/tool replay during takeover | Proven | The takeover test recovers the persisted pending call without invoking Worker B's model. `tool-call-idempotency.test.ts` fault-injects the post-side-effect persistence window and observes one total execution. |
| Completed-result retry | Proven | `postgres-tool-call-ledger.test.ts` returns the durable result for an exact completed retry and rejects call-ID rebinding to another action. |
| Unknown-outcome fail closed | Proven | Both PostgreSQL and RunEngine tests turn a leftover executing claim into `outcome_unknown`; no environment action is issued. |
| Lease remains valid across long I/O | Proven | Heartbeat tests cover prepare, perform cancellation ticks, inspect, verification, disposal, renewal failure, and immediate invalidation. |
| Lost cancellation notification | Proven | Multi-session tests prove fanout; independent-PGlite tests prove notification isolation and then verify that the durable snapshot heartbeat fallback still aborts the active perform. |
| Recovery delivery is durable and singleton-scoped | Proven | Real pg-boss integration claims an expired non-terminal Run through the durable queue; retry/backoff and terminal exclusion are covered by the recovery-worker suite. |

## Verification

The focused Phase 2 audit command passed 28/28 tests across ten files on
2026-08-28. The repository-wide typecheck and test baseline remains recorded in
`docs/phase-2-status.md`.

## Residual operational obligation

Operators must monitor `tool_call_outcome_unknown` and reconcile it manually.
Automatically retrying that state would violate the exit condition. Target
deployment PostgreSQL/Worker failover smoke remains an environment-specific
release check; it does not change the proven application semantics.
