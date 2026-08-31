/**
 * Project-scoped protected-path matcher.
 *
 * Matches a project's `protectedPaths` globs (loaded from the reviewed
 * `.ai-agent/project.yaml`) against a normalised file realpath. The matcher is
 * deliberately tiny: only the `*` and `**` operators the project registry
 * already advertises, with literal `.` escaped so an `.env` rule cannot
 * accidentally match `.envy`. Patterns are project-relative so the matcher can
 * be reused across run-scoped worktrees without touching the host filesystem.
 */

export type ProjectPolicyGlob = string;

export interface ProjectPolicyGlobMatcherOptions {
  globs: ProjectPolicyGlob[];
  /**
   * Maximum number of globs a single matcher may be built with. Defaults to
   * 128 to keep an adversarial project.yaml from inflating policy work.
   */
  maxGlobs?: number;
}

export interface ProjectPolicyGlobMatcher {
  matches(realpath: string): boolean;
}

const DEFAULT_MAX_GLOBS = 128;

export function createProjectPolicyGlobMatcher(
  options: ProjectPolicyGlobMatcherOptions
): ProjectPolicyGlobMatcher {
  const maxGlobs = options.maxGlobs ?? DEFAULT_MAX_GLOBS;
  if (!Number.isSafeInteger(maxGlobs) || maxGlobs <= 0) {
    throw new Error("maxGlobs must be a positive integer");
  }
  if (!Array.isArray(options.globs)) {
    throw new Error("globs must be an array");
  }
  if (options.globs.length > maxGlobs) {
    throw new Error(`Too many protected path globs (max ${maxGlobs})`);
  }
  const compiled = options.globs.map((pattern) => compileGlob(pattern));

  return {
    matches(realpath) {
      if (typeof realpath !== "string" || realpath.length === 0) {
        return false;
      }
      const normalised = normaliseRealpath(realpath);
      for (const rule of compiled) {
        if (rule.regex.test(normalised)) {
          return true;
        }
      }
      return false;
    }
  };
}

interface CompiledGlob {
  regex: RegExp;
}

function compileGlob(pattern: unknown): CompiledGlob {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("Each protected path glob must be a non-empty string");
  }
  if (pattern.includes("\u0000")) {
    throw new Error("Protected path glob must not contain a null byte");
  }
  if (pattern.startsWith("/")) {
    // A leading slash is interpreted as project-relative after stripping, but
    // the policy loader requires project-relative globs to omit it so the
    // operator's intent stays visible.
    throw new Error("Protected path glob must be project-relative");
  }
  if (/^[a-zA-Z]:/u.test(pattern)) {
    // Reject Windows-style absolute paths up front so they cannot smuggle a
    // host filesystem reference into a project-relative policy rule.
    throw new Error("Protected path glob must be project-relative");
  }
  if (pattern.includes("\\")) {
    throw new Error("Protected path glob must not contain a backslash");
  }
  const trimmed = pattern.replace(/^\/+/u, "");
  if (trimmed.length === 0) {
    throw new Error("Protected path glob must not be empty after trimming");
  }
  if (trimmed === ".." || trimmed.startsWith("../")) {
    throw new Error("Protected path glob must be project-relative");
  }
  const body = escapeGlobToRegex(trimmed);
  // Project globs must match the project root OR any descendant: `.env` is
  // expected to match `/repo/.env` and `/repo/sub/.env` alike. The optional
  // `.*/` prefix lets the matcher anchor at any path depth.
  return { regex: new RegExp(`(?:.*/)?${body}$`) };
}

/**
 * Escapes literal characters and translates `*` / `**` operators into a
 * anchored regular expression that matches the trailing path of a normalised
 * realpath.
 */
function escapeGlobToRegex(pattern: string): string {
  let result = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        // `**/x` and `x/**` collapse to `x`; bare `**` matches every segment.
        if (pattern[index + 2] === "/") {
          result += "(?:.*/)?";
          index += 2;
          continue;
        }
        result += ".*";
        index += 1;
        continue;
      }
      result += "[^/]*";
      continue;
    }
    if (/[.+^$(){}|[\]?\\]/u.test(char)) {
      result += `\\${char}`;
      continue;
    }
    result += char;
  }
  return result;
}

/**
 * Returns the path portion that survives after the project root. The matcher
 * is root-agnostic; consumers are expected to realpath the file first and pass
 * the resolved absolute path. We then compare the trailing segments so the
 * glob can match anywhere in the tree.
 */
function normaliseRealpath(realpath: string): string {
  // Strip the leading slash so a project-relative glob like `.env` can match
  // both `/repo/.env` and `/repo/sub/.env` without special-casing.
  return realpath.replace(/^\/+/u, "");
}