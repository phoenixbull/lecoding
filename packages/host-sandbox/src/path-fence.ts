/**
 * Path canonicalization and containment for the Local Runner.
 *
 * This is the cross-platform baseline that applies on every OS: before a child
 * process is created, every path-like argument and the working directory are
 * canonicalized and checked against the Run's grant. On macOS, Seatbelt adds
 * kernel-level enforcement on top; here, the guarantee is that a command is
 * *never created* if it names a path outside the grant.
 *
 * ## Why canonicalize rather than compare strings
 *
 * A lexical check is trivially bypassed:
 *
 * - `a/b/../c` and `a/c` are the same path.
 * - A symlink inside the worktree can point anywhere on the host.
 * - On macOS and Windows the filesystem is case-insensitive by default, so
 *   `Worktree/x` and `worktree/x` are the same file.
 * - On Windows, junctions and directory symlinks behave like symlinks, and
 *   extended-length (`\\?\`) prefixes change how a path is parsed.
 *
 * `canonicalize` resolves all of these to one comparable form.
 *
 * ## Paths that do not exist yet
 *
 * `fs.realpath` fails for a path that does not exist, which is the normal case
 * for an output file a command is about to create. Refusing to canonicalize
 * those would make the fence useless, so `canonicalize` resolves the deepest
 * existing ancestor and re-attaches the remaining segments. A symlink cannot
 * hide in the non-existent tail, because there is nothing there to dereference.
 */

import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Canonicalizes a path; injectable so tests can model a filesystem. */
export type RealpathFn = (path: string) => Promise<string>;

