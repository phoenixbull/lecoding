/**
 * Loads project-scoped model instructions (AGENTS.md / CLAUDE.md) from a managed
 * repository worktree. The seam is filesystem-neutral so RunEngine can drive it
 * with a real fs on the host and a memory fs in tests.
 */

export interface ProjectInstructionFs {
  /** Reads a UTF-8 text file or rejects with NodeJS.ErrnoException for ENOENT/EACCES. */
  read(path: string): Promise<string>;
}

export interface ProjectInstructionLoaderOptions {
  fs: ProjectInstructionFs;
  /** Maximum bytes per file; rejects anything larger so a runaway repo can't fill the prompt. */
  maxBytes?: number;
}

export interface ProjectInstructionLoadInput {
  /** Canonical absolute path to the registered project root. */
  projectRoot: string;
  /** Canonical absolute path of the directory the model is currently reasoning about. */
  cwd: string;
}

export interface ProjectInstructionSection {
  /** Absolute path on the host filesystem; never sent to the model. */
  path: string;
  /** Path relative to projectRoot, safe to surface for telemetry. */
  relativePath: string;
  /** Trimmed UTF-8 content of the instruction file. */
  content: string;
}

export interface ProjectInstructions {
  /** Ordered root-first sections; child scopes override their ancestors by appearing later. */
  sections: ProjectInstructionSection[];
}

const DEFAULT_MAX_BYTES = 64 * 1024;

const FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md"] as const;

/**
 * Walks from `cwd` up to `projectRoot` and returns every AGENTS.md / CLAUDE.md
 * it encountered. The order is ancestor-first so a child directory's instructions
 * can locally refine the project's defaults.
 */
export function createProjectInstructionLoader(
  options: ProjectInstructionLoaderOptions
): {
  load(input: ProjectInstructionLoadInput): Promise<ProjectInstructions>;
} {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Project instruction size limit must be a positive integer");
  }
  const fs = options.fs;

  return {
    async load({ projectRoot, cwd }) {
      if (!isContainedPath(cwd, projectRoot)) {
        throw new Error("projectRoot must contain cwd");
      }
      const directories = collectDirectoriesFromCwdToRoot(cwd, projectRoot);
      // Ancestor-first order lets downstream adapters append child rules without losing parent rules.
      const sections: ProjectInstructionSection[] = [];
      for (const directory of directories.reverse()) {
        const section = await loadSection({
          fs,
          directory,
          projectRoot,
          maxBytes
        });
        if (section) {
          sections.push(section);
        }
      }
      return { sections };
    }
  };
}

async function loadSection({
  fs,
  directory,
  projectRoot,
  maxBytes
}: {
  fs: ProjectInstructionFs;
  directory: string;
  projectRoot: string;
  maxBytes: number;
}): Promise<ProjectInstructionSection | undefined> {
  for (const candidate of FILE_CANDIDATES) {
    const path = joinPath(directory, candidate);
    let content: string;
    try {
      content = await fs.read(path);
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      throw error;
    }
    const trimmed = content.replace(/\s+$/u, "");
    if (Buffer.byteLength(trimmed, "utf8") > maxBytes) {
      throw new Error(
        `Project instruction ${candidate} exceeds the size limit (${maxBytes} bytes)`
      );
    }
    return {
      path,
      relativePath: relativePathFromRoot(directory, candidate, projectRoot),
      content: trimmed
    };
  }
  return undefined;
}

function collectDirectoriesFromCwdToRoot(
  cwd: string,
  projectRoot: string
): string[] {
  const stack: string[] = [];
  let current = normalizePath(cwd);
  const root = normalizePath(projectRoot);
  while (true) {
    stack.push(current);
    if (current === root) {
      break;
    }
    const parent = parentOfPath(current);
    if (parent === current || !isContainedPath(current, root)) {
      throw new Error("projectRoot must contain cwd");
    }
    current = parent;
  }
  return stack;
}

function normalizePath(value: string): string {
  return value.replace(/\/+$/u, "");
}

function joinPath(directory: string, file: string): string {
  return `${normalizePath(directory)}/${file}`;
}

function parentOfPath(value: string): string {
  const normalized = normalizePath(value);
  const separatorIndex = normalized.lastIndexOf("/");
  if (separatorIndex <= 0) {
    return normalized;
  }
  return normalized.slice(0, separatorIndex);
}

function isContainedPath(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  if (normalizedPath === normalizedRoot) {
    return true;
  }
  return normalizedPath.startsWith(`${normalizedRoot}/`);
}

function relativePathFromRoot(
  directory: string,
  file: string,
  projectRoot: string
): string {
  const trimmedRoot = normalizePath(projectRoot);
  const trimmedDirectory = normalizePath(directory);
  if (trimmedDirectory === trimmedRoot) {
    return file;
  }
  const prefix = `${trimmedRoot}/`;
  if (!trimmedDirectory.startsWith(prefix)) {
    return file;
  }
  return `${trimmedDirectory.slice(prefix.length)}/${file}`;
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}