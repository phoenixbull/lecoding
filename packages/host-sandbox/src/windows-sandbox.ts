/**
 * Windows sandbox adapter.
 *
 * ## What this actually enforces
 *
 * This adapter does **not** create a Windows Job Object, and it does not
 * restrict filesystem access inside the kernel. Both would need native code —
 * `CreateProcess` with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` for an
 * AppContainer, or `CreateRestrictedToken` for a constrained token — and this
 * repository ships no native addon.
 *
 * Naming this file after a mechanism it does not use was the same category of
 * over-claim as reporting it in the docs, so it is stated plainly here and the
 * capability report carries the same wording the UI shows.
 *
 * What it does provide, and it is real:
 *
 * - The argv fence: a command naming a path that canonicalizes outside the
 *   grant is never created.
 * - Process-tree termination, so a cancelled Run cannot leave orphaned
 *   grandchildren holding the worktree (see `terminateProcessTree`).
 *
 * `argv_fence` is therefore the truthful enforcement level. Claiming `kernel`
 * would let the UI advertise a guarantee the OS is not providing, and would
 * make the macOS/Windows difference invisible to the person relying on it.
 */

import type { FileAccessScope } from "@lecoding/contracts";
import {
  createHostSandbox,
  type EnforcementLevel,
  type HostSandbox
} from "./host-sandbox.js";
import { createPathFence, type PathFence } from "./path-fence.js";

export interface WindowsSandboxOptions {
  fence?: PathFence;
  /** Overrides the platform label; tests use this to force the Windows path. */
  platform?: NodeJS.Platform;
}

export function createWindowsSandbox(options: WindowsSandboxOptions = {}): HostSandbox {
  const fence =
    options.fence ?? createPathFence({ caseInsensitive: true, platform: "win32" });

  const tiers: Record<FileAccessScope, EnforcementLevel> = {
    // Real but weaker than macOS Seatbelt: enforced at process creation, by
    // refusing the command rather than by the kernel denying the access.
    workspace_only: "argv_fence",
    selected_directories: "argv_fence",
    host_full: "acknowledged_unrestricted"
  };

  return createHostSandbox({
    fence,
    platform: options.platform ?? "win32",
    tiers,
    detail:
      "Windows refuses commands whose canonicalized paths escape the grant and " +
      "terminates the whole process tree on cancel, but applies no kernel-level " +
      "filesystem restriction: that needs a native AppContainer adapter. File " +
      "access here is best-effort compared with macOS Seatbelt, and a process " +
      "that reaches outside the grant by any route other than its arguments is " +
      "not stopped by the OS."
  });
}
