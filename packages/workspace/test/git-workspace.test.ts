import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitRunDiffSafetyChecker,
  createGitRunChangesReader,
  createGitRunResultManager,
  createGitWorkspace
} from "../src/index.js";

const exec = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    )
  );
});

describe("GitWorkspace", () => {
  it("keeps or idempotently discards only a verified managed Run result", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "lecoding-result-"));
    temporaryDirectories.push(fixtureRoot);
    const sourceRepo = join(fixtureRoot, "source");
    const worktreeRoot = join(fixtureRoot, "runs");
    await mkdir(sourceRepo);
    await exec("git", ["init", "-q", sourceRepo]);
    await writeFile(join(sourceRepo, "result.txt"), "source\n");
    await exec("git", ["-C", sourceRepo, "add", "result.txt"]);
    await exec("git", [
      "-C",
      sourceRepo,
      "-c",
      "user.name=Result Test",
      "-c",
      "user.email=result@example.invalid",
      "commit",
      "-qm",
      "fixture"
    ]);
    const workspace = createGitWorkspace({ worktreeRoot });
    const handle = await workspace.prepare({
      runId: "run-result",
      sourceRepo,
      baseRef: "HEAD"
    });
    await workspace.apply(handle, { path: "result.txt", content: "changed\n" });
    const results = createGitRunResultManager({ sourceRepo, worktreeRoot });

    await results.resolve("run-result", "keep");
    await expect(readFile(join(handle.path, "result.txt"), "utf8")).resolves.toBe(
      "changed\n"
    );
    await results.resolve("run-result", "discard");
    await expect(access(handle.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(sourceRepo, "result.txt"), "utf8")).resolves.toBe(
      "source\n"
    );
    // Retried HTTP commands must not fail after the exact worktree is already gone.
    await expect(
      results.resolve("run-result", "discard")
    ).resolves.toBeUndefined();
  });

  it("checks tracked and untracked changes through the managed host worktree", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "lecoding-diff-safety-"));
    temporaryDirectories.push(fixtureRoot);
    const sourceRepo = join(fixtureRoot, "source");
    const worktreeRoot = join(fixtureRoot, "runs");
    await mkdir(sourceRepo);
    await mkdir(worktreeRoot);
    await exec("git", ["init", "-q", sourceRepo]);
    await writeFile(join(sourceRepo, "tracked.txt"), "clean\n");
    await exec("git", ["-C", sourceRepo, "add", "tracked.txt"]);
    await exec("git", [
      "-C",
      sourceRepo,
      "-c",
      "user.name=Diff Safety Test",
      "-c",
      "user.email=diff-safety@example.invalid",
      "commit",
      "-qm",
      "fixture"
    ]);
    const workspace = createGitWorkspace({ worktreeRoot });
    const handle = await workspace.prepare({
      runId: "run-diff",
      sourceRepo,
      baseRef: "HEAD"
    });
    const checker = createGitRunDiffSafetyChecker({ sourceRepo, worktreeRoot });

    await writeFile(join(handle.path, "tracked.txt"), "still clean\n");
    await writeFile(join(handle.path, "new.txt"), "also clean\n");
    await expect(checker.check("run-diff")).resolves.toBe(true);

    // Untracked files are absent from ordinary `git diff --check` and need a second check.
    await writeFile(join(handle.path, "new.txt"), "trailing whitespace \n");
    await expect(checker.check("run-diff")).resolves.toBe(false);
    await workspace.dispose(handle, "discard");
  });

  it("modifies an isolated worktree without changing the source checkout", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "lecoding-workspace-"));
    temporaryDirectories.push(fixtureRoot);
    const sourceRepo = join(fixtureRoot, "source");
    const worktreeRoot = join(fixtureRoot, "runs");
    await mkdir(sourceRepo);
    await mkdir(worktreeRoot);
    await exec("git", ["init", "-q", sourceRepo]);
    await writeFile(join(sourceRepo, "health.txt"), "before\n");
    await exec("git", ["-C", sourceRepo, "add", "health.txt"]);
    await exec("git", [
      "-C",
      sourceRepo,
      "-c",
      "user.name=Phase Zero",
      "-c",
      "user.email=phase-zero@example.invalid",
      "commit",
      "-qm",
      "fixture"
    ]);

    const workspace = createGitWorkspace({ worktreeRoot });
    const handle = await workspace.prepare({
      runId: "run-1",
      sourceRepo,
      baseRef: "HEAD"
    });
    await workspace.apply(handle, {
      path: "health.txt",
      content: "after\n"
    });
    await workspace.apply(handle, {
      path: "new.txt",
      content: "new file\n"
    });

    await expect(readFile(join(sourceRepo, "health.txt"), "utf8")).resolves.toBe(
      "before\n"
    );
    await expect(workspace.inspect(handle)).resolves.toMatchObject({
      changedFiles: ["health.txt", "new.txt"]
    });
    const changes = await createGitRunChangesReader({
      sourceRepo,
      worktreeRoot
    }).read("run-1");
    expect(changes.changedFiles).toEqual(["health.txt", "new.txt"]);
    expect(changes.unifiedDiff).toContain("-before");
    expect(changes.unifiedDiff).toContain("+after");
    expect(changes.unifiedDiff).toContain("+new file");
    expect(changes.truncated).toBe(false);

    await workspace.dispose(handle, "discard");
  });

  it("reopens an existing managed worktree during Worker recovery", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "lecoding-workspace-recovery-"));
    temporaryDirectories.push(fixtureRoot);
    const sourceRepo = join(fixtureRoot, "source");
    const worktreeRoot = join(fixtureRoot, "runs");
    await mkdir(sourceRepo);
    await exec("git", ["init", "-q", sourceRepo]);
    await writeFile(join(sourceRepo, "state.txt"), "durable\n");
    await exec("git", ["-C", sourceRepo, "add", "state.txt"]);
    await exec("git", [
      "-C",
      sourceRepo,
      "-c",
      "user.name=Recovery Test",
      "-c",
      "user.email=recovery@example.invalid",
      "commit",
      "-qm",
      "fixture"
    ]);
    const workspace = createGitWorkspace({ worktreeRoot });
    const first = await workspace.prepare({ runId: "run-recovery", sourceRepo, baseRef: "HEAD" });
    await workspace.apply(first, { path: "state.txt", content: "modified\n" });

    const reopened = await workspace.prepare({
      runId: "run-recovery",
      sourceRepo,
      baseRef: "HEAD"
    });

    expect(reopened).toEqual(first);
    await expect(readFile(join(reopened.path, "state.txt"), "utf8")).resolves.toBe(
      "modified\n"
    );
    await workspace.dispose(reopened, "discard");
  });
});
