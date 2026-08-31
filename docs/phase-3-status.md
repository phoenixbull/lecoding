# Phase 3 Status

Updated: 2026-08-31

Phase 3 closed the V3 exit conditions for project adaptation and developer
experience. All five PRD exit conditions now have direct implementation and
verification evidence; the only outstanding items are the live-model smoke
gate (provider key provisioning) and the project-Linux isolation environment
exception that Phase 2 already parked.

| V3 task | Status | Current evidence |
|---|---|---|
| `AGENTS.md` / `CLAUDE.md` | Complete | New [`packages/project-instructions`](file:///Users/letv_lzb/Documents/LeCodex/packages/project-instructions) loader walks `cwd → projectRoot`, returns ancestor-first sections, prefers `AGENTS.md` over `CLAUDE.md`, hard-bounds each file to 64 KiB, and rejects a `projectRoot` that does not contain `cwd` so cross-project scope cannot bleed. The `AgentModelInput` seam carries the resolved `projectInstructions: string[]` to the Anthropic and OpenAI adapters without forcing a provider-specific shape. |
| Verification configuration | Complete | [`createProjectYamlVerificationPlanProvider`](file:///Users/letv_lzb/Documents/LeCodex/packages/verifier/src/project-yaml-plan-provider.ts#L72) now exposes `loadProjectConfig()` returning `{plan, network?, protectedPaths?}` in addition to the existing `load()`; both routes reuse the same administrator-reviewed cache and `structuredClone` so Agent input cannot mutate required commands. `version`, `verify.required[]`, `network.askDomains[]`, and `protectedPaths[]` are all parsed through strict white-list `requireExactKeys`, and an empty `askDomains` is rejected so a missing field cannot silently weaken the egress policy. |
| Steer and input requests | Complete | `RunCommand.steer` no longer consumes a pending `pendingUserRequest` when delivered in `waiting_user`: the early-return in [`RunEngine.command`](file:///Users/letv_lzb/Documents/LeCodex/packages/run-engine/src/index.ts#L747-L760) routes the message through the durable mailbox, preserving the question until the user answers it. The Anthropic adapter surfaces a server-side `appendSteeringAsUserMessage` seam so future protocol-specific overrides (OpenAI `instructions` channel) have a deterministic place to land. |
| Second model adapter | Complete | [`packages/anthropic-model`](file:///Users/letv_lzb/Documents/LeCodex/packages/anthropic-model) implements `createAnthropicAgentModel` and `createAnthropicCompatibleAgentModel` with `x-api-key` + `anthropic-version: 2023-06-01` headers, HTTPS enforcement with loopback exemption, `AbortSignal.timeout`, mapped `tool_use` to `execute_command` / `request_user_input` / `request_network_egress` / `user_request`, versioned continuation envelope, cache-token folding, and one bounded malformed-JSON retry. A `RUN_LIVE_GOLDEN=1`-gated baseline test is wired to the same golden fixture the OpenAI adapter already runs against. |
| Operations documentation | Complete | [`operations-runbook.md`](operations-runbook.md) covers backup (PostgreSQL `pg_dump` + Artifact tar), recovery (pg-boss `lecoding-run-recovery-scan` + manual restore sequence + failure-mode table), upgrade (`pnpm build` + auto schema migration of all 10 `*_SCHEMA_SQL` constants + rollback path), and cleanup (daily 7-day retention, `discard` idempotency, manual worktree cleanup with Git-path revalidation). All commands reference real table names (`run_engine_runs`, `run_events`, `run_engine_artifacts`, `pgboss.job`) and real schema sources. |

## Verification baseline

- `pnpm typecheck`: **14/14** workspace tasks passed.
- `pnpm test`: **394 passed + 2 skipped** across 77 files. The four known
  pre-existing failures remain parked under the user-approved Phase 0
  environment exception: two `docker-environment` daemon-backed cases and two
  `run-events` Postgres frozen-time drift cases. None of the four are
  introduced or affected by Phase 3 changes; they predate the `verifier`,
  `project-instructions`, `anthropic-model`, and RunEngine seam extensions
  used here.
- Focused Phase 3 suites:
  - `packages/project-instructions/test/loader.test.ts`: 9/9.
  - `packages/verifier/test/project-yaml-plan-provider.test.ts`: 11/11.
  - `packages/run-engine/test/project-instructions.test.ts`: 2/2.
  - `packages/run-engine/test/run-engine.test.ts`: 51/51 (the steering
    regression guard was tightened to assert the corrected semantics).
  - `packages/anthropic-model/test/agent-model.test.ts`: 19/19.
  - `packages/anthropic-model/test/steer-user-request-e2e.test.ts`: 2/2.
  - `packages/anthropic-model/test/client.test.ts`: 8/8.
  - `packages/anthropic-model/test/config.test.ts`: 5/5.
  - `packages/anthropic-model/test/run-engine-integration.test.ts`: 1/1.
  - `packages/anthropic-model/test/golden-task-executor.test.ts`: 2/2.
  - `packages/anthropic-model/test/live-agent-model-baseline.test.ts`: 0
    (gated by `RUN_LIVE_GOLDEN=1`; the suite is skipped without the env
    variable to honour the Phase 2 acceptance of not depending on a live
    provider).

## Live-model and live-isolation gates

The Anthropic baseline smoke is wired but not part of the default repository
run. Operators reproduce the Phase 2 acceptance by setting:

```bash
RUN_LIVE_GOLDEN=1 \
  ANTHROPIC_BASE_URL=https://api.anthropic.com \
  ANTHROPIC_API_KEY=... \
  ANTHROPIC_MODEL=claude-... \
  LECODING_MODEL_INPUT_USD_PER_MILLION=3 \
  LECODING_MODEL_OUTPUT_USD_PER_MILLION=15 \
  LECODING_GOLDEN_IMAGE=lecoding-sandbox:phase0 \
  npx vitest run packages/anthropic-model/test/live-agent-model-baseline.test.ts
```

The target-Linux isolation run remains the user-approved Phase 0 exception
and is not represented as production Linux evidence here either.

The final mapping is recorded in
[`phase-3-completion-audit.md`](phase-3-completion-audit.md).