import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createLocalRunEnvironment,
  type LocalRunEnvironmentLimits
} from "../src/index.js";

function gitAvailable(): boolean {
  const result = spawnSync("git", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function makeRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  const run = (args: string[]) =>
    spawnSync("git", args, { cwd: path, stdio: "ignore" });
  run(["init", "-q", "--initial-branch=main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  writeFileSync(join(path, "README.md"), "hello\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
}

function makeSandboxRoot(): string {
  const root = join(
    tmpdir(),
    `local-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(root, { recursive: true });
  return root;
}

describe.skipIf(!gitAvailable())("createLocalRunEnvironment", () => {
  let sourceRepo: string;
  let worktreeRoot: string;
  let limits: LocalRunEnvironmentLimits;

  beforeEach(() => {
    sourceRepo = makeSandboxRoot();
    worktreeRoot = makeSandboxRoot();
    const repoPath = join(sourceRepo, "project");
    makeRepo(repoPath);
    sourceRepo = repoPath;
    limits = {
      execTimeoutMs: 5_000,
      outputBytes: 16_384
    };
  });

  afterEach(() => {
    for (const root of [sourceRepo, worktreeRoot]) {
      if (!root) continue;
      const parent = resolve(root, "..");
      if (!existsSync(parent)) continue;
      try {
        rmSync(parent, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Best-effort cleanup; tmpdir files may be locked by other processes
        // (for example Microsoft Auto Update staging) on macOS. The next
        // run can recreate them.
      }
    }
  });

  it("prepares an isolated Git worktree under worktreeRoot/<runId>", async () => {
    const env = createLocalRunEnvironment({
      sourceRepo,
      worktreeRoot,
      limits
    });
    const handle = await env.prepare({
      runId: "run-1",
      projectId: "project-1",
      environmentId: "local",
      fileAccessScope: "workspace_only"
    });
    expect(handle.environmentId).toBe("local");
    const expected = join(worktreeRoot, "run-1");
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(join(expected, "README.md"), "utf8")).toBe("hello\n");

    await env.dispose(handle, "discard");
    expect(existsSync(expected)).toBe(false);
  });

  it("runs a command in the worktree and captures bounded output", async () => {
    const env = createLocalRunEnvironment({
      sourceRepo,
      worktreeRoot,
      limits
    });
    const handle = await env.prepare({
      runId: "run-2",
      projectId: "project-1",
      environmentId: "local",
      fileAccessScope: "workspace_only"
    });

    const result = await env.perform(
      handle,
      { type: "execute", command: ["node", "-e", "process.stdout.write('hi')"] }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi");
    expect(result.stderr).toBe("");

    await env.dispose(handle, "discard");
  });

  it("truncates stdout when the command output exceeds the limit", async () => {
    const env = createLocalRunEnvironment({
      sourceRepo,
      worktreeRoot,
      limits: { execTimeoutMs: 5_000, outputBytes: 16_384 }
    });
    const handle = await env.prepare({
      runId: "run-3",
      projectId: "project-1",
      environmentId: "local",
      fileAccessScope: "workspace_only"
    });
    const result = await env.perform(handle, {
      type: "execute",
      command: [
        "node",
        "-e",
        "process.stdout.write('a'.repeat(32768));"
      ]
    });
    expect(result.exitCode).toBe(0);
    // The bounded output capture must drop excess bytes; the EnvironmentResult
    // contract only exposes the trimmed strings, so the assertion lives on
    // stdout length here. With a 16 KiB cap the captured slice cannot contain
    // the full 32 KiB payload.
    expect(result.stdout.length).toBeLessThanOrEqual(16_384);
    expect(result.stdout.length).toBeLessThan(32_768);

    await env.dispose(handle, "discard");
  });

  it("kills an in-flight command when the AbortSignal fires", async () => {
    const env = createLocalRunEnvironment({
      sourceRepo,
      worktreeRoot,
      limits: { execTimeoutMs: 30_000, outputBytes: 16_384 }
    });
    const handle = await env.prepare({
      runId: "run-4",
      projectId: "project-1",
      environmentId: "local",
      fileAccessScope: "workspace_only"
    });
    const controller = new AbortController();
    const start = Date.now();
    const promise = env.perform(
      handle,
      {
        type: "execute",
        command: [
          "node",
          "-e",
          "setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000);"
        ]
      },
      controller.signal
    );
    setTimeout(() => controller.abort(), 100);
    await expect(promise).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(10_000);
    await env.dispose(handle, "discard");
  });

  it("reports the changed files written into the worktree", async () => {
    const env = createLocalRunEnvironment({
      sourceRepo,
      worktreeRoot,
      limits
    });
    const handle = await env.prepare({
      runId: "run-5",
      projectId: "project-1",
      environmentId: "local",
      fileAccessScope: "workspace_only"
    });
    await env.perform(handle, {
      type: "execute",
      command: [
        "node",
        "-e",
        "require('fs').writeFileSync('hello.txt', 'world')"
      ]
    });
    const report = await env.inspect(handle);
    expect(report.changedFiles).toContain("hello.txt");
    await env.dispose(handle, "discard");
  });

  it("returns the same outcome for keep even after the worktree is already gone", async () => {
    const env = createLocalRunEnvironment({
      sourceRepo,
      worktreeRoot,
      limits
    });
    const handle = await env.prepare({
      runId: "run-6",
      projectId: "project-1",
      environmentId: "local",
      fileAccessScope: "workspace_only"
    });
    await env.dispose(handle, "discard");
    // Second discard must be idempotent and not throw.
    await expect(env.dispose(handle, "discard")).resolves.toBeUndefined();
  });

  it("rejects a runId that contains path separators", async () => {
    const env = createLocalRunEnvironment({
      sourceRepo,
      worktreeRoot,
      limits
    });
    await expect(
      env.prepare({
        runId: "../escape",
        projectId: "project-1",
        environmentId: "local",
        fileAccessScope: "workspace_only"
      })
    ).rejects.toThrow(/Run ID/);
  });
});