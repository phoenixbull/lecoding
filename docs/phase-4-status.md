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
| `DesktopLocalEnvironment` desktop adapter | Complete | Wave 2 | [`packages/desktop-runner`](file:///Users/letv_lzb/Documents/LeCodex/packages/desktop-runner/src/index.ts) — `createDesktopRunEnvironment` wraps the Local environment with the desktop-only affordances the PRD § 15 calls out: `ApprovalGate` before `prepare` (host_full demands explicit danger acknowledgement), `KeepOrDiscardGate` before `dispose` (the gate's decision wins over caller-supplied outcome so user choices survive transport), `HostAccessLog` (`recordHostAccess` / `readHostAccessLog`) classifies writes inside vs outside the registered worktree root, and `StateObserver` emits a strict `awaiting_approval → prepared → awaiting_keep/discard → terminal` lifecycle. Satisfies the same `RunEnvironment` contract as the Docker / Local adapters so RunEngine stays adapter-agnostic. 16 tests pass. |
| Electron + React shell (Windows + macOS) | Skeleton complete | Wave 3 | [`apps/desktop`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/src/main/index.ts) — factory-shaped main process with the security baseline mandated by PRD § 10.1 (`nodeIntegration=false`, `contextIsolation=true`, `sandbox=true`, strict CSP forbidding remote sources / `unsafe-eval` / new windows / external navigation), one `ClientSdk` instance per session, IPC handler per documented channel that validates the sender and forwards to the SDK (strips stack traces so internals never leak to the Renderer). [`preload/index.ts`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/src/preload/index.ts) — narrow `contextBridge.exposeInMainWorld("lecoding", ...)` surface; raw `ipcRenderer` / `require` / `process` are deliberately absent. [`shared/ipc-contract.ts`](file:///Users/letv_lzb/Documents/LeCodex/apps/desktop/src/shared/ipc-contract.ts) — closed `IPC_CHANNELS` set with per-channel payload validators; the Renderer can only reach documented channels. 24 tests (7 contract + 10 main + 7 preload) pass. Renderer React UI wires to `window.lecoding.<channel>(payload)`; build pipeline (electron-builder / Forge) is the remaining Wave 3 step. |
| Phase 4 PRD forward dependencies | Intact | — | electron-builder / Forge packaging, native `safeStorage` / keytar backend for `SecureStore`, code signing + auto-update remain ahead. |

## Verification baseline

- `pnpm typecheck`: **20/20** workspace tasks passed.
- `pnpm test`: **566 passed + 2 skipped** across 90 files. The seven known
  failures remain parked under the user-approved Phase 0 environment
  exception: two `docker-environment` daemon-backed cases, two
  `run-events` Postgres frozen-time drift cases, and three
  `device-binding` wall-clock expiry cases. None are introduced by
  the Wave 1 / Wave 2 / Wave 2-desktop / Wave 3 shell / Wave 3 packaging work.
- Focused new suites:
  - `packages/secure-store/test/secure-store.test.ts`: 21/21.
  - `packages/secure-store/test/device-credential-store.test.ts`: 11/11.
  - `packages/client-sdk/test/client.test.ts`: 23/23.
  - `packages/device-binding/test/*.test.ts`: 23/23 (minus 3 wall-clock cases).
  - `packages/local-runner/test/environment.test.ts`: 7/7.
  - `packages/desktop-runner/test/desktop-runner.test.ts`: 16/16.
  - `apps/desktop/test/ipc-contract.test.ts`: 7/7.
  - `apps/desktop/test/main.test.ts`: 10/10.
  - `apps/desktop/test/preload.test.ts`: 7/7.
  - `apps/desktop/test/forge-config.test.ts`: 15/15.
  - `apps/desktop/test/sign.test.ts`: 11/11.
  - `apps/desktop/test/auto-update.test.ts`: 6/6.
  - `packages/policy/test/policy.test.ts`: network.askDomains cases pass.

## Remaining Phase 4 work

- **Wave 3 (closing):** Renderer React UI (the `window.lecoding.*` surface is
  the seam; React components consume it directly), native `safeStorage` /
  keytar backend for `SecureStore`, final end-to-end desktop smoke.
