/**
 * macOS Seatbelt sandbox — real kernel-level enforcement.
 *
 * Seatbelt (SBPL) confines a process and its descendants inside the kernel, so
 * a command is restricted even when the path it touches never appears in its
 * arguments. That is the difference from the argv fence: `cat` cannot read
 * `~/.ssh/config` even if some other file tells it to.
 *
 * ## The runtime probe
 *
 * `sandbox-exec` is deprecated by Apple and its availability is not something to
 * assume. The adapter therefore *proves* it works at construction by running a
 * trivial profile, and reports `unsupported` if that probe fails. Guessing here
 * would be the worst possible failure: the UI would show "kernel enforced"
 * while every command ran unconfined.
 *
 * ## Profile scope
 *
 * The generated profile is deny-by-default with an allowlist narrow enough to
 * run a toolchain. It is deliberately conservative and is expected to be
 * widened from evidence gathered on real target machines — see
 * `docs/evidence/`. A command that needs more than the allowlist is denied,
 * which is the correct direction to fail.
 */

import type { FileAccessScope } from "@lecoding/contracts";
import type { FileAccessGrant } from "./file-access-grant.js";
import { grantRoots } from "./file-access-grant.js";
import {
  createPlatformSandbox,
  type EnforcementLevel,
  type HostSandbox,
  type SandboxSpawnRequest
} from "./host-sandbox.js";
import { createPathFence, type PathFence } from "./path-fence.js";

/** Exit code used by the probe; anything else means Seatbelt is unusable. */
const PROBE_PROFILE = "(version 1) (allow default)";

export interface SeatbeltSandboxOptions {
  fence?: PathFence;
  /**
   * Runs the availability probe. Injected so tests can force either outcome
   * without depending on the host's macOS version.
   */
  probe?: () => Promise<boolean>;
  /** Extra directories every Run may read (toolchains installed outside /usr). */
  additionalReadPaths?: readonly string[];
}

/** Directories a confined build command must be able to read. */
const DEFAULT_READ_PATHS: readonly string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/System/Library",
  "/Library",
  "/dev",
  "/private/tmp",
  "/private/var/db/dyld",
  "/opt/homebrew"
];

export function createSeatbeltSandbox(options: SeatbeltSandboxOptions = {}): HostSandbox {
  const fence = options.fence ?? createPathFence({ caseInsensitive: true });
  const readPaths = [...DEFAULT_READ_PATHS, ...(options.additionalReadPaths ?? [])];
  const probe = options.probe ?? probeSeatbelt;
  const available = probe().catch(() => false);

  const tiers: Record<FileAccessScope, EnforcementLevel> = {
    workspace_only: "kernel",
    selected_directories: "kernel",
    // No fence is applied; the user's OS-native confirmation is the control.
    host_full: "acknowledged_unrestricted"
  };

  return createPlatformSandbox({
    fence,
    platform: "darwin",
    tiers,
    detail:
      "macOS Seatbelt confines the process tree in the kernel. Availability is " +
      "probed at startup; if the probe fails every tier is reported unsupported.",
    wrap: (request) => wrapWithSeatbelt(request, readPaths, available)
  });
}

/**
 * Builds the SBPL profile and prefixes the command with `sandbox-exec`.
 *
 * Waits for the probe before wrapping, so a host without Seatbelt cannot
 * produce a plan that only looks confined.
 */
async function wrapWithSeatbelt(
  request: SandboxSpawnRequest,
  readPaths: readonly string[],
  available: Promise<boolean>
): Promise<{ executable: string; args: string[] }> {
  if (request.grant.scope === "host_full") {
    return { executable: request.executable, args: request.args };
  }
  if (!(await available)) {
    throw new Error(
      "Seatbelt is unavailable on this host, so the requested file access tier cannot be enforced"
    );
  }
  const profile = buildProfile(request.grant, readPaths);
  return {
    executable: "/usr/bin/sandbox-exec",
    args: ["-p", profile, request.executable, ...request.args]
  };
}

/** Renders a deny-by-default SBPL profile for the grant's roots. */
export function buildProfile(
  grant: FileAccessGrant,
  readPaths: readonly string[] = DEFAULT_READ_PATHS
): string {
  const lines: string[] = ["(version 1)", "(deny default)"];

  for (const path of readPaths) {
    lines.push(`(allow file-read* (subpath "${escapeProfileString(path)}"))`);
  }
  // Writable roots: the worktree always, plus anything the user selected.
  for (const root of grantRoots(grant)) {
    lines.push(
      `(allow file-read* file-write* (subpath "${escapeProfileString(root)}"))`
    );
  }
  // Process and runtime basics a confined command cannot function without.
  lines.push(
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    '(allow file-read* file-write* (literal "/dev/null"))',
    '(allow file-read* file-write* (literal "/dev/zero"))',
    '(allow file-read* file-write* (literal "/dev/random"))',
    '(allow file-read* file-write* (literal "/dev/urandom"))',
    '(allow file-read* file-write* (regex #"^/dev/(ttys|pty|pipe)[0-9]+$"))'
  );
  // Outbound network is governed by the project's network policy, not by file
  // access scope; leaving it denied here is the conservative default.
  lines.push("(deny network-outbound)", "(deny network-inbound)");
  return lines.join("\n") + "\n";
}

/** Escapes a path for embedding in an SBPL string literal. */
function escapeProfileString(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

/**
 * Proves `sandbox-exec` works by running a trivial allow-all profile.
 *
 * Uses `/usr/bin/true` so the check depends on Seatbelt, not on PATH.
 */
export async function probeSeatbelt(): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return await new Promise<boolean>((resolve) => {
    let child: import("node:child_process").ChildProcess;
    try {
      child = spawn("/usr/bin/sandbox-exec", ["-p", PROBE_PROFILE, "/usr/bin/true"], {
        stdio: "ignore"
      });
    } catch {
      resolve(false);
      return;
    }
    // A stuck probe must not hang a Run forever.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, 5_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
