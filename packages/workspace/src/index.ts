import { execFile } from "node:child_process";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { RunChanges } from "@lecoding/contracts";

const exec = promisify(execFile);
const MAX_CHANGED_FILES = 500;
const MAX_DIFF_CHARACTERS = 256_000;

export interface WorkspaceHandle {
  runId: string;
  sourceRepo: string;
  path: string;
}

export interface PrepareWorkspace {
  runId: string;
  sourceRepo: string;
  baseRef: string;
}

export interface WorkspacePatch {
  path: string;
  content: string;
}

export interface WorkspaceReport {
  changedFiles: string[];
}

export interface GitWorkspace {
  prepare(input: PrepareWorkspace): Promise<WorkspaceHandle>;
  apply(handle: WorkspaceHandle, patch: WorkspacePatch): Promise<void>;
  inspect(handle: WorkspaceHandle): Promise<WorkspaceReport>;
  dispose(
    handle: WorkspaceHandle,
    outcome: "keep" | "discard"
  ): Promise<void>;
}

/** Read-only seam for rendering bounded Git changes from a managed Run worktree. */
export interface RunChangesReader {
  read(runId: string): Promise<RunChanges>;
}

/** Terminal result action over one revalidated managed Run worktree. */
export interface RunResultManager {
  resolve(runId: string, outcome: "keep" | "discard"): Promise<void>;
}

/** Trusted host-side whitespace/conflict-marker check for one managed Run patch. */
export interface RunDiffSafetyChecker {
  check(runId: string): Promise<boolean>;
}

/**
 * Creates a checker that retains Git metadata on the host instead of exposing it
 * inside a model or verification container. Missing/unmanaged worktrees fail closed.
 */
export function createGitRunDiffSafetyChecker(options: {
  sourceRepo: string;
  worktreeRoot: string;
}): RunDiffSafetyChecker {
  const sourceRepo = resolve(options.sourceRepo);
  const worktreeRoot = resolve(options.worktreeRoot);
  return {
    async check(runId) {
      if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
        throw new Error("Run ID contains unsupported path characters");
      }
      const canonicalSource = await realpath(sourceRepo);
      const canonicalRoot = await realpath(worktreeRoot);
      const worktreePath = join(canonicalRoot, runId);
      await assertManagedWorktree(canonicalSource, worktreePath);
      if (!(await trackedDiffIsSafe(worktreePath))) {
        return false;
      }
      const { stdout } = await exec(
        "git",
        ["-C", worktreePath, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        { maxBuffer: 2 * 1024 * 1024 }
      );
      const untrackedFiles = parseGitStatus(stdout)
        .filter((entry) => entry.status === "??")
        .map((entry) => entry.path);
      for (const path of untrackedFiles) {
        if (!(await untrackedDiffIsSafe(worktreePath, path))) {
          return false;
        }
      }
      return true;
    }
  };
}

/**
 * Creates a reader that revalidates Git worktree ownership on every request.
 * It never creates a missing worktree and never accepts a caller-provided path.
 */
export function createGitRunChangesReader(options: {
  sourceRepo: string;
  worktreeRoot: string;
}): RunChangesReader {
  const sourceRepo = resolve(options.sourceRepo);
  const worktreeRoot = resolve(options.worktreeRoot);
  return {
    async read(runId) {
      if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
        throw new Error("Run ID contains unsupported path characters");
      }
      const canonicalSource = await realpath(sourceRepo);
      const canonicalRoot = await realpath(worktreeRoot);
      const worktreePath = join(canonicalRoot, runId);
      await assertManagedWorktree(canonicalSource, worktreePath);
      const { stdout: statusOutput } = await exec(
        "git",
        ["-C", worktreePath, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        { maxBuffer: 2 * 1024 * 1024 }
      );
      const statusEntries = parseGitStatus(statusOutput);
      const changedFiles = statusEntries
        .slice(0, MAX_CHANGED_FILES)
        .map((entry) => entry.path);
      const untrackedFiles = statusEntries
        .filter((entry) => entry.status === "??")
        .map((entry) => entry.path);
      const { stdout: trackedDiff } = await exec(
        "git",
        ["-C", worktreePath, "diff", "--no-ext-diff", "--no-color", "HEAD", "--"],
        { maxBuffer: 4 * 1024 * 1024 }
      );
      let unifiedDiff = trackedDiff;
      for (const path of untrackedFiles) {
        if (unifiedDiff.length >= MAX_DIFF_CHARACTERS) {
          break;
        }
        unifiedDiff += await diffUntrackedFile(worktreePath, path);
      }
      const truncated =
        statusEntries.length > MAX_CHANGED_FILES ||
        unifiedDiff.length > MAX_DIFF_CHARACTERS;
      if (unifiedDiff.length > MAX_DIFF_CHARACTERS) {
        unifiedDiff = `${unifiedDiff.slice(0, MAX_DIFF_CHARACTERS)}\n... diff truncated ...\n`;
      }
      return { changedFiles, unifiedDiff, truncated };
    }
  };
}

