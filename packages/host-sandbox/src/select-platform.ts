/**
 * Platform selection for the OS sandbox.
 *
 * The chosen adapter reports what it actually enforces; this module never
 * upgrades a weaker level to look like a stronger one. A Linux host gets an
 * adapter that reports `unsupported` for the fenced tiers, so a Run asking for
 * local execution fails closed instead of running unconfined while the UI
 * claims otherwise.
 */

import type { FileAccessScope } from "@lecoding/contracts";
import { createHostSandbox, type EnforcementLevel, type HostSandbox } from "./host-sandbox.js";
import { createPathFence, type PathFence } from "./path-fence.js";
import { createSeatbeltSandbox, type SeatbeltSandboxOptions } from "./seatbelt-sandbox.js";
import { createWindowsSandbox, type WindowsSandboxOptions } from "./windows-sandbox.js";

export interface SelectHostSandboxOptions {
  /** Defaults to `process.platform`; injectable for tests. */
  platform?: NodeJS.Platform;
  fence?: PathFence;
  seatbelt?: SeatbeltSandboxOptions;
  windows?: WindowsSandboxOptions;
}

export function selectHostSandbox(options: SelectHostSandboxOptions = {}): HostSandbox {
  const platform = options.platform ?? process.platform;

  switch (platform) {
    case "darwin":
      return createSeatbeltSandbox(options.seatbelt ?? {});
    case "win32":
      return createWindowsSandbox(options.windows ?? {});
    default:
      return createUnsupportedSandbox(platform, options.fence);
  }
}

/**
 * Adapter for platforms Phase 4B does not target.
 *
 * Reporting `unsupported` (rather than falling back to the argv fence) is the
 * deliberate choice: silently offering a weaker guarantee on an untested
 * platform is how a "supported" tier becomes a false claim.
 */
export function createUnsupportedSandbox(
  platform: NodeJS.Platform,
  fence?: PathFence
): HostSandbox {
  const tiers: Record<FileAccessScope, EnforcementLevel> = {
    workspace_only: "unsupported",
    selected_directories: "unsupported",
    host_full: "unsupported"
  };
  return createHostSandbox({
    fence: fence ?? createPathFence(),
    platform,
    tiers,
    detail:
      `Phase 4B does not provide a Local Runner sandbox for "${platform}". ` +
      "Local execution is refused rather than run without confinement."
  });
}
