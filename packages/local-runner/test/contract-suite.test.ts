import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRunEnvironmentContractSuite } from "@lecoding/run-environment";
import { createLocalRunEnvironment } from "../src/index.js";

function gitAvailable(): boolean {
  return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
}

/**
 * Same Git 2.22-compatible recipe as `environment.test.ts`, so the suite runs
 * on the minimum supported Git as well as modern ones.
 */
function makeRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  const run = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: path, stdio: "ignore" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} exited with status ${result.status}`);
    }
  };
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  const match = probe.stdout?.match(/git version (\d+)\.(\d+)/);
  const major = match ? Number(match[1]) : 0;
  const minor = match ? Number(match[2]) : 0;
  if (major > 2 || (major === 2 && minor >= 28)) {
    run(["init", "-q", "--initial-branch=main"]);
  } else {
    run(["init", "-q"]);
    run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  }
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  writeFileSync(join(path, "README.md"), "hello\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
}

describe.skipIf(!gitAvailable())("local adapter contract", () => {
  let sandboxRoot: string;
  let worktreeRoot: string;
  let sourceRepo: string;

  beforeEach(() => {
    sandboxRoot = join(
      tmpdir(),
      `local-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(sandboxRoot, { recursive: true });
    worktreeRoot = join(sandboxRoot, "worktrees");
    sourceRepo = join(sandboxRoot, "project");
    makeRepo(sourceRepo);
  });

  afterEach(() => {
    if (existsSync(sandboxRoot)) {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  runRunEnvironmentContractSuite({
    name: "LocalRunEnvironment (Git worktree)",
    rejectsUnknownActionType: true,
    rejectsEmptyCommand: true,
    reportsNonZeroExitCode: true,
    create: async () =>
      createLocalRunEnvironment({
        sourceRepo,
        worktreeRoot,
        // Short bounds so a hung command cannot stall the suite.
        limits: { execTimeoutMs: 10_000, outputBytes: 16_384 }
      }),
    dispose: async () => {
      // Each test uses its own run id, and the suite removes the whole sandbox
      // in afterEach, so nothing is left behind here.
    }
  });

  // Guard the fixture: a sandbox that cannot run `git` must fail loudly here
  // rather than produce confusing worktree errors inside the suite.
  it("initialised a usable source repository", () => {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: sourceRepo,
      encoding: "utf8"
    });
    expect(result.status).toBe(0);
    // Compared through realpath: on macOS the temp dir is reached through a
    // symlink, and Git reports its canonical spelling.
    expect(realpathSync(result.stdout?.trim() ?? "/")).toBe(realpathSync(sourceRepo));
  });
});
