# Phase 4 Completion Audit

Updated: 2026-09-02

This audit records what was closed during Phase 4-A bridge work plus
the Wave 1 and initial Wave 2 forward work that followed. Phase 4-A is
approached in three dependency-ordered waves (server-only → adapter/OS →
Electron/signing) so each wave can be fully tested and verified before
the next depends on it.

| V3 Phase 4 task | Result | Wave | Authoritative evidence |
|---|---|---|---|
| Runtime consumer for project-declared `protectedPaths` (`protected_file_write` gated by user approval) | Proven | Bridge | New [`packages/project-policy-globs`](file:///Users/letv_lzb/Documents/LeCodex/packages/project-policy-globs) matcher handles `*` / `**` with strict project-relative validation (rejects empty strings, backslashes, null bytes, leading `/`, Windows drive letters, `..` escapes). [`PolicyEngine`](file:///Users/letv_lzb/Documents/LeCodex/packages/policy/src/index.ts#L78-L92) accepts it via `protectedPaths` DI and returns `decision: "ask"` for matching `protected_file_write` in every approval mode. Fixed-deny paths take precedence. |
| Runtime consumer for `network.askDomains` surfaced by `loadProjectConfig` | Proven | Wave 1 | [`PolicyEngine`](file:///Users/letv_lzb/Documents/LeCodex/packages/policy/src/index.ts) accepts `askDomains` DI (`ProjectNetworkAllowListMatcher` or `string[]`). Domain not on the allow list is forced to `ask` even in `full_access` mode. Inserted between fixed-deny and project rules so allow-list cannot override fixed-deny. Empty array ≡ no restriction. |
| Device binding (browser identity proof, device code exchange, revocation) | Proven | Wave 1 | [`packages/device-binding`](file:///Users/letv_lzb/Documents/LeCodex/packages/device-binding/src/index.ts) — service with 6 operations, base32 9-char one-time codes, SHA-256 hashed storage, `DeviceBindingError` (7 codes). In-memory + Postgres stores (`device_binding_codes` + `device_binding_devices`). HTTP handler with 4 endpoints (POST code, POST exchange, GET list, DELETE revoke) — exchange intentionally skips bearer auth. Client SDK exposes `createDeviceCode` / `exchangeDeviceCode` / `listDevices` / `revokeDevice` / `deviceCredential`. 23 tests pass. |
| Local worktree/sandbox with keep/discard, cancellation, and recovery | Proven | Wave 1 | [`packages/local-runner`](file:///Users/letv_lzb/Documents/LeCodex/packages/local-runner/src/index.ts) — `createLocalRunEnvironment` implements `RunEnvironment` (prepare / perform / inspect / dispose). `git worktree add --detach` isolation, `child_process.spawn` with `BoundedOutputCapture`, `AbortSignal` (SIGTERM) + `execTimeoutMs` (SIGKILL). Bare-name executable restriction (rejects absolute paths and `/`). 7 tests pass. |
| OS keychain integration for the Local Runner | Proven (abstraction + file backend) | Wave 2 | [`packages/secure-store`](file:///Users/letv_lzb/Documents/LeCodex/packages/secure-store/src/index.ts) — `SecureStore` interface (getItem / setItem / deleteItem / listKeys), `SecureStoreUnavailableError`, `createInMemorySecureStore()`. [`encrypted-file-store.ts`](file:///Users/letv_lzb/Documents/LeCodex/packages/secure-store/src/encrypted-file-store.ts) — AES-256-GCM + PBKDF2-HMAC-SHA256 (200k iterations, 16-byte salt), 12-byte IV + 16-byte auth tag, atomic writes (tmp + rename). [`device-credential-store.ts`](file:///Users/letv_lzb/Documents/LeCodex/packages/secure-store/src/device-credential-store.ts) — namespace-prefixed persistence with deviceId mismatch guard and full field validation. Client SDK accepts `secureStore` option; exchange persists, revoke clears, `deviceCredential()` reads from store first. 32 tests (21 + 11) pass. |
| `DesktopLocalEnvironment` adapter passing the `ServerDockerEnvironment` interface contract | Proven | Wave 2 | [`packages/desktop-runner`](file:///Users/letv_lzb/Documents/LeCodex/packages/desktop-runner/src/index.ts) — `createDesktopRunEnvironment` wraps the Local environment with desktop-only affordances: `ApprovalGate` before `prepare` (host_full demands explicit danger acknowledgement), `KeepOrDiscardGate` before `dispose` (gate's decision wins over caller-supplied outcome so user choices survive transport), `HostAccessLog` (`recordHostAccess` / `readHostAccessLog`) classifies writes inside vs outside the registered worktree root, and `StateObserver` emits the strict lifecycle `awaiting_approval → prepared → awaiting_keep/discard → terminal`. The adapter satisfies the same `RunEnvironment` interface contract that ServerDockerEnvironment and LocalRunEnvironment satisfy, so RunEngine stays adapter-agnostic. 16 tests pass. |
| Framework-neutral Run console shared by Web and Desktop | Proven | Wave 3 | [`packages/run-controller`](file:///Users/letv_lzb/Documents/LeCodex/packages/run-controller/src/controller.ts) — `createRunConsoleController` owns the Run state semantics lifted out of the former 1080-line `apps/web/src/main.ts` and publishes immutable `RunConsoleState` snapshots; it depends only on `RunGateway` and `RunEventSource`, so Web HTTP/SSE and Desktop IPC are interchangeable transports. [`packages/presentation`](file:///Users/letv_lzb/Documents/LeCodex/packages/presentation/src/index.ts) carries the zero-DOM projection layer plus SSE orchestration (cursor resume, `sequence` de-duplication, reconnect, terminal hand-off). React subscribes through one `useSyncExternalStore` adapter and owns no Run semantics. 95 tests (50 controller + 12 reconnect + 25 presentation + 8 run-stream) pass. |
| Electron shell security seam (Windows + macOS) | Proven (code path); installed-app smoke pending | Wave 3 | [`apps/desktop/src/main/electron.ts`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/src/main/electron.ts) — the production bootstrap that did not previously exist, so the packaged app could not start. `main/index.ts` now mounts the real preload (it was `preload: undefined`), registers 24 typed IPC channels, and holds SSE in [`stream-broker.ts`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/src/main/stream-broker.ts) because the Renderer CSP is `connect-src 'self'` and credentials must never reach it. `ipc-contract.ts` adds `PUSH_CHANNELS`; preload exposes only `onRunEvent` / `onStreamState` / `onCredentialState`, never `ipcRenderer.on` itself. Renderer runs `nodeIntegration=false`, `contextIsolation=true`, `sandbox=true` with blocked popups and external navigation. 177 desktop tests pass; deep business E2E covers binding through keep/discard over a real Worker HTTP server. |
| Packaging configuration and release guardrails | Proven (code path); signed/notarized artifacts pending | Wave 3 | arm64 builds on `macos-15` and x64 on `macos-15-intel`, correcting the defect where an x64 job on an arm64 runner produced an arm64 binary under an x64 name. [`architecture.ts`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/src/build/architecture.ts) parses Mach-O / PE / ELF headers in pure Node (no `lipo`, which Windows runners lack) and checks the runner, the packaged app, and every extracted ZIP / DMG / NUPKG including all `.node` addons; universal binaries pass only when they contain the target architecture. [`release-assets.ts`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/src/build/release-assets.ts) rejects duplicate file names, missing versions, and wrong-architecture macOS artifacts. `maker-pkg` is removed — consumer releases ship Windows Squirrel plus macOS ZIP and DMG. Signing evidence (`codesign --verify` + `spctl --assess`, or `Get-AuthenticodeSignature`) is recorded per job and gates a stable release. Code signing, notarization, installed-package smoke and signed-update rejection remain unproven on target platforms and therefore cannot be marked complete. |
| Native `safeStorage` backend for `SecureStore` | Proven | Wave 3 | [`safe-storage-store.ts`](file:///Users/letv_lzb/Documents/LeCodex/packages/secure-store/src/safe-storage-store.ts) wraps Electron `safeStorage` as a cipher with the ciphertext persisted to a 0o600 JSON file; unavailability, OS lock, key corruption and migration failure throw `SecureStoreUnavailableError` rather than silently dropping credentials. [`select-backend.ts`](file:///Users/letv_lzb/Documents/LeCodex/packages/secure-store/src/select-backend.ts) resolves `safeStorage → encrypted file → throw` (never a silent in-memory fallback) and reports degradation through `session.credentialState`, which the Renderer shows as a persistent banner. 51 secure-store tests pass. |

## Final verification gate

The previous counts are superseded by
[`m1-completion-summary.md`](m1-completion-summary.md): `pnpm typecheck` passes
**23/23** workspace tasks; `pnpm test` passes **805 tests with 9 skips and 0
failures** across 105 files. Every skip is an explicit environment gate rather
than a parked failure. Real PostgreSQL concurrency, Docker, model provider,
installed-package smoke, signed installer, notarization and update evidence
remain separately classified environment gates. Passing pure configuration
tests is not sufficient to promote those items to “Proven”.

## Limitations carried forward

- The native `safeStorage` backend is proven by deterministic tests against a
  `SafeStorageLike` port, but a real OS keychain round-trip on Windows and
  macOS is still part of the installed-app smoke checklist.
- M1.3 separates deterministic no-GUI business coverage from shallow
  installed-app smoke. Windows and macOS each still need one real
  installation, binding, golden Run, restart recovery and device-revocation
  pass recorded under `docs/evidence/`; exhaustive business branches stay
  deterministic below the GUI.
- M1.4 consumer releases exclude MSI and PKG. macOS architectures now build on
  native hosted runners and are verified by parsing real Mach-O / PE headers
  inside the shipped archives, not only by filename checks. Enterprise
  deployment formats require a later explicit product decision and a separate
  workflow.
- Signing and notarization depend on certificates held outside the repository.
  Until they are configured, tag-triggered builds fail closed under
  `LECODING_REQUIRE_SIGNED_ARTIFACTS` and release candidates ship only as
  pre-releases.
- The `DesktopLocalEnvironment` adapter emits lifecycle events, and the desktop
  Renderer now renders approvals and keep/discard through the shared
  controller. Phase 4B (M2) still owns the Local Runner transport, three-tier
  host file access, and crash recovery.
- The `DesktopLocalEnvironment` adapter emits lifecycle events but the
  concrete Electron-side UI handlers (`ApprovalGate`, `KeepOrDiscardGate`)
  have not yet been implemented in the React View. The adapter remains the
  contract surface; the future UI binds to it without moving those semantics
  into hooks.
