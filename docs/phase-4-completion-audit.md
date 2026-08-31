# Phase 4 Completion Audit

Updated: 2026-08-31

This audit records what was closed during the Phase 4-A bridge work and
identifies the Phase 4-A and 4-B tasks that remain in front of the project.
The bridge work focused on the runtime consumer for the
project-declared `protectedPaths` field that Phase 3 surfaced through
`VerificationPlanProvider.loadProjectConfig`. The remaining Phase 4-A and
4-B tasks depend on environment-specific tooling and signing pipelines and
are listed below as the next scope rather than as Phase 4-A bridge work.

| V3 Phase 4 task | Result | Authoritative evidence |
|---|---|---|
| Runtime consumer for project-declared `protectedPaths` (`protected_file_write` gated by user approval) | Proven | New [`packages/project-policy-globs`](file:///Users/letv_lzb/Documents/LeCodex/packages/project-policy-globs) matcher handles the `*` / `**` operators the YAML loader already advertises, with strict project-relative validation (rejects empty strings, backslashes, null bytes, leading `/`, Windows drive letters, and `..` escapes). [`PolicyEngine`](file:///Users/letv_lzb/Documents/LeCodex/packages/policy/src/index.ts#L78-L92) accepts the matcher via a new `protectedPaths` DI option and returns `decision: "ask"` for any `protected_file_write` whose realpath matches a project glob, in every approval mode. The fixed-deny paths (credentials, host-control sockets) take precedence so an attacker cannot lift `.env` out of the deny list by listing it in the project rules. |
| Electron + React shell (Windows + macOS) reusing Client SDK and core UI | Not started | Pending; depends on Electron builder and code-signing pipelines that are outside the current session. The existing [`packages/client-sdk`](../packages/client-sdk) and [`packages/contracts`](../packages/contracts) are the seam PC clients reuse. |
| Device binding (browser identity proof, device code exchange, revocation) | Not started | Pending; the `/api/v1/devices/*` endpoints and the local `device-codes`/`device-credentials` tables belong to Phase 4-A and are not part of the bridge work. |
| `DesktopLocalEnvironment` adapter passing the `ServerDockerEnvironment` interface contract | Not started | Pending; requires the local worktree/sandbox seam and the Local Runner process that the bridge work does not touch. |
| Local worktree/sandbox with keep/discard, cancellation, and recovery | Not started | Pending; the server-side `GitWorkspace` is the seam to mirror locally and is unchanged by the bridge work. |
| OS keychain integration for the Local Runner | Not started | Pending; environment-specific. |
| Code signing and auto-update pipelines | Not started | Pending; environment-specific. |
| Runtime consumer for `network.askDomains` surfaced by `loadProjectConfig` | Not started | Pending; the YAML parser already returns the list, the next phase wires it through `PolicyEngine.networkEgress`. |

## Final verification gate

- `pnpm typecheck`: **15/15** workspace tasks passed (the new
  `project-policy-globs` package compiles cleanly and is part of the
  workspace).
- `pnpm test`: **414 passed + 2 skipped** across 78 files; the four
  known failures remain parked under the user-approved Phase 0
  environment exception.
- Focused Phase 4-A bridge suites all green:
  - `packages/project-policy-globs/test/matcher.test.ts`: 16/16.
  - `packages/policy/test/policy.test.ts`: 13/13 (the four new
    `Project protectedPaths` cases prove the runtime contract).
  - `packages/policy/test/adversarial-eval.test.ts`: 2/2.

## Limitations carried forward

- The bridge work only closes the protected-path side of the
  `loadProjectConfig` projection. The matching `network.askDomains`
  consumer is left for the next Phase 4 pass; the loader already
  returns it and the policy engine already has the `network_egress`
  capability hook for it.
- `protected_file_write` is gated when the project declares a glob,
  but the workspace sandbox that actually performs the file write
  still has to surface the realpath through `policy.authorize` before
  the protection is end-to-end. The bridge work hardens the policy
  seam; the workspace wiring is unchanged.
- Phase 4-A's Electron UI and Phase 4-B's Local Runner work remain
  the dominant scope of the phase and are not represented as
  evidence here.