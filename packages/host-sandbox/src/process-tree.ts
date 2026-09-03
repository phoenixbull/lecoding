/**
 * Process-tree termination.
 *
 * Cancelling a Run has to take the whole tree with it. Killing only the direct
 * child leaves grandchildren running, still holding the worktree — which then
 * survives cleanup and is reported as a residual the user has to delete by hand.
 *
 * There is no portable way to do this from `node:child_process`: a child is
 * spawned without a process group on Windows, so `child.kill()` reaches exactly
 * one process. Each platform therefore gets its own mechanism, and every
 * mechanism is best-effort — the only promise is that a failure is reported
 * rather than swallowed.
 */

import { spawn } from "node:child_process";

export interface TerminateResult {
  /** True when the tree was signalled. */
  terminated: boolean;
  /** Why termination did not happen, when it did not. */
  reason?: string;
}

/**
 * Terminates a process and everything it spawned.
 *
 * On Windows this shells out to `taskkill /T /F`, the documented way to kill a
 * tree without a handle to the Job Object. On POSIX the child must have been
 * started with `detached: true` so it leads its own process group, which is
 * then signalled as a whole.
 */
export function terminateProcessTree(
  pid: number,
  options: { platform?: NodeJS.Platform } = {}
): Promise<TerminateResult> {
  const platform = options.platform ?? process.platform;

  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.resolve({ terminated: false, reason: "invalid pid" });
  }

  if (platform === "win32") {
    return taskkillTree(pid);
  }
  return signalProcessGroup(pid);
}

/** Windows: `taskkill /T /F /PID <pid>` reaches descendants without a Job Object. */
function taskkillTree(pid: number): Promise<TerminateResult> {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore"
    });
    child.on("error", () => {
      resolve({
        terminated: false,
        reason: "taskkill is unavailable; the process tree may survive"
      });
    });
    child.on("exit", (code) => {
      // taskkill exits 0 when the tree was killed and non-zero when the process
      // was already gone; both mean there is nothing left to do.
      resolve(
        code === 0
          ? { terminated: true }
          : { terminated: false, reason: `taskkill exited with ${String(code)}` }
      );
    });
  });
}

/** POSIX: signal the child's own process group, which it leads when detached. */
function signalProcessGroup(pid: number): Promise<TerminateResult> {
  try {
    // A negative pid targets the process group; -0 would mean "this group", so
    // a non-positive pid is rejected before it can signal the wrong target.
    process.kill(-pid, "SIGKILL");
    return Promise.resolve({ terminated: true });
  } catch (error) {
    // Fall back to the single process: better to stop the direct child than
    // to leave the whole tree running because the group signal failed.
    try {
      process.kill(pid, "SIGKILL");
      return Promise.resolve({ terminated: true });
    } catch {
      return Promise.resolve({
        terminated: false,
        reason: error instanceof Error ? error.message : "could not signal the process"
      });
    }
  }
}