/**
 * Creates the terminal keep/discard boundary without accepting caller paths.
 * Discard is idempotent for safe HTTP retry but never removes an unverified path.
 */
export function createGitRunResultManager(options: {
  sourceRepo: string;
  worktreeRoot: string;
}): RunResultManager {
  const sourceRepo = resolve(options.sourceRepo);
  const worktreeRoot = resolve(options.worktreeRoot);
  return {
    async resolve(runId, outcome) {
      if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
        throw new Error("Run ID contains unsupported path characters");
      }
      const canonicalSource = await realpath(sourceRepo);
      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(worktreeRoot);
      } catch (error) {
        if (outcome === "discard" && isMissingPathError(error)) {
          return;
        }
        throw error;
      }
      const worktreePath = join(canonicalRoot, runId);
      if (!(await pathExists(worktreePath))) {
        if (outcome === "discard") {
          return;
        }
        throw new Error("Managed Run result was not found");
      }
      await assertManagedWorktree(canonicalSource, worktreePath);
      if (outcome === "keep") {
        return;
      }
      try {
        await exec("git", [
          "-C",
          canonicalSource,
          "worktree",
          "remove",
          "--force",
          worktreePath
        ]);
      } catch (error) {
        // Concurrent retries converge once the exact verified worktree is gone.
        if (!(await pathExists(worktreePath))) {
          return;
        }
        throw error;
      }
    }
  };
}

function parseGitStatus(output: string): Array<{ status: string; path: string }> {
  const fields = output.split("\0").filter((field) => field !== "");
  const entries: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    const status = field.slice(0, 2);
    entries.push({ status, path: field.slice(3) });
    if (status.includes("R") || status.includes("C")) {
      // Porcelain -z emits the second rename/copy path as the next NUL field.
      index += 1;
    }
  }
  return entries;
}

async function diffUntrackedFile(worktreePath: string, path: string): Promise<string> {
  try {
    await exec(
      "git",
      ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", path],
      { cwd: worktreePath, maxBuffer: 4 * 1024 * 1024 }
    );
    return "";
  } catch (error) {
    const result = error as { code?: string | number; stdout?: string };
    // git diff --no-index exits 1 when it successfully finds a difference.
    if (result.code === 1 && typeof result.stdout === "string") {
      return result.stdout;
    }
    throw new Error("Unable to read untracked Run change");
  }
}

/** `git diff --check` uses exit 2 specifically when tracked whitespace is unsafe. */
async function trackedDiffIsSafe(worktreePath: string): Promise<boolean> {
  try {
    await exec("git", ["-C", worktreePath, "diff", "--check", "HEAD", "--"]);
    return true;
  } catch (error) {
    if ((error as { code?: string | number }).code === 2) {
      return false;
    }
    throw new Error("Unable to check tracked Run changes");
  }
}

/** No-index exit 1 means a clean new-file diff; exit 3 identifies check errors. */
async function untrackedDiffIsSafe(
  worktreePath: string,
  path: string
): Promise<boolean> {
  try {
    await exec("git", ["diff", "--no-index", "--check", "--", "/dev/null", path], {
      cwd: worktreePath
    });
    return true;
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    if (code === 1) {
      return true;
    }
    if (code === 3) {
      return false;
    }
    throw new Error("Unable to check untracked Run change");
  }
}

