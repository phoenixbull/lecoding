/**
 * Run-level file access authorization.
 *
 * A grant is the *only* thing that lets a Local Runner touch the host. It is
 * issued by Desktop Main through OS-native interaction — a directory picker for
 * `selected_directories`, a danger confirmation for `host_full` — and consumed
 * by the sandbox in the Runner process. The Runner never issues its own grant,
 * so a malicious or confused Runner cannot widen its own authority.
 *
 * The existing `ApprovalGate` in `@lecoding/desktop-runner` is deliberately NOT
 * part of this decision. It is a UX prompt and, per the M2 decision record, is
 * not evidence of enforcement: enforcement is what the OS sandbox does at
 * process creation time.
 */

import type { FileAccessScope } from "@lecoding/contracts";

/**
 * What one Run is allowed to touch on the host.
 *
 * Directories are stored already canonicalized: the grant records a decision
 * about real locations, and deferring canonicalization to the consumer would
 * let an alias (symlink, junction, case variant) sneak past a later comparison.
 */
export interface FileAccessGrant {
  runId: string;
  scope: FileAccessScope;
  /**
   * Canonical, minimal set of directories outside the worktree the Run may
   * access. Only meaningful for `selected_directories`; empty otherwise.
   */
  allowedDirectories: string[];
  /** Canonical path of the Run's managed worktree. Always permitted. */
  worktreePath: string;
  /** ISO timestamp of issuance, from an injected clock. */
  issuedAt: string;
  /**
   * Required for `host_full`: records that the user completed the OS-native
   * secondary confirmation. Its presence, not the scope alone, is what
   * authorizes unrestricted access.
   */
  dangerAcknowledgedAt?: string;
}

export class FileAccessGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileAccessGrantError";
  }
}

export interface CreateGrantInput {
  runId: string;
  scope: FileAccessScope;
  worktreePath: string;
  /**
   * Directories chosen through the OS picker. Canonicalized and reduced to a
   * minimal set before being stored.
   */
  selectedDirectories?: readonly string[];
  now(): string;
  /** Set only when the user completed the `host_full` danger confirmation. */
  dangerAcknowledged?: boolean;
  /**
   * Canonicalizes a directory path. Injected because canonicalization is async
   * and platform-specific; `createFileAccessGrant` itself stays synchronous and
   * therefore trivial to test.
   */
  canonicalize?: (path: string) => string;
}

/**
 * Builds a grant, enforcing the invariants the sandbox relies on.
 *
 * @throws {FileAccessGrantError} when the input is internally inconsistent —
 * for example `host_full` without a danger acknowledgement, or
 * `selected_directories` with nothing selected. Rejecting at issuance is what
 * keeps the sandbox from having to second-guess a grant later.
 */
export function createFileAccessGrant(input: CreateGrantInput): FileAccessGrant {
  const canonicalize = input.canonicalize ?? ((path: string) => path);
  const worktreePath = canonicalize(input.worktreePath);

  if (input.runId.trim() === "") {
    throw new FileAccessGrantError("A FileAccessGrant requires a runId");
  }
  if (worktreePath.trim() === "") {
    throw new FileAccessGrantError("A FileAccessGrant requires a worktreePath");
  }

  const grant: FileAccessGrant = {
    runId: input.runId,
    scope: input.scope,
    allowedDirectories: [],
    worktreePath,
    issuedAt: input.now()
  };

  switch (input.scope) {
    case "workspace_only": {
      // The worktree is the only root; anything selected is ignored rather than
      // silently widening the grant.
      return grant;
    }
    case "selected_directories": {
      const canonical = (input.selectedDirectories ?? []).map(canonicalize);
      const minimal = minimalDirectorySet(canonical.filter((path) => path !== worktreePath));
      if (minimal.length === 0) {
        throw new FileAccessGrantError(
          "selected_directories requires at least one directory outside the worktree"
        );
      }
      return { ...grant, allowedDirectories: minimal };
    }
    case "host_full": {
      if (input.dangerAcknowledged !== true) {
        throw new FileAccessGrantError(
          "host_full requires the user to complete the danger acknowledgement"
        );
      }
      return { ...grant, dangerAcknowledgedAt: input.now() };
    }
    default:
      throw new FileAccessGrantError(`Unknown file access scope: ${String(input.scope)}`);
  }
}

/**
 * Reduces directories to the minimal set that covers the same area.
 *
 * Two reasons this matters: a nested directory (`/a` inside `/a/b`) grants
 * nothing new but doubles the comparison cost and the audit surface, and
 * duplicates would make "how much did the user authorize?" ambiguous in the UI.
 */
