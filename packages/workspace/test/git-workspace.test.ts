import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createGitWorkspace } from "../src/index.js";

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

    await expect(readFile(join(sourceRepo, "health.txt"), "utf8")).resolves.toBe(
      "before\n"
    );
    await expect(workspace.inspect(handle)).resolves.toMatchObject({
      changedFiles: ["health.txt"]
    });

    await workspace.dispose(handle, "discard");
  });
});
