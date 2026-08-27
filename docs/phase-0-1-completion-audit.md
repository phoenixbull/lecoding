# Phase 0–1 Completion Audit

Updated: 2026-08-27

Authority: the Phase 0 and Phase 1 tables in
`AI_Coding_Agent_PRD与技术设计方案书v3.md`. “Proven” below means the current
repository contains direct implementation and automated or retained runtime
evidence for the stated exit condition. It does not expand the milestone into a
production-readiness claim.

## Phase 0

| Requirement and exit condition | Result | Direct evidence |
|---|---|---|
| 20 golden tasks, each with a fixed repository, acceptance criteria, and verification commands | Proven | `packages/golden-evals/test/catalog.test.ts` validates exactly 20 unique deterministic tasks and checks every required field. Fixture materialization is independently tested. |
| Docker threat-model PoC proves path, resource, network, and non-root restrictions execute | Proven for the accepted development target | `packages/run-environment/test/docker-environment.test.ts` locks the fixed Docker plan, rejects lexical and symlink path escapes and unbounded memory, and executes daemon-backed non-root/read-only/workspace-write/cancellation checks. The 2026-08-27 full run executed both live Docker tests. Target-Linux evidence remains the owner's explicit exception. |
| Worktree PoC proves parallel Runs do not modify the main checkout | Proven | `packages/workspace/test/git-workspace.test.ts` concurrently prepares and changes two worktrees, observes different contents, and verifies the source file is unchanged. |
| At least one model stably emits structured tool calls | Proven | The retained five-task compatible-model baseline passed 5/5 through strict structured commands; the post-hardening acceptance run passed 12/12. `packages/openai-model/test/agent-model.test.ts` and the RunEngine integration test cover strict parsing and continuation. |
| Cost baseline records cost and duration for five representative tasks | Proven | `docs/evidence/golden-baseline-2026-08-25.json` records five results and a summary of 58,911 input tokens, 9,073 output tokens, USD 0.010788 list-price equivalent, and 93.039 seconds; the companion Markdown records pricing assumptions. |
| `/api/v1`, event envelope, RunEnvironment, and Client SDK compatibility types pass contract tests | Proven | HTTP/API and Client SDK tests exercise versioned endpoints; contracts reject incompatible event envelopes; RunEnvironment implementations compile against the shared interface; all package typechecks pass. |

## Phase 1

| Requirement and exit condition | Result | Direct evidence |
|---|---|---|
| RunEngine + Worker continue after browser disconnect and recover after restart | Proven | SSE cancellation test confirms stream ownership never issues a Run cancel. PostgreSQL snapshot/continuation, lease takeover, pg-boss recovery, Worker lifecycle, and configured-service smoke tests prove replacement-worker recovery. |
| Workspace creates worktrees, applies changes, generates Diff, and discards | Proven | Real Git tests cover preparation, direct content application, tracked/untracked Diff, recovery reopen, verified keep/discard, idempotent retry, and source-checkout integrity. |
| ExecutionSandbox runs tests under resource and path constraints | Proven for the accepted development target | The Docker plan and live daemon tests cover the required restrictions. Golden and browser runs executed model and verification commands in the restricted images. |
| Basic PolicyEngine supports file and command allow/ask/deny | Proven | The public PolicyEngine test now directly exercises protected-file allow, command ask, and Run-scoped command deny; the Docker socket remains unconditionally denied. RunEngine tests cover each downstream decision transition. |
| `manual` approval blocks, approves, rejects, and resumes sensitive capabilities | Proven | RunEngine tests cover durable `waiting_approval`, approve-once continuation, rejection without execution, takeover recovery, and cancellation. API/SDK/Web and browser evidence cover the public seam. |
| Verifier prevents `succeeded` until model completion passes verification | Proven | The first RunEngine test asserts the success gate; failure/inconclusive, independent verification-image, reviewed-command, Diff Safety, cancellation, and cleanup cases cover fail-closed behavior. |
| Web UI shows progress, Diff, verification evidence, and cancellation | Proven | Presentation/stream tests and real browser evidence cover status/timeline replay, managed Diff, verification checks, cancellation, approval and user input. Terminal discard is also exposed with confirmation. |
| Client SDK owns Web HTTP/SSE access | Proven | `apps/web/src` constructs one shared client and contains no direct `fetch`, `EventSource`, or `/api/v1` calls. SDK and real HTTP integration tests cover the complete Web surface. |

## Phase 1 overall acceptance

| Acceptance gate | Result | Direct evidence |
|---|---|---|
| At least 12 of 20 golden tasks pass verification in one run | Proven | `docs/evidence/golden-acceptance-2026-08-27-attempt-3.json` reports 12 tasks, 12 passed, 0 failed, pass rate 1.0. |
| Every result can be discarded without polluting the source repository | Proven | Terminal API/SDK/Web result resolution is project-routed and path-free. A real Git test keeps, discards, retries, confirms worktree removal, and confirms unchanged source content. |

## Final boundary

Phase 0 and Phase 1 are complete under the explicitly accepted development
milestone scope. The sole carried exception is production target-Linux isolation
evidence. It must be generated on the actual Linux Worker host before production
isolation is claimed; it is not silently converted into passing evidence here.
