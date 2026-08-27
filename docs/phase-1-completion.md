# Phase 1 Completion Matrix

Updated: 2026-08-27

This matrix evaluates the implementation against the Phase 1 table and
acceptance sentence in `AI_Coding_Agent_PRD与技术设计方案书v3.md`. Phase 0 is treated
as complete for sequencing under the owner's 2026-08-26 exception; target-Linux
isolation remains evidence debt and is not represented as a production claim.

| V3 item | Exit condition | Status | Evidence |
|---|---|---|---|
| RunEngine + Worker | Run continues after browser disconnect and recovers after restart | Complete | Durable PostgreSQL snapshots, continuation state, pg-boss recovery, lease takeover, resumable SSE, and configured-service Worker/recovery smokes. |
| Workspace | Create worktree, apply changes, generate Diff, discard | Complete | Real Git tests prove isolated modification and source-checkout integrity; project-routed Diff is bounded; terminal result discard revalidates and removes only the managed worktree. |
| ExecutionSandbox | Run tests with resource and path constraints | Complete for development target | Docker plan and live Docker Desktop tests cover non-root, read-only rootfs, scoped mount, no network, bounded CPU/memory/PIDs/files/time, and cancellation. Target-Linux evidence remains the accepted exception. |
| Basic PolicyEngine | File and command capabilities can allow/ask/deny | Complete | Policy and RunEngine tests cover allow, one-time ask/approval, rejection, Run-specific deny, and unconditional Docker-socket deny. |
| `manual` approval | Sensitive capability blocks, approves/rejects, and resumes | Complete | Durable pending approval, approve-once/reject-once, cancellation, takeover protection, API/SDK/Web controls, and browser evidence. |
| Verifier | Model finish cannot succeed before verification passes | Complete | RunEngine success gate, independent restricted verification image, reviewed project-YAML commands, Diff Safety, cancellation, and fail-closed inconclusive evidence. |
| Web UI | Show progress, Diff, verification evidence, and cancellation | Complete | Same-origin console supports creation/history, resumable timeline, status, approval/question/steer, bounded Diff, verification checks, cancellation, and confirmed result discard. |
| Client SDK | Web uses the versioned SDK for HTTP/SSE | Complete | The SDK owns config, history, create/inspect, Diff, SSE decoding, cancel, approval, answer, steer, and terminal result resolution; Web contains no direct API fetches. |

## Phase 1 acceptance

- Golden quality: the category-balanced 12/20 suite passed 12/12 in one
  post-hardening run. See
  [`evidence/golden-acceptance-2026-08-27.md`](evidence/golden-acceptance-2026-08-27.md).
- Result isolation: every retained successful or failed result is discardable
  through the versioned API/SDK/Web seam. The real Git test proves discard and
  retry do not modify the source checkout. See
  [`evidence/run-result-discard-2026-08-27.md`](evidence/run-result-discard-2026-08-27.md).
- Automated baseline: 56 test files and 241 tests pass; the one skipped test is
  the opt-in live model baseline. All 12 package typecheck tasks and the Web
  production build pass.

## Remaining evidence debt

Run `node scripts/run-target-linux-isolation.mjs <report-path>` on the actual
Linux Worker host before claiming production isolation. This debt does not reopen
the accepted Phase 0/1 development milestones, but it remains a production gate.
