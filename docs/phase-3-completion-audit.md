# Phase 3 Completion Audit

Updated: 2026-08-31

This audit maps every Phase 3 task in the V3 plan to current authoritative
implementation and verification evidence. The target-Linux isolation run
remains the explicit user-approved Phase 0 environment exception and is not
represented as production Linux evidence.

| V3 Phase 3 requirement | Result | Authoritative evidence |
|---|---|---|
| Project and directory-scoped AGENTS.md / CLAUDE.md loading | Proven | New [`packages/project-instructions`](file:///Users/letv_lzb/Documents/LeCodex/packages/project-instructions) loader walks from `cwd` to `projectRoot` (failing closed if `projectRoot` does not contain `cwd`), prefers `AGENTS.md` over `CLAUDE.md`, bounds each file to 64 KiB, and surfaces `ProjectInstructionSection[]` to RunEngine through a new `AgentModelInput.projectInstructions?: string[]` field consumed by both Anthropic and OpenAI adapters. RunEngine DI exposes `projectInstructions?: ProjectInstructionResolver` and `workspaceContext?: WorkspaceContextResolver`; both the loader and resolver are absent in default test harnesses so old tests stay green. |
| Reviewed project verification plan including test/typecheck/lint/build minimums | Proven | [`createProjectYamlVerificationPlanProvider`](file:///Users/letv_lzb/Documents/LeCodex/packages/verifier/src/project-yaml-plan-provider.ts#L72) keeps the original `load(input)` returning the cached, cloned `VerificationPlan` so production verifier behaviour is unchanged. The new `loadProjectConfig(input)` returns `{plan, network?, protectedPaths?}` parsed through the same `requireExactKeys` strict white-list, with a non-empty `network.askDomains` required when `network` is present so a missing field cannot silently weaken the egress policy. The loader is administrator-controlled, outside the worktree, and never accepts Agent input. |
| Steer and input requests — user can constrain or answer a Run | Proven | The RunEngine `command()` early-return now distinguishes `command.type === "steer"` in `waiting_user`: instead of falling through to the answer path that consumed the pending question, it enqueues the message through the durable mailbox. The next `drive()` consumes the staged message and the answer path independently accepts a real answer. Regression coverage in `run-engine.test.ts` and a new Anthropic end-to-end suite (`steer-user-request-e2e.test.ts`) prove the question survives steer and the steering text reaches the provider turn. |
| Second model adapter passing the same golden tasks and event contract | Proven | [`packages/anthropic-model`](file:///Users/letv_lzb/Documents/LeCodex/packages/anthropic-model) ships `createAnthropicAgentModel`, `createAnthropicCompatibleAgentModel`, `createAnthropicMessagesClient`, `loadAnthropicModelConfig`, and a `RUN_LIVE_GOLDEN=1`-gated baseline wired to the same golden fixture the OpenAI adapter uses. The HTTP transport seam uses `x-api-key` + `anthropic-version: 2023-06-01`, forces HTTPS with a loopback exemption, applies `AbortSignal.timeout`, and never echoes the API key in errors. `tool_use` is mapped to `execute_command` / `request_user_input` / `request_network_egress` / `user_request`; `user_request` resumes through a versioned continuation envelope; cache tokens fold into `inputTokens`; one bounded malformed-JSON retry emits the structured `retrying` / `recovered` / `exhausted` projection. |
| Operations documentation — backup, recovery, upgrade, cleanup | Proven | [`operations-runbook.md`](operations-runbook.md) walks the four operations against the real schema sources (`run_engine_runs`, `run_events`, `run_engine_artifacts`, `pgboss.job`) and the real config surface (`LECODING_RECOVERY_INTERVAL_MS`, `LECODING_HTTP_AUTH_TOKEN`, `LECODING_WORKTREE_ROOT`, `LEcoding_PROJECT_REGISTRY_PATH`). Backup cadence and encryption hygiene are documented; recovery enumerates pg-boss `lecoding-run-recovery-scan` and `lecoding-run-recovery` together with the manual restore sequence and a failure-mode table; upgrade lists the `pnpm install --frozen-lockfile && pnpm build` flow plus the auto-migrated `*_SCHEMA_SQL` constants and a rollback recipe; cleanup documents the seven-day retention, `discard` idempotency, and the Git-path revalidation guard for the manual worktree cleanup fallback. A four-line verification checklist closes the runbook. |

## Final verification gate

- `pnpm typecheck`: **14/14** workspace tasks passed.
- `pnpm test`: **394 passed + 2 skipped** across 77 files; the four known
  failures (two Docker daemon cases, two Postgres frozen-time drift cases)
  remain parked under the user-approved Phase 0 environment exception and
  predate this phase.
- Focused Phase 3 suites all green:
  - project-instructions loader: 9/9.
  - project-instructions RunEngine integration: 2/2.
  - verifier project-YAML plan provider (Phase 3 added `loadProjectConfig`
    and the network/protectedPaths branches): 11/11.
  - run-engine (with the steer regression tightened to the corrected
    semantics): 51/51.
  - anthropic-model agent-model + client + config + integration + golden
    suites: 35/35.
  - anthropic-model steer/user_request end-to-end: 2/2.
- Live-model evidence: the Anthropic baseline is gated by `RUN_LIVE_GOLDEN=1`
  and runs against the same golden fixture the OpenAI baseline uses, but the
  default repository run does not depend on a live provider.

## Limitations carried into Phase 4

- Live-model and live-isolation runs are not part of the default
  `pnpm test`. Operators reproduce them with the documented `RUN_LIVE_GOLDEN`
  command and the target-Linux daemon respectively.
- `protectedPaths` and `network.askDomains` are now parsed and returned by
  the YAML loader, but the corresponding runtime consumers (path-protected
  writes and runtime egress approvals) remain Phase 4 work; the seam is in
  place so Phase 4 can wire consumers without changing the parser.
- Multi-user approval surfaces for project rule revocation, edit-and-allow
  narrowing, and reviewer audit remain the Phase 2 evidence base; Phase 3
  did not regress them and did not extend them.