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
| Electron + React shell (Windows + macOS) reusing Client SDK and core UI | Not started | Wave 3 | Pending; depends on Electron builder and code-signing pipelines. The existing `packages/client-sdk` and `packages/contracts` are the seam PC clients reuse. |
| `DesktopLocalEnvironment` adapter passing the `ServerDockerEnvironment` interface contract | Not started (foundation done) | Wave 2 | The `local-runner` package provides the worktree + execution foundation. The desktop adapter layer (UI hooks, keep/discard dialogs, error surfacing) is still ahead. |
| Code signing and auto-update pipelines | Not started | Wave 3 | Pending; environment-specific. |
| Native `safeStorage` / keytar backend for `SecureStore` | Not started | Wave 3 | The `SecureStore` interface is ready; the Electron-native backend depends on the Wave 3 shell. |

## Final verification gate

- `pnpm typecheck`: **18/18** workspace tasks passed.
- `pnpm test`: **489 passed + 2 skipped** across 83 files. The four
  known failures remain parked under the user-approved Phase 0
  environment exception (docker daemon + Postgres frozen-time drift).
  None are introduced by Wave 1 / Wave 2 work.
- Focused suites all green:
  - `packages/secure-store/test/secure-store.test.ts`: 21/21.
  - `packages/secure-store/test/device-credential-store.test.ts`: 11/11.
  - `packages/client-sdk/test/client.test.ts`: 23/23.
  - `packages/device-binding/test/service.test.ts` + `http.test.ts`: 23/23.
  - `packages/local-runner/test/environment.test.ts`: 7/7.
  - `packages/policy/test/policy.test.ts`: includes network.askDomains cases.

## Limitations carried forward

- The `SecureStore` package ships with an `EncryptedFileSecureStore`
  backend (AES-256-GCM + PBKDF2 passphrase) rather than a native
  keychain. The `SecureStore` interface is designed so an Electron
  `safeStorage` / keytar adapter can drop in without changes to
  consumers. The native backend is Wave 3 scope.
- `DesktopLocalEnvironment` is not yet a single desktop-facing entry
  point. The `local-runner` package is the reusable foundation; the
  adapter that wires it behind UI keep/discard decisions and surfaces
  user-friendly errors is Wave 2 remaining work.
- Wave 3 (Electron shell, native keychain, code signing, auto-update)
  remains the dominant remaining scope of Phase 4-A.