export interface PathFenceOptions {
  /** Defaults to `fs.promises.realpath`. */
  realpath?: RealpathFn;
  /**
   * Working directory used to resolve relative arguments. Defaults to
   * `process.cwd()`.
   */
  cwd?: string;
  /**
   * Compare paths case-insensitively.
   *
   * Must be true on the default macOS and Windows filesystems, where
   * `Work` and `work` are the same directory and a case-sensitive comparison
   * would report a spurious escape (or, worse, miss a real one).
   */
  caseInsensitive?: boolean;
  /** Platform used for extended-length path handling. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/** Why a path was refused. */
export type PathFenceReason =
  /** Canonical form lies outside every allowed root. */
  | "out_of_scope"
  /** The path could not be resolved, so containment cannot be established. */
  | "unresolvable";

export interface PathViolation {
  /** The original argv token (or `cwd`) that produced the path. */
  token: string;
  /** The canonicalized path that was judged. */
  canonicalPath: string;
  reason: PathFenceReason;
}

export interface PathFenceRequest {
  /** Absolute, canonical roots the command may touch. */
  allowedRoots: readonly string[];
  /** Working directory the command will run in. */
  cwd: string;
  /** Command arguments, excluding the executable. */
  args: readonly string[];
}

export interface PathFenceVerdict {
  /** True when every path-like argument and the cwd are inside the grant. */
  allowed: boolean;
  violations: PathViolation[];
  /** Every path-like token that was examined, for audit records. */
  examined: Array<{ token: string; canonicalPath: string }>;
}

export interface PathFence {
  /** Resolves symlinks, junctions, `.`/`..` and case into one comparable form. */
  canonicalize(path: string): Promise<string>;
  /** True when `canonicalPath` is `root` itself or lies beneath it. */
  isWithin(canonicalPath: string, root: string): boolean;
  /** True when `canonicalPath` is inside any of `roots`. */
  isWithinAny(canonicalPath: string, roots: readonly string[]): boolean;
  /** Picks the argv tokens that name filesystem paths. */
  pathTokens(args: readonly string[]): string[];
  /** Judges a command before it is created. */
  inspect(request: PathFenceRequest): Promise<PathFenceVerdict>;
}

/** Windows extended-length prefix; `\\?\C:\x` must compare as `C:\x`. */
const EXTENDED_LENGTH_PREFIX = "\\\\?\\";

export function createPathFence(options: PathFenceOptions = {}): PathFence {
  // Lazy default so tests that never touch the real filesystem do not pull it in.
  const realpathFn: RealpathFn =
    options.realpath ?? ((path) => import("node:fs/promises").then((fs) => fs.realpath(path)));
  const cwd = options.cwd ?? process.cwd();
  const caseInsensitive = options.caseInsensitive ?? isCaseInsensitiveByDefault(options.platform);
  const platform = options.platform ?? process.platform;

  function normalizeCase(path: string): string {
    return caseInsensitive ? path.toLowerCase() : path;
  }

  /**
   * Strips the Windows extended-length prefix so `\\?\C:\a` and `C:\a` compare
   * equal. Without this, a command could present the same file under two forms.
   */
  function stripExtendedPrefix(path: string): string {
    if (platform !== "win32") {
      return path;
    }
    return path.startsWith(EXTENDED_LENGTH_PREFIX) ? path.slice(EXTENDED_LENGTH_PREFIX.length) : path;
  }

  async function canonicalize(path: string): Promise<string> {
    const absolute = resolve(cwd, stripExtendedPrefix(path));
    // realpath resolves symlinks, junctions (Windows reparse points) and any
    // `.`/`..` segments in one call, which is what makes alias attacks visible.
    try {
      return await realpathFn(absolute);
    } catch {
      // Fall through to the ancestor walk for paths that do not exist yet.
    }
    return await canonicalizeExistingAncestor(absolute);
  }

  /**
   * Resolves the deepest existing ancestor and re-attaches the missing tail.
   *
   * Necessary because commands routinely name output files that do not exist
   * yet; without this the fence could only judge paths that already exist.
   */
  async function canonicalizeExistingAncestor(absolute: string): Promise<string> {
    const tail: string[] = [];
    let current = absolute;
    for (;;) {
      const parent = dirname(current);
      if (parent === current) {
        // Reached the root without finding an existing ancestor.
        return normalize(absolute);
      }
      try {
        const real = await realpathFn(parent);
        return join(real, ...tail);
      } catch {
        tail.unshift(basenameOf(current));
        current = parent;
      }
    }
  }

  return {
    canonicalize,

    isWithin(canonicalPath, root) {
      const rel = relative(normalizeCase(resolve(root)), normalizeCase(resolve(canonicalPath)));
      // `relative` yields "" for equal paths, a relative path for a descendant,
      // or something starting with ".." (or absolute on another drive) for an
      // escape. All three cases must be handled or a sibling directory such as
      // `/workspace-evil` would pass a naive prefix test.
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    },

    isWithinAny(canonicalPath, roots) {
      return roots.some((root) => this.isWithin(canonicalPath, root));
    },

    pathTokens(args) {
      return args.filter((token) => looksLikePath(token, platform));
    },

    async inspect(request) {
      const violations: PathViolation[] = [];
      const examined: PathFenceVerdict["examined"] = [];

      // The working directory is checked first: a command that merely *starts*
      // outside the grant can read and write there without naming any path.
      const cwdCanonical = await canonicalize(request.cwd);
      examined.push({ token: "cwd", canonicalPath: cwdCanonical });
      if (!this.isWithinAny(cwdCanonical, request.allowedRoots)) {
        violations.push({
          token: "cwd",
          canonicalPath: cwdCanonical,
          reason: "out_of_scope"
        });
      }

      for (const token of this.pathTokens(request.args)) {
        let canonicalPath: string;
        try {
          canonicalPath = await canonicalize(token);
        } catch {
          violations.push({ token, canonicalPath: token, reason: "unresolvable" });
          continue;
        }
        examined.push({ token, canonicalPath });
        if (!this.isWithinAny(canonicalPath, request.allowedRoots)) {
          violations.push({ token, canonicalPath, reason: "out_of_scope" });
        }
      }

      return { allowed: violations.length === 0, violations, examined };
    }
  };

  function normalize(path: string): string {
    return resolve(stripExtendedPrefix(path));
  }
}

/**
 * Heuristic for "this argument names a path".
 *
 * Deliberately conservative in what it *accepts*: a missed path token is a gap
 * on macOS (where Seatbelt catches it in the kernel) and on other platforms is
 * the difference between enforced and not, so flags and URLs are excluded but
 * anything path-shaped is included.
 */
export function looksLikePath(token: string, platform: NodeJS.Platform = process.platform): boolean {
  if (token.length === 0) {
    return false;
  }
  // Flags never name paths.
  if (token.startsWith("-")) {
    return false;
  }
  // URLs are network destinations, handled by network policy, not file policy.
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(token)) {
    return false;
  }
  if (isAbsolute(token)) {
    return true;
  }
  if (token.startsWith("~/") || token.startsWith("~\\")) {
    return true;
  }
  if (platform === "win32" && /^[a-z]:[\\/]/iu.test(token)) {
    return true;
  }
  // Relative paths need at least one separator, so bare words like `test` or
  // `HEAD` are not mistaken for paths. A bare filename is safe to skip: it
  // resolves against the working directory, which is itself fenced.
  //
  // Only `\` counts as a separator on Windows. Treating it as one everywhere
  // would make `dir\name` on Linux look like a relative path when it is just a
  // single filename.
  return platform === "win32" ? /[\\/]/u.test(token) : token.includes("/");
}

function basenameOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/** macOS and Windows are case-insensitive by default; Linux is not. */
export function isCaseInsensitiveByDefault(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === "darwin" || platform === "win32";
}
