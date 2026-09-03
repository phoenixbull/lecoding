/**
 * Windows sandbox adapter.
 *
 * ## What this does and does not enforce
 *
 * Kernel-level filesystem restriction on Windows requires creating the process
 * with an AppContainer or a restricted token, both of which need native code
 * (`CreateProcess` with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`). This
 * repository ships no native addon, so this adapter **does not** provide it and
 * says so in its capability report.
 *
 * What it does provide, honestly:
 *
 * - The argv fence, which is real: a command naming an out-of-scope path is
 *   never created.
 * - Process-tree containment, so cancelling a Run cannot leave orphaned
 *   grandchildren holding the worktree.
 *
 * Claiming `kernel` here would be a lie that outlives this file, because the UI
 * would show a guarantee the OS does not provide. `argv_fence` is the truthful
 * level, and `select-platform` surfaces it so the user can see the difference
 * from macOS.
 */

import type { FileAccessScope } from "@lecoding/contracts";
import {
  createHostSandbox,
  type EnforcementLevel,
  type HostSandbox
} from "./host-sandbox.js";
import { createPathFence, type PathFence } from "./path-fence.js";

export interface JobObjectSandboxOptions {
  fence?: PathFence;
}

export function createJobObjectSandbox(options: JobObjectSandboxOptions = {}): HostSandbox {
  const fence = options.fence ?? createPathFence({ caseInsensitive: true, platform: "win32" });

  const tiers: Record<FileAccessScope, EnforcementLevel> = {
    // Real, but weaker than macOS: enforced at process creation by refusing a
    // command whose canonicalized paths escape the grant.
    workspace_only: "argv_fence",
    selected_directories: "argv_fence",
    host_full: "acknowledged_unrestricted"
  };

  return createHostSandbox({
    fence,
    platform: "win32",
    tiers,
    detail:
      "Windows confines the process tree and refuses commands whose paths escape " +
      "the grant, but cannot restrict arbitrary filesystem access without a native " +
      "AppContainer adapter. Kernel-level file isolation is not provided here; " +
      "macOS Seatbelt enforces more strongly than this host does."
  });
}
