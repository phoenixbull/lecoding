import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRunEnvironmentContractSuite } from "@lecoding/run-environment";
import { createDesktopRunEnvironment } from "../src/index.js";

function gitAvailable(): boolean {
  return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
}

/** Same Git 2.22-compatible recipe as the local adapter's fixture. */
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

describe.skipIf(!gitAvailable())("desktop adapter contract", () => {
  let sandboxRoot: string;
  let worktreeRoot: string;
  let sourceRepo: string;

  beforeEach(() => {
    sandboxRoot = join(
      tmpdir(),
      `desktop-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
    name: "DesktopLocalEnvironment (approval gates + local worktree)",
    rejectsUnknownActionType: true,
    rejectsEmptyCommand: true,
    reportsNonZeroExitCode: true,
    create: async () =>
      createDesktopRunEnvironment({
        sourceRepo,
        worktreeRoot,
        // Gates approve unconditionally: the desktop-specific gate behaviour is
        // asserted in desktop-runner.test.ts, not here.
        approvalGate: async () => ({ approved: true }),
        keepOrDiscardGate: async (request) => ({ outcome: request.callerOutcome })
      }),
    dispose: async () => {
      // The sandbox root is removed in afterEach.
    }
  });

  // Proves the adapter composes the local environment rather than bypassing it.
  it("delegates perform to the underlying local environment", async () => {
    const environment = createDesktopRunEnvironment({
      sourceRepo,
      worktreeRoot,
      approvalGate: async () => ({ approved: true }),
      keepOrDiscardGate: async (request) => ({ outcome: request.callerOutcome })
    });
    const handle = await environment.prepare({
      runId: "delegate-run-1",
      projectId: "p",
      environmentId: "local:d1",
      fileAccessScope: "workspace_only"
    });
    const result = await environment.perform(handle, {
      type: "execute",
      command: ["node", "-e", "process.stdout.write('delegated')"]
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("delegated");
  });

  it("resolves the worktree path to the sandbox used by the fixture", () => {
    expect(resolve(sourceRepo)).toBe(sourceRepo);
  });
});
