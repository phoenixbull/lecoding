/**
 * `@lecoding/host-sandbox` — OS-level file access enforcement for the Local
 * Runner (Phase 4B / M2.2).
 *
 * The three tiers are enforced here, at process creation, in the Runner
 * process. Desktop Main supplies a `FileAccessGrant` issued through OS-native
 * interaction; `PolicyEngine` continues to own fixed-deny and escalation
 * approval and deliberately does no filesystem isolation.
 *
 * The existing `ApprovalGate` and `HostAccessLog` in `@lecoding/desktop-runner`
 * are UX and audit affordances. They are NOT part of the enforcement path and
 * must not be cited as evidence that a tier is enforced.
 */

export {
  createFileAccessGrant,
  FileAccessGrantError,
  grantRoots,
  isFenced,
  minimalDirectorySet,
  parseFileAccessGrant,
  type CreateGrantInput,
  type FileAccessGrant
} from "./file-access-grant.js";

export {
  createPathFence,
  isCaseInsensitiveByDefault,
  looksLikePath,
  type PathFence,
  type PathFenceOptions,
  type PathFenceReason,
  type PathFenceRequest,
  type PathFenceVerdict,
  type PathViolation,
  type RealpathFn
} from "./path-fence.js";

export {
  createHostSandbox,
  createPlatformSandbox,
  SandboxViolationError,
  type EnforcementLevel,
  type HostSandbox,
  type PlatformSandboxOptions,
  type SandboxBaseOptions,
  type SandboxCapabilityReport,
  type SandboxSpawnPlan,
  type SandboxSpawnRequest,
  type SandboxWrapper
} from "./host-sandbox.js";

export {
  createSeatbeltSandbox,
  buildProfile,
  probeSeatbelt,
  type SeatbeltSandboxOptions
} from "./seatbelt-sandbox.js";

export {
  createJobObjectSandbox,
  type JobObjectSandboxOptions
} from "./job-object-sandbox.js";

export {
  createUnsupportedSandbox,
  selectHostSandbox,
  type SelectHostSandboxOptions
} from "./select-platform.js";

export {
  createAccessAuditLog,
  createMemoryAuditFileSystem,
  type AccessAuditLog,
  type AccessAuditLogOptions,
  type AuditFileSystem,
  type HostAccessAuditEntry,
  type HostAccessKind,
  type HostAccessOrigin
} from "./access-audit-log.js";
