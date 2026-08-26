import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import type {
  VerificationPlan,
  VerificationPlanProvider
} from "./index.js";

const MAX_PROJECT_CONFIG_BYTES = 64 * 1024;

/** Construction inputs for one immutable project-baseline plan provider. */
export interface ProjectYamlVerificationPlanProviderOptions {
  projectId: string;
  /** Absolute path to the reviewed baseline's `.ai-agent/project.yaml`. */
  configPath: string;
  /** Root containing every mutable Run worktree; config must be outside it. */
  mutableWorktreeRoot: string;
}

/**
 * Loads and caches a reviewed project plan before the Worker accepts Runs.
 * Both paths are resolved through the filesystem so a symlink cannot redirect
 * the trusted config into the Agent-writable worktree after a lexical check.
 */
export async function createProjectYamlVerificationPlanProvider(
  options: ProjectYamlVerificationPlanProviderOptions
): Promise<VerificationPlanProvider> {
  if (options.projectId.trim() === "") {
    throw new Error("Project verification config requires a projectId");
  }
  if (
    !isAbsolute(options.configPath) ||
    resolve(options.configPath) !== options.configPath ||
    !isAbsolute(options.mutableWorktreeRoot) ||
    resolve(options.mutableWorktreeRoot) !== options.mutableWorktreeRoot
  ) {
    throw new Error("Project verification paths must be canonical absolute paths");
  }

  const [configPath, mutableWorktreeRoot] = await Promise.all([
    realpath(options.configPath),
    realpath(options.mutableWorktreeRoot)
  ]);
  if (
    basename(configPath) !== "project.yaml" ||
    basename(dirname(configPath)) !== ".ai-agent"
  ) {
    throw new Error(
      "Project verification config must be named .ai-agent/project.yaml"
    );
  }
  if (isWithin(mutableWorktreeRoot, configPath)) {
    throw new Error(
      "Project verification config must be outside the mutable worktree root"
    );
  }

  const configStat = await stat(configPath);
  if (!configStat.isFile() || configStat.size > MAX_PROJECT_CONFIG_BYTES) {
    throw new Error("Project verification config exceeds 64 KiB or is not a file");
  }
  const source = await readFile(configPath, "utf8");
  // Recheck bytes after read so a concurrent administrator update cannot bypass size.
  if (Buffer.byteLength(source, "utf8") > MAX_PROJECT_CONFIG_BYTES) {
    throw new Error("Project verification config exceeds 64 KiB");
  }
  const document = parseDocument(source, {
    merge: false,
    uniqueKeys: true
  });
  if (document.errors.length > 0) {
    throw new Error("Project verification config contains invalid YAML");
  }
  const plan = readPlan(document.toJS({ maxAliasCount: 0 }));

  return {
    async load(input) {
      if (input.run.projectId !== options.projectId) {
        return undefined;
      }
      // Callers cannot mutate the cached administrator-reviewed plan.
      return structuredClone(plan);
    }
  };
}

function readPlan(value: unknown): VerificationPlan {
  const root = requireRecord(value);
  requireExactKeys(root, ["version", "verify"]);
  if (root.version !== 1) {
    throw new Error("Project verification config requires version 1");
  }
  const verify = requireRecord(root.verify);
  requireExactKeys(verify, ["required"]);
  if (!Array.isArray(verify.required) || verify.required.length === 0) {
    throw new Error("Project verification config requires verification commands");
  }
  const names = new Set<string>();
  const required = verify.required.map((entry) => {
    const command = requireRecord(entry);
    requireExactKeys(command, ["name", "argv", "covers"]);
    if (
      typeof command.name !== "string" ||
      command.name.trim() === "" ||
      names.has(command.name) ||
      !isNonEmptyStringArray(command.argv) ||
      !isNonEmptyStringArray(command.covers)
    ) {
      throw new Error("Project verification config contains an invalid command");
    }
    names.add(command.name);
    return {
      name: command.name,
      argv: command.argv,
      covers: command.covers
    };
  });
  return { required };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Project verification config contains an invalid object");
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: string[]
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("Project verification config contains an unknown field");
  }
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.trim() !== "")
  );
}

function isWithin(root: string, candidate: string): boolean {
  const pathWithinRoot = relative(root, candidate);
  return (
    pathWithinRoot === "" ||
    (pathWithinRoot !== ".." &&
      !pathWithinRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathWithinRoot))
  );
}
