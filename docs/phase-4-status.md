# Phase 4 Status

Updated: 2026-08-31

Phase 4 starts the PC client and extension surface. The PRD splits it into
4A (Connected Desktop) and 4B (Local Runner). This document records what
was closed during the Phase 4-A bridge work plus the first two waves of
Phase 4-A forward work that landed after the initial bridge.

## Wave plan (Phase 4-A)

Phase 4-A is split into three dependency-ordered waves:

- **Wave 1 — server-only foundation.** Pieces the PC client will consume
  but that can be built and tested entirely on the server side: the
  `network.askDomains` runtime consumer, device binding (service + HTTP +
  Postgres store + client SDK surface), and the local worktree/sandbox
  adapter behind the `RunEnvironment` interface.
- **Wave 2 — adapter / OS integration.** Pieces that cross the OS
  boundary but still don't require an Electron build: OS keychain
  abstraction (with encrypted-file fallback) wired into the client SDK
  as the device credential store, and the `DesktopLocalEnvironment`
  adapter using the Wave-1 worktree.
- **Wave 3 — Electron shell + signing.** The actual desktop app,
  windowing, native safeStorage, code signing, and auto-update.

## Closed in Phase 4-A so far

| Task | Status | Wave | Current evidence |
|---|---|---|---|
| Runtime consumer for project-declared `protectedPaths` | Complete | Bridge | New [`packages/project-policy-globs`](file:///Users/letv_lzb/Documents/LeCodex/packages/project-policy-globs) matcher handles `*` / `**` with strict project-relative validation. [`PolicyEngine`](file:///Users/letv_lzb/Documents/LeCodex/packages/policy/src/index.ts#L78-L92) accepts it via `protectedPaths` DI and returns `decision: "ask"` for matching `protected_file_write` in every approval mode. Fixed-deny paths still take precedence. |
| Runtime consumer for `network.askDomains` | Complete | Wave 1 | [`PolicyEngine`](file:///Users/letv_lzb/Documents/LeCodex/packages/policy/src/index.ts) accepts `askDomains` DI (matcher or `string[]`). Any domain *not* on the allow list is forced to `ask` even in `full_access` mode. Placed between fixed-deny and project rules so an allow-list cannot override fixed-deny entries. Empty array means no restriction. |
| Device binding (server API + client SDK) | Complete | Wave 1 | [`packages/device-binding`](file:///Users/letv_lzb/Documents/LeCodex/packages/device-binding) — service (`issueCode` / `exchangeCode` / `authenticate` / `touchDevice` / `revokeDevice` / `listDevicesForUser`), in-memory store, Postgres store (`device_binding_codes` + `device_binding_devices` tables), and HTTP handler (4 endpoints). Base32 9-char one-time codes, SHA-256 hashed storage, `DeviceBindingError` with 7 error codes. [`packages/client-sdk`](file:///Users/letv_lzb/Documents/LeCodex/packages/client-sdk/src/index.ts) exposes `createDeviceCode` / `exchangeDeviceCode` / `listDevices` / `revokeDevice` / `deviceCredential`. 23 service+HTTP tests pass. |
| Local worktree / sandbox (`RunEnvironment` adapter) | Complete | Wave 1 | [`packages/local-runner`](file:///Users/letv_lzb/Documents/LeCodex/packages/local-runner/src/index.ts) — `createLocalRunEnvironment` implements `RunEnvironment` (prepare / perform / inspect / dispose). Uses `git worktree add --detach` for isolation, `child_process.spawn` with `BoundedOutputCapture`, `AbortSignal` (SIGTERM) + `execTimeoutMs` (SIGKILL) cancellation. executable limited to bare names (rejects absolute paths and `/`). 7 tests pass. |
| OS keychain abstraction + client SDK integration | Complete | Wave 2 | [`packages/secure-store`](file:///Users/letv_lzb/Documents/LeCodex/packages/secure-store/src/index.ts) — `SecureStore` interface (getItem / setItem / deleteItem / listKeys), `SecureStoreUnavailableError`, `createInMemorySecureStore()`. [`encrypted-file-store`](file:///Users/letv_lzb/Documents/LeCodex/packages/secure-store/src/encrypted-file-store.ts) — AES-256-GCM + PBKDF2-HMAC-SHA256 (200k iterations), atomic writes. [`device-credential-store`](file:///Users/letv_lzb/Documents/LeCodex/packages/secure-store/src/device-credential-store.ts) — namespace-prefixed device credential persistence with deviceId mismatch guard. Client SDK accepts `secureStore` option; exchangeDeviceCode persists, revokeDevice clears, `deviceCredential()` reads from store first. 32 tests (21 + 11) pass. |
| Phase 4 PRD forward dependencies | Intact | — | Electron shell, `DesktopLocalEnvironment` full adapter, native safeStorage / keytar, code signing + auto-update remain ahead. |

## Verification baseline

- `pnpm typecheck`: **18/18** workspace tasks passed.
- `pnpm test`: **489 passed + 2 skipped** across 83 files. The four known
  failures remain parked under the user-approved Phase 0 environment
  exception: two `docker-environment` daemon-backed cases and two
  `run-events` Postgres frozen-time drift cases. None are introduced by
  the Wave 1 / Wave 2 work.
- Focused new suites:
  - `packages/secure-store/test/secure-store.test.ts`: 21/21.
  - `packages/secure-store/test/device-credential-store.test.ts`: 11/11.
  - `packages/client-sdk/test/client.test.ts`: 23/23.
  - `packages/device-binding/test/*.test.ts`: 23/23.
  - `packages/local-runner/test/environment.test.ts`: 7/7.
  - `packages/policy/test/policy.test.ts`: network.askDomains cases pass.

## Remaining Phase 4 work

- **Wave 2 (in progress):** `DesktopLocalEnvironment` full adapter
  wiring the local-runner worktree behind a desktop-safe entry point
  with user-facing keep/discard UI hooks.
- **Wave 3:** Electron + React shell (Windows + macOS), native
  `safeStorage` / keytar backend for `SecureStore`, code signing and
  auto-update pipelines.
