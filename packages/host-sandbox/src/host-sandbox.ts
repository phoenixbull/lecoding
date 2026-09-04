/**
 * The OS sandbox port.
 *
 * This is the seam the Local Runner enforces file access through. Its most
 * important property is that it is **honest about what it can and cannot do**:
 * `capabilities()` reports the real enforcement level per tier on the current
 * host, and `admit()` refuses a grant the host cannot enforce rather than
 * silently downgrading it.
 *
 * Three enforcement levels exist because three things are actually true:
 *
 * - `kernel` — the operating system enforces it, so even a command that ignores
 *   its arguments (a tool reading its own config) is confined.
 * - `argv_fence` — the sandbox inspects and canonicalizes the command line and
 *   refuses to create the process if it names an out-of-scope path. Real, but
 *   weaker: it cannot see a path a program invents on its own.
 * - `acknowledged_unrestricted` — no restriction, authorized by an explicit
 *   OS-native confirmation. The absence of a fence, not a broken one.
 * - `unsupported` — the host cannot enforce this tier at all. Admission must
 *   fail; it must never be treated as any of the above.
 */

import type { FileAccessScope } from "@lecoding/contracts";
import { FileAccessGrantError, grantRoots, isFenced } from "./file-access-grant.js";
import type { FileAccessGrant } from "./file-access-grant.js";
import type { PathFence, PathViolation } from "./path-fence.js";

export type EnforcementLevel =
  /** The operating system enforces it below the process. */
  | "kernel"
  /** Enforced by refusing to create a process whose argv escapes the grant. */
  | "argv_fence"
  /** Unrestricted by design, authorized by an explicit user confirmation. */
  | "acknowledged_unrestricted"
  /** Cannot be enforced on this host; admission must fail. */
  | "unsupported";

export interface SandboxCapabilityReport {
  platform: NodeJS.Platform;
  /** The real enforcement level for each tier on this host. */
  tiers: Record<FileAccessScope, EnforcementLevel>;
  /** Human-readable explanation, surfaced in the UI so the difference is visible. */
  detail: string;
}

/** What a sandboxed spawn needs to know. */
export interface SandboxSpawnRequest {
  grant: FileAccessGrant;
  /** Bare executable name; the Local Runner never accepts a path here. */
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The command to actually spawn.
 *
 * A sandbox that works by wrapping the executable (Seatbelt) returns a
 * different `executable`/`args`; one that only inspects returns them unchanged.
 */
export interface SandboxSpawnPlan {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface HostSandbox {
  /** The real enforcement this host provides. The UI and admission use only this. */
  capabilities(): SandboxCapabilityReport;

  /**
   * Admits a Run, or throws.
   *
   * Fails closed: a tier reported as `unsupported` is refused. It is never
   * quietly downgraded to `argv_fence` or widened to `host_full`, because a
   * silent downgrade means the user believes a restriction exists that does not.
   */
  admit(grant: FileAccessGrant): void;

  /**
   * Produces the spawn plan, or throws when the command escapes the grant.
   *
   * Either way the process is never created: a denial here is the enforcement.
   */
  plan(request: SandboxSpawnRequest): Promise<SandboxSpawnPlan>;

  /** Judges a command without spawning, for audit records and tests. */
  inspect(request: SandboxSpawnRequest): Promise<PathViolation[]>;
}

/** Thrown when a Run or command is refused. Carries the reason for the audit log. */
export class SandboxViolationError extends Error {
  readonly violations: PathViolation[];

