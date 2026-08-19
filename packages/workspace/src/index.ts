import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

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
