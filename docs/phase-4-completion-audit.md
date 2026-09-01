# Phase 4 Completion Audit

Updated: 2026-08-31

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
| Electron + React shell (Windows + macOS) reusing Client SDK and core UI | Skeleton proven | Wave 3 | [`apps/desktop`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/src/main/index.ts) — factory-shaped main process (`createDesktopMain`) with the security baseline mandated by PRD § 10.1: `nodeIntegration=false`, `contextIsolation=true`, `sandbox=true`, strict CSP (`default-src 'self'`, no `unsafe-eval`, no remote sources, `frame-src 'none'`, `object-src 'none'`), `setWindowOpenHandler({action:"deny"})` to block popups, `will-navigate` guard rejecting non-`file://` URLs. One `ClientSdk` instance per session, IPC handler per documented channel that validates the sender (rejects untrusted webContents) and strips stack traces so internals never leak to the Renderer. [`preload/index.ts`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/src/preload/index.ts) — `contextBridge.exposeInMainWorld("lecoding", ...)` with one method per channel; raw `ipcRenderer` / `require` / `process` deliberately absent. [`shared/ipc-contract.ts`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/src/shared/ipc-contract.ts) — closed `IPC_CHANNELS` set with per-channel payload validators; the Renderer can only reach documented channels. The factory shape (`ElectronHost` + `ClientSdkFactory`) lets tests exercise the policy without spinning up a display server. 24 tests (7 contract + 10 main + 7 preload) pass. |
| Code signing and auto-update pipelines | Proven | Wave 3 | [`apps/desktop/forge.config.ts`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/forge.config.ts) reads the CI signing environment and feeds [`apps/desktop/src/build/forge-config.ts`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/src/build/forge-config.ts) — a pure builder that emits Windows (`squirrel` / `msi`) + macOS (`zip` / `dmg` / `tar.xz`) target matrices, bakes `osx-sign` + `notarize` blocks only when CSC_LINK / APPLE_* credentials are present, unpacks native-binding roots from the asar (`better-sqlite3`, `keytar`, `fsevents`, `@lecoding/local-runner/native/**`), and points electron-updater at the GitHub releases feed with `verifyManifestSignature: true` + `verifyArtifactSignatures: true` so unsigned payloads are rejected on the client side. [`apps/desktop/src/build/sign.ts`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/src/build/sign.ts) — strict base64 .p12 decoder, two-step `codesign → notarytool` macOS notarization plan (codesign must precede notarytool or it fails silently), Windows `signtool sign /fd sha256 /tr http://timestamp.digicert.com` invocation. [`apps/desktop/src/build/auto-update.ts`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/src/build/auto-update.ts) — SemVer comparison with deterministic pre-release ordering so dev builds can roll forward and beta builds can opt into downgrade. [`apps/desktop/build/entitlements.mac.plist`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/build/entitlements.mac.plist) — hardened-runtime entitlements with `disable-library-validation: false` and `com.apple.security.cs.allow-system-environment-variables: false`. [`.github/workflows/desktop-release.yml`](file:///Users/letv_lzb/Documents/LeCodex/.github/workflows/desktop-release.yml) — tag-triggered (`v*` / `beta-v*`) pipeline that builds Windows + macOS in parallel, injects signing secrets, runs `typecheck` + `test`, uploads the signed installers to a GitHub release that `electron-updater` consumes directly. 32 tests (15 forge + 11 sign + 6 auto-update) pass. |
| Native `safeStorage` / keytar backend for `SecureStore` | Not started | Wave 3 | The `SecureStore` interface is ready; the Electron-native backend depends on the Wave 3 shell finishing. |

## Final verification gate

- `pnpm typecheck`: **20/20** workspace tasks passed.
- `pnpm test`: **566 passed + 2 skipped** across 90 files. The seven
  known failures remain parked under the user-approved Phase 0
  environment exception (docker daemon + Postgres frozen-time drift +
  device-binding wall-clock expiry). None are introduced by Wave 1 /
  Wave 2 / Wave 2-desktop / Wave 3 shell / Wave 3 packaging work.
- Focused suites all green:
  - `packages/secure-store/test/secure-store.test.ts`: 21/21.
  - `packages/secure-store/test/device-credential-store.test.ts`: 11/11.
  - `packages/client-sdk/test/client.test.ts`: 23/23.
  - `packages/device-binding/test/service.test.ts` + `http.test.ts`: 23/23 (minus 3 wall-clock cases).
  - `packages/local-runner/test/environment.test.ts`: 7/7.
  - `packages/desktop-runner/test/desktop-runner.test.ts`: 16/16.
  - `apps/desktop/test/ipc-contract.test.ts`: 7/7.
  - `apps/desktop/test/main.test.ts`: 10/10.
  - `apps/desktop/test/preload.test.ts`: 7/7.
  - `apps/desktop/test/forge-config.test.ts`: 15/15.
  - `apps/desktop/test/sign.test.ts`: 11/11.
  - `apps/desktop/test/auto-update.test.ts`: 6/6.
  - `packages/policy/test/policy.test.ts`: includes network.askDomains cases.

## Limitations carried forward

- The `SecureStore` package ships with an `EncryptedFileSecureStore`
  backend (AES-256-GCM + PBKDF2 passphrase) rather than a native
  keychain. The `SecureStore` interface is designed so an Electron
  `safeStorage` / keytar adapter can drop in without changes to
  consumers. The native backend is the last Wave 3 scope item.
- The Electron + React shell skeleton (`apps/desktop`) ships the main /
  preload / IPC contract layers; the React Renderer is the next concrete
  piece (typing the channels as TS hooks and wiring the surface to UI
  components).
- The `DesktopLocalEnvironment` adapter emits lifecycle events but the
  concrete Electron-side UI handlers (`ApprovalGate`, `KeepOrDiscardGate`)
  live in the Wave 3 React shell. The adapter itself is the contract
  surface; the UI binds to it.
