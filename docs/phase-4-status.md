# Phase 4 Status

Updated: 2026-08-31

Phase 4 starts the PC client and extension surface. The PRD splits it into
4A (Connected Desktop) and 4B (Local Runner). The bulk of Phase 4 is
client-side work — Electron + React shell, device binding, OS keychain,
desktop adapter — and depends on environment-specific tooling and signing
pipelines that are intentionally outside the current session. This document
records what was closed during the Phase 4-A bridge work: the runtime
consumer for the project-level `protectedPaths` field that Phase 3 surfaced
through `VerificationPlanProvider.loadProjectConfig`.

## Closed in the Phase 4-A bridge

| Task | Status | Current evidence |
|---|---|---|
| Runtime consumer for project-declared `protectedPaths` | Complete | New [`packages/project-policy-globs`](file:///Users/letv_lzb/Documents/LeCodex/packages/project-policy-globs) matcher handles the `*` / `**` operators the YAML loader already advertises, with strict project-relative validation that rejects empty strings, backslashes, null bytes, leading `/`, Windows drive letters, and `..` escapes. [`PolicyEngine`](file:///Users/letv_lzb/Documents/LeCodex/packages/policy/src/index.ts#L78-L92) accepts the matcher via a new `protectedPaths` DI option and returns `decision: "ask"` for any `protected_file_write` whose realpath matches a project glob, in every approval mode. The fixed-deny paths (credentials, host-control sockets) still take precedence so an attacker cannot lift `.env` out of the deny list by listing it in the project rules. |
| Phase 4 PRD forward dependencies | Intact | The PC client scope documented in `AI_Coding_Agent_PRD与技术设计方案书v3.md` § 14 and § 15 (Electron + React shell, device binding, OS keychain, `DesktopLocalEnvironment`, Local Runner) is unchanged. Phase 4-A / 4-B work remains in front of the project and is recorded below as the next scope. |

## Verification baseline (bridge work)

- `pnpm typecheck`: **15/15** workspace tasks passed.
- `pnpm test`: **414 passed + 2 skipped** across 78 files. The four known
  failures remain parked under the user-approved Phase 0 environment
  exception: two `docker-environment` daemon-backed cases and two
  `run-events` Postgres frozen-time drift cases. None of the four are
  introduced or affected by the Phase 4-A bridge work; they predate the
  `project-policy-globs` package and the `PolicyEngine.protectedPaths`
  extension.
- Focused Phase 4-A bridge suites:
  - `packages/project-policy-globs/test/matcher.test.ts`: 16/16.
  - `packages/policy/test/policy.test.ts`: 13/13 (the four new
    `Project protectedPaths` cases prove the runtime contract).
  - `packages/policy/test/adversarial-eval.test.ts`: 2/2.

## Phase 4-A / 4-B remaining work

The PRD exit conditions that remain in front of the project:

- **Electron + React shell** that reuses `packages/contracts` and
  `packages/client-sdk` and is installable on Windows and macOS.
- **Device binding** end-to-end: browser-backed identity proof,
  one-time device code exchange, the `/api/v1/devices` surface, and the
  device-revocation path.
- **`DesktopLocalEnvironment` adapter** matching the
  `ServerDockerEnvironment` interface contract tests, plus the local
  worktree/sandbox that supports keep/discard, cancellation, and recovery
  without polluting the source checkout.
- **OS keychain** integration for credentials that the Local Runner holds
  on behalf of the server Worker.
- **Code signing and auto-update** pipelines for the desktop artefact.
- **Runtime consumer** for the project-level `network.askDomains`
  surfaced by `loadProjectConfig`: the YAML parser already returns the
  list, the next phase wires it through `PolicyEngine.networkEgress`.

The bridge work above does **not** touch any of these seams. It only
extends the policy package with a protected-path matcher that the Worker
process can already wire through the existing `PolicyEngineOptions`
constructor because the `PolicyEngine` itself is constructed outside
`RunEngine` and injected as a dependency.

The final mapping is recorded in
[`phase-4-completion-audit.md`](phase-4-completion-audit.md).