export function minimalDirectorySet(directories: readonly string[]): string[] {
  // Strip trailing separators first: canonical paths have none, and leaving one
  // would store two spellings of the same directory in the grant.
  const normalized = directories.map((path) => path.replace(/[\\/]+$/u, "") || "/");
  const unique = [...new Set(normalized)];
  // Sort by length so a parent is always considered before its children.
  const sorted = [...unique].sort((left, right) => left.length - right.length);
  const kept: string[] = [];
  for (const candidate of sorted) {
    const covered = kept.some((root) => isSameOrNested(candidate, root));
    if (!covered) {
      kept.push(candidate);
    }
  }
  return kept.sort();
}

/**
 * The roots a command may touch, or an empty list for `host_full`.
 *
 * Empty means "unrestricted" rather than "nothing": `host_full` is the absence
 * of a fence, authorized by the danger acknowledgement.
 */
export function grantRoots(grant: FileAccessGrant): string[] {
  switch (grant.scope) {
    case "workspace_only":
      return [grant.worktreePath];
    case "selected_directories":
      return [grant.worktreePath, ...grant.allowedDirectories];
    case "host_full":
      return [];
    default:
      return [grant.worktreePath];
  }
}

/**
 * True when the sandbox should fence commands for this grant.
 *
 * Caller obligation: when this returns false, do not call the fence with an
 * empty root list. An empty list means "unrestricted", and a fence asked to
 * judge against no roots would refuse everything, silently turning an
 * authorized `host_full` Run into a Run that cannot run anything.
 */
export function isFenced(grant: FileAccessGrant): boolean {
  return grant.scope !== "host_full";
}

/**
 * Validates a grant read back from persistence.
 *
 * A persisted grant is untrusted input: it may come from an older version or a
 * modified file. Failing closed here means a bad grant stops the Run instead of
 * silently degrading to unrestricted access.
 */
export function parseFileAccessGrant(value: unknown): FileAccessGrant {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FileAccessGrantError("FileAccessGrant must be an object");
  }
  const record = value as Record<string, unknown>;
  const scope = record["scope"];
  if (scope !== "workspace_only" && scope !== "selected_directories" && scope !== "host_full") {
    throw new FileAccessGrantError("FileAccessGrant has an invalid scope");
  }
  const runId = record["runId"];
  const worktreePath = record["worktreePath"];
  const issuedAt = record["issuedAt"];
  if (typeof runId !== "string" || runId.length === 0) {
    throw new FileAccessGrantError("FileAccessGrant requires a runId");
  }
  if (typeof worktreePath !== "string" || worktreePath.length === 0) {
    throw new FileAccessGrantError("FileAccessGrant requires a worktreePath");
  }
  if (typeof issuedAt !== "string" || issuedAt.length === 0) {
    throw new FileAccessGrantError("FileAccessGrant requires an issuedAt timestamp");
  }

  const grant: FileAccessGrant = { runId, scope, worktreePath, issuedAt, allowedDirectories: [] };

  const allowedDirectories = record["allowedDirectories"];
  if (allowedDirectories !== undefined) {
    if (!Array.isArray(allowedDirectories) || allowedDirectories.some((e) => typeof e !== "string")) {
      throw new FileAccessGrantError("FileAccessGrant allowedDirectories must be an array of strings");
    }
    grant.allowedDirectories = [...(allowedDirectories as string[])];
  }
  const acknowledgedAt = record["dangerAcknowledgedAt"];
  if (typeof acknowledgedAt === "string") {
    grant.dangerAcknowledgedAt = acknowledgedAt;
  }

  if (scope === "host_full" && grant.dangerAcknowledgedAt === undefined) {
    throw new FileAccessGrantError("A host_full grant must record its danger acknowledgement");
  }
  if (scope === "selected_directories" && grant.allowedDirectories.length === 0) {
    throw new FileAccessGrantError("A selected_directories grant must allow at least one directory");
  }
  if (scope === "workspace_only" && grant.allowedDirectories.length > 0) {
    throw new FileAccessGrantError("A workspace_only grant must not allow extra directories");
  }
  return grant;
}

function isSameOrNested(candidate: string, root: string): boolean {
  const normalizedRoot = root.replace(/[\\/]+$/u, "");
  return candidate === normalizedRoot || candidate.startsWith(normalizedRoot + "/");
}