  constructor(message: string, violations: PathViolation[] = []) {
    super(message);
    this.name = "SandboxViolationError";
    this.violations = violations;
  }
}

export interface SandboxBaseOptions {
  /** Canonicalizer used for every path judgement. */
  fence: PathFence;
  /** Reported verbatim in the capability report; label the real host. */
  platform: NodeJS.Platform;
  /**
   * What this host truly enforces, per tier.
   *
   * Caller obligation: report the weaker truth. Claiming `kernel` for a host
   * that only inspects arguments makes the UI advertise a guarantee the OS is
   * not providing, which is strictly worse than admitting the gap.
   */
  tiers: Record<FileAccessScope, EnforcementLevel>;
  /**
   * Shown to the user verbatim, so it must name what is *missing* as well as
   * what is present. "Refuses out-of-scope commands" alone leaves the reader
   * assuming kernel enforcement.
   */
  detail: string;
}

/**
 * Shared behaviour for every platform adapter: admission and argv fencing.
 *
 * Platform adapters supply `tiers` (what they truly enforce) and optionally
 * override `wrap` to produce a wrapped command line. Keeping admission here
 * means the fail-closed rule cannot be forgotten by a new adapter.
 */
export function createHostSandbox(options: SandboxBaseOptions): HostSandbox {
  const { fence, platform, tiers, detail } = options;

  return {
    capabilities() {
      return { platform, tiers: { ...tiers }, detail };
    },

    admit(grant) {
      const level = tiers[grant.scope];
      if (level === "unsupported") {
        throw new FileAccessGrantError(
          `This host cannot enforce the "${grant.scope}" file access tier: ${detail}`
        );
      }
      if (grant.scope === "host_full" && grant.dangerAcknowledgedAt === undefined) {
        // Belt and braces: `createFileAccessGrant` already requires this, but a
        // grant can also arrive from persistence, where it is untrusted input.
        throw new FileAccessGrantError(
          "A host_full grant must record the user's danger acknowledgement"
        );
      }
    },

    async plan(request) {
      this.admit(request.grant);
      const violations = await this.inspect(request);
      if (violations.length > 0) {
        throw new SandboxViolationError(
          `Command touches paths outside the Run's file access grant: ${violations
            .map((violation) => violation.canonicalPath)
            .join(", ")}`,
          violations
        );
      }
      // Adapters without a wrapper spawn exactly what they were given: the
      // argv fence is the whole mechanism, so there is nothing to rewrite.
      return {
        executable: request.executable,
        args: request.args,
        cwd: request.cwd,
        ...(request.env ? { env: request.env } : {})
      };
    },

    async inspect(request) {
      // `host_full` is the absence of a fence, so there is nothing to judge.
      if (!isFenced(request.grant)) {
        return [];
      }
      const verdict = await fence.inspect({
        allowedRoots: grantRoots(request.grant),
        cwd: request.cwd,
        args: request.args
      });
      return verdict.violations;
    }
  };
}

/**
 * Rewrites a command so the platform confines it below the process.
 *
 * May be async: the macOS Seatbelt adapter must await its availability probe
 * before it can honestly claim the command will be confined.
 */
export type SandboxWrapper = (
  request: SandboxSpawnRequest
) => Promise<{ executable: string; args: string[] }>;

export interface PlatformSandboxOptions extends Omit<SandboxBaseOptions, never> {
  /**
   * Optional command rewriter for platforms that confine below this process.
   *
   * Caller obligation: throw rather than return an unwrapped command when the
   * confinement mechanism is unavailable. Returning the original command would
   * produce a plan that looks safe while running completely unconfined.
   */
  wrap?: SandboxWrapper;
}

/**
 * Same as `createHostSandbox` but lets a platform adapter supply a wrapper.
 *
 * Exists so a kernel-enforcing platform (macOS Seatbelt) can confine the
 * process tree without reimplementing admission or argv fencing.
 */
export function createPlatformSandbox(options: PlatformSandboxOptions): HostSandbox {
  const base = createHostSandbox(options);
  if (!options.wrap) {
    return base;
  }
  const wrap = options.wrap;
  return {
    capabilities: base.capabilities,
    admit: (grant) => base.admit(grant),
    inspect: (request) => base.inspect(request),
    async plan(request) {
      base.admit(request.grant);
      const violations = await base.inspect(request);
      if (violations.length > 0) {
        throw new SandboxViolationError(
          `Command touches paths outside the Run's file access grant: ${violations
            .map((violation) => violation.canonicalPath)
            .join(", ")}`,
          violations
        );
      }
      // Awaited, so an adapter that must prove its confinement first (Seatbelt)
      // can fail the plan instead of returning a command that only looks safe.
      const wrapped = await wrap(request);
      return {
        executable: wrapped.executable,
        args: wrapped.args,
        cwd: request.cwd,
        ...(request.env ? { env: request.env } : {})
      };
    }
  };
}
