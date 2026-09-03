# Phase 4 Status

Updated: 2026-09-02

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
| `DesktopLocalEnvironment` desktop adapter | Complete | Wave 2 | [`packages/desktop-runner`](file:///Users/letv_lzb/Documents/LeCodex/packages/desktop-runner/src/index.ts) — `createDesktopRunEnvironment` wraps the Local environment with the desktop-only affordances the PRD § 15 calls out: `ApprovalGate` before `prepare` (host_full demands explicit danger acknowledgement), `KeepOrDiscardGate` before `dispose` (the gate's decision wins over caller-supplied outcome so user choices survive transport), `HostAccessLog` (`recordHostAccess` / `readHostAccessLog`) classifies writes inside vs outside the registered worktree root, and `StateObserver` emits a strict `awaiting_approval → prepared → awaiting_keep/discard → terminal` lifecycle. Satisfies the same `RunEnvironment` contract as the Docker / Local adapters so RunEngine stays adapter-agnostic. 16 tests pass. |
| Shared Run console controller + Web/DOM consumers | Complete | Wave 3 | [`packages/run-controller`](file:///Users/letv_lzb/Documents/LeCodex/packages/run-controller/src/index.ts) — `createRunConsoleController` owns the Run state semantics extracted from the former 1080-line `apps/web/src/main.ts` and publishes immutable `RunConsoleState` snapshots. It depends only on two ports, `RunGateway` (capabilities) and `RunEventSource` (events), so Web HTTP/SSE and Desktop IPC are interchangeable transports. [`packages/presentation`](file:///Users/letv_lzb/Documents/LeCodex/packages/presentation/src/index.ts) holds the zero-DOM projection layer and the SSE orchestration (cursor resume, `sequence` de-duplication, reconnect, terminal hand-off). 95 tests (50 controller + 12 reconnect + 25 presentation + 8 run-stream) pass. |
| Electron + React shell (Windows + macOS) | Complete (code path); target-platform GUI smoke pending | Wave 3 | [`apps/desktop/src/main/electron.ts`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/src/main/electron.ts) — the production bootstrap that previously did not exist, so the packaged app could not start at all. `main/index.ts` now mounts the real preload (it was `preload: undefined`), registers 24 typed IPC channels, and holds SSE in [`stream-broker.ts`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/src/main/stream-broker.ts) because the Renderer CSP is `connect-src 'self'` and credentials must never reach it. `shared/ipc-contract.ts` adds `PUSH_CHANNELS` (`runs.event` / `runs.streamState` / `session.credentialState`); preload exposes only three named subscription functions, never `ipcRenderer.on` itself. The React 19 + Vite renderer (16 components across five screens) renders immutable state through `useSyncExternalStore` and owns no Run semantics. 177 desktop tests pass. |
| Native `safeStorage` backend for `SecureStore` | Complete | Wave 3 | [`safe-storage-store.ts`](file:///Users/letv_lzb/Documents/LeCodex/packages/secure-store/src/safe-storage-store.ts) wraps Electron `safeStorage` as a cipher (ciphertext persisted to a 0o600 JSON file); unavailability, OS lock, key corruption and migration failure throw `SecureStoreUnavailableError` rather than silently dropping credentials. [`select-backend.ts`](file:///Users/letv_lzb/Documents/LeCodex/packages/secure-store/src/select-backend.ts) resolves `safeStorage → encrypted file → throw`, never a silent in-memory fallback, and surfaces degradation through `session.credentialState` for a persistent UI banner. 51 secure-store tests pass. |
| Release architecture + asset verification | Complete (code path); signed/notarized artifacts pending | Wave 3 | [`architecture.ts`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/src/build/architecture.ts) parses Mach-O / PE / ELF headers in pure Node (no `lipo`, which Windows runners lack) and validates the runner, the packaged app, and every extracted ZIP / DMG / NUPKG including all `.node` addons. [`release-assets.ts`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/src/build/release-assets.ts) rejects duplicate file names (GitHub release assets are addressed by name and overwrite silently), missing versions, and macOS artifacts naming the wrong architecture. `maker-pkg` is removed: consumer releases ship Windows Squirrel plus macOS ZIP and DMG only. 65 build-config / architecture / release-asset tests pass. |
| Phase 4 PRD forward dependencies | Intact | — | Code signing, notarization, installed-package smoke on Windows/macOS, and signed-update rejection still need target-platform evidence. Certificates are an external dependency; unsigned builds publish only as pre-releases, and no gate is weakened to make CI pass. |

## Verification baseline

Superseded by [`m1-completion-summary.md`](m1-completion-summary.md):

- `pnpm typecheck`: **23/23** workspace tasks passed.
- `pnpm test`: **805 passed + 9 skipped + 0 failed** across 105 files
  (101 passed, 4 skipped). Every skip is an explicit environment gate —
  installed-app smoke, Docker daemon, live Anthropic baseline, and real
  PostgreSQL concurrency — not a business failure.

Focused evidence after M1:

| Suite | Result |
|---|---|
| `packages/run-controller/test` | 62/62 |
| `packages/presentation/test` | 34/34 |
| `packages/secure-store/test` | 43/43 |
| `apps/desktop/test` | 184 passed / 4 skipped |
| `apps/desktop/test/run-loop.integration.test.ts` (deep business E2E) | 3/3 |
| `apps/desktop/test/architecture.test.ts` | 25/25 |
| `apps/desktop/test/release-assets.test.ts` | 10/10 |
| `apps/worker/test` | 74/74 |

## Remaining Phase 4 work

- **Target-platform evidence:** run
  [`docs/evidence/desktop-m1-smoke-checklist.md`](evidence/desktop-m1-smoke-checklist.md)
  once per platform (Windows x64, macOS arm64, macOS x64) and archive the
  results under `docs/evidence/`.
- **Signing and notarization:** configure the Windows code-signing certificate
  and the Apple Developer ID secrets. Until then, tag-triggered builds fail
  under `LECODING_REQUIRE_SIGNED_ARTIFACTS=true`; release candidates can only
  go out as pre-releases.
- **Signed update rejection:** prove on real signed artifacts that
  electron-updater refuses a wrong signature or a wrong version; the unit-level
  contract is covered by `apps/desktop/test/auto-update.test.ts`.
- **Phase 4B (M2):** the Local Runner loop — WSS transport, three-tier host
  file access, and crash recovery — is untouched by M1.
