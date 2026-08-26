import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectYamlVerificationPlanProvider } from "../src/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    )
  );
});

describe("createProjectYamlVerificationPlanProvider", () => {
  it("loads a reviewed argv plan from the trusted project baseline", async () => {
    const fixture = await createProjectFixture(`
version: 1
verify:
  required:
    - name: unit tests
      argv: [pnpm, test]
      covers:
        - Tests pass
`);

    const provider = await createProjectYamlVerificationPlanProvider({
      projectId: "project-1",
      configPath: fixture.configPath,
      mutableWorktreeRoot: fixture.mutableWorktreeRoot
    });

    await expect(provider.load(verificationInput("project-1"))).resolves.toEqual({
      required: [
        {
          name: "unit tests",
          argv: ["pnpm", "test"],
          covers: ["Tests pass"]
        }
      ]
    });
    await expect(
      provider.load(verificationInput("another-project"))
    ).resolves.toBeUndefined();
  });

  it("caches the reviewed baseline and returns mutation-safe plan copies", async () => {
    const fixture = await createProjectFixture(`
version: 1
verify:
  required:
    - name: project tests
      argv: [pnpm, test]
      covers: ["*"]
`);
    const provider = await createProjectYamlVerificationPlanProvider({
      projectId: "project-1",
      configPath: fixture.configPath,
      mutableWorktreeRoot: fixture.mutableWorktreeRoot
    });
    const first = await provider.load(verificationInput("project-1"));
    first!.required[0]!.argv[1] = "weakened";
    await writeFile(fixture.configPath, "invalid after startup", "utf8");

    await expect(provider.load(verificationInput("project-1"))).resolves.toEqual({
      required: [
        {
          name: "project tests",
          argv: ["pnpm", "test"],
          covers: ["*"]
        }
      ]
    });
  });

  it("rejects a config stored anywhere below the managed worktree root", async () => {
    const root = await mkdtemp(join(tmpdir(), "lecoding-mutable-config-"));
    temporaryRoots.push(root);
    const mutableWorktreeRoot = join(root, "worktrees");
    const mutableWorkspacePath = join(mutableWorktreeRoot, "run-1");
    const configDirectory = join(mutableWorkspacePath, ".ai-agent");
    await mkdir(configDirectory, { recursive: true });
    const configPath = join(configDirectory, "project.yaml");
    await writeFile(
      configPath,
      `version: 1\nverify:\n  required:\n    - name: tests\n      argv: [pnpm, test]\n      covers: ["*"]\n`,
      "utf8"
    );

    await expect(
      createProjectYamlVerificationPlanProvider({
        projectId: "project-1",
        configPath,
        mutableWorktreeRoot
      })
    ).rejects.toThrow("outside the mutable worktree root");
  });

  it("rejects shell-style string commands instead of guessing argv", async () => {
    const fixture = await createProjectFixture(`
version: 1
verify:
  required:
    - pnpm test
`);

    await expect(
      createProjectYamlVerificationPlanProvider({
        projectId: "project-1",
        configPath: fixture.configPath,
        mutableWorktreeRoot: fixture.mutableWorktreeRoot
      })
    ).rejects.toThrow("invalid object");
  });
});

async function createProjectFixture(projectYaml: string): Promise<{
  configPath: string;
  mutableWorktreeRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "lecoding-project-config-"));
  temporaryRoots.push(root);
  const configDirectory = join(root, "source", ".ai-agent");
  const mutableWorktreeRoot = join(root, "worktrees");
  const mutableWorkspacePath = join(mutableWorktreeRoot, "run-1");
  await Promise.all([
    mkdir(configDirectory, { recursive: true }),
    mkdir(mutableWorkspacePath, { recursive: true })
  ]);
  const configPath = join(configDirectory, "project.yaml");
  await writeFile(configPath, projectYaml, "utf8");
  return { configPath, mutableWorktreeRoot };
}

function verificationInput(projectId: string) {
  return {
    runId: "run-1",
    run: {
      projectId,
      environmentId: "environment-1",
      task: "Fix tests",
      acceptanceCriteria: ["Tests pass"],
      approvalMode: "auto_review" as const,
      fileAccessScope: "workspace_only" as const
    },
    environment: { changedFiles: ["src/test.ts"] }
  };
}