export function createGitWorkspace(options: {
  worktreeRoot: string;
}): GitWorkspace {
  return new DefaultGitWorkspace(resolve(options.worktreeRoot));
}

class DefaultGitWorkspace implements GitWorkspace {
  constructor(private readonly worktreeRoot: string) {}

  async prepare(input: PrepareWorkspace): Promise<WorkspaceHandle> {
    if (!/^[a-zA-Z0-9_-]+$/.test(input.runId)) {
      throw new Error("Run ID contains unsupported path characters");
    }

    const sourceRepo = await realpath(resolve(input.sourceRepo));
    const { stdout } = await exec("git", [
      "-C",
      sourceRepo,
      "rev-parse",
      "--show-toplevel"
    ]);
    if ((await realpath(stdout.trim())) !== sourceRepo) {
      throw new Error("Source repository must be registered by its root path");
    }

    await mkdir(this.worktreeRoot, { recursive: true });
    const worktreePath = join(this.worktreeRoot, input.runId);
    if (await pathExists(worktreePath)) {
      await assertManagedWorktree(sourceRepo, worktreePath);
      // Recovery reuses the durable worktree without resetting uncommitted Run changes.
      return { runId: input.runId, sourceRepo, path: worktreePath };
    }
    await exec("git", [
      "-C",
      sourceRepo,
      "worktree",
      "add",
      "--detach",
      worktreePath,
      input.baseRef
    ]);

    return { runId: input.runId, sourceRepo, path: worktreePath };
  }

  async apply(handle: WorkspaceHandle, patch: WorkspacePatch): Promise<void> {
    if (isAbsolute(patch.path)) {
      throw new Error("Patch path must be relative to the worktree");
    }

    const target = resolve(handle.path, patch.path);
    const pathWithinWorktree = relative(handle.path, target);
    if (
      pathWithinWorktree === "" ||
      pathWithinWorktree === ".." ||
      pathWithinWorktree.startsWith(`..${sep}`) ||
      isAbsolute(pathWithinWorktree)
    ) {
      throw new Error("Patch path escapes the worktree");
    }

    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, patch.content, "utf8");
  }

  async inspect(handle: WorkspaceHandle): Promise<WorkspaceReport> {
    const { stdout } = await exec("git", [
      "-C",
      handle.path,
      "status",
      "--short",
      "--untracked-files=all"
    ]);
    const changedFiles = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3));
    return { changedFiles };
  }

  async dispose(
    handle: WorkspaceHandle,
    outcome: "keep" | "discard"
  ): Promise<void> {
    if (outcome === "keep") {
      return;
    }

    await exec("git", [
      "-C",
      handle.sourceRepo,
      "worktree",
      "remove",
      "--force",
      handle.path
    ]);
  }
}

/** Existing paths are reopened only when Git proves they belong to the source repo. */
async function assertManagedWorktree(
  sourceRepo: string,
  worktreePath: string
): Promise<void> {
  try {
    const [{ stdout: topLevel }, { stdout: sourceCommon }, { stdout: worktreeCommon }] =
      await Promise.all([
        exec("git", ["-C", worktreePath, "rev-parse", "--show-toplevel"]),
        exec("git", ["-C", sourceRepo, "rev-parse", "--git-common-dir"]),
        exec("git", ["-C", worktreePath, "rev-parse", "--git-common-dir"])
      ]);
    const [canonicalPath, canonicalTop, canonicalSourceGit, canonicalWorktreeGit] =
      await Promise.all([
        realpath(worktreePath),
        realpath(topLevel.trim()),
        realpath(resolve(sourceRepo, sourceCommon.trim())),
        realpath(resolve(worktreePath, worktreeCommon.trim()))
      ]);
    if (
      canonicalPath !== canonicalTop ||
      canonicalSourceGit !== canonicalWorktreeGit
    ) {
      throw new Error("Existing workspace is not a managed worktree");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Existing workspace is not a managed worktree"
    ) {
      throw error;
    }
    throw new Error("Existing workspace is not a managed worktree");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
