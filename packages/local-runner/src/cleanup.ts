/**
 * Worktree cleanup with honest failure reporting.
 *
 * M2.3 requires that a failed cleanup leaves an observable residual path and
 * instructions for manual recovery. The alternative — logging a warning and
 * carrying on — leaves the user with a worktree they cannot see, holding disk
 * space and possibly a copy of their source, with no way to find it.
 *
 * So cleanup never "succeeds quietly after a failure". Either the path is gone,
 * or the caller gets a residual record naming the exact path, why removal
 * failed, and what to do. Residual records are surfaced to the UI and can be
 * forwarded to the server as `residual.path` events.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { RunnerProgressEvent } from "@lecoding/runner-protocol";

/** Why a path could not be removed. */
export type CleanupFailureReason =
  /** Removal threw; `detail` carries the OS error message. */
  | "removal_failed"
  /** The path still exists after removal returned without error. */
  | "still_present";

/** A path that survived cleanup and needs manual attention. */
export interface ResidualPath {
  runId: string;
  path: string;
  reason: CleanupFailureReason;
  /** OS-level detail, safe to show an operator. */
  detail: string;
  /** What the user should do about it. */
  recovery: string;
  recordedAt: string;
}

export interface CleanupOptions {
  /** Injected clock so residual records are deterministic in tests. */
  now(): string;
  /** Removes a path. Injected so tests can simulate a stubborn directory. */
  remove?(path: string): Promise<void>;
  /** Checks existence. Injected for the same reason. */
  exists?(path: string): boolean;
}

export interface CleanupResult {
  /** True only when the path is confirmed gone. */
  cleaned: boolean;
  /** Present whenever cleanup did not remove the path. */
  residual?: ResidualPath;
}

/**
 * Removes a Run's worktree, reporting a residual record when it cannot.
 *
 * Safe to call repeatedly: a path that is already gone is a success, which is
 * what makes keep/discard idempotent across a reconnect or a restart.
 */
export async function cleanupWorktree(
  input: { runId: string; path: string },
  options: CleanupOptions
): Promise<CleanupResult> {
  const exists = options.exists ?? ((path: string) => existsSync(path));
  const remove = options.remove ?? ((path: string) => rm(path, { recursive: true, force: true }));

  if (!exists(input.path)) {
    return { cleaned: true };
  }

  try {
    await remove(input.path);
  } catch (error) {
    return {
      cleaned: false,
      residual: buildResidual(input, "removal_failed", describe(error), options.now())
    };
  }

  // Verify rather than trust: a `force` removal can leave entries behind on a
  // locked file or a busy mount, and reporting success then would be a lie.
  if (exists(input.path)) {
    return {
      cleaned: false,
      residual: buildResidual(
        input,
        "still_present",
        "The path still exists after removal completed",
        options.now()
      )
    };
  }

  return { cleaned: true };
}

/** Projects a residual record onto the upward progress event contract. */
export function residualProgressEvent(residual: ResidualPath): RunnerProgressEvent {
  // The reason and recovery instructions are collapsed into one line because
  // the event contract is deliberately closed and stable.
  return {
    type: "residual.path",
    runId: residual.runId,
    path: residual.path,
    reason: `${residual.reason}: ${residual.detail} — ${residual.recovery}`
  };
}

function buildResidual(
  input: { runId: string; path: string },
  reason: CleanupFailureReason,
  detail: string,
  recordedAt: string
): ResidualPath {
  return {
    runId: input.runId,
    path: input.path,
    reason,
    detail,
    recovery:
      reason === "still_present"
        ? "Close any program using this folder, then delete it manually."
        : "Check the folder is not open in another program, then delete it manually.",
    recordedAt
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "Unknown cleanup failure";
}
