import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine, RunRecoveryWorker } from "@lecoding/run-engine";
import {
  composeProductionWorker,
  createWorkerRuntime,
  formatModelRetryLog,
  loadWorkerConfig,
  loadWorkerProjectRegistration,
  loadWorkerProjectRegistry
} from "../src/index.js";

describe("formatModelRetryLog", () => {
  it("projects only stable retry fields even when the caller supplies extra data", () => {
    const line = formatModelRetryLog({
      runId: "run-1",
      protocol: "openai_chat_completions",
      retryCount: 1,
      failureCategory: "tool_arguments_invalid_json",
      outcome: "recovered",
      responseBody: "must-not-leak"
    } as Parameters<typeof formatModelRetryLog>[0] & { responseBody: string });

    expect(JSON.parse(line)).toEqual({
      event: "model_malformed_json_retry",
      runId: "run-1",
      protocol: "openai_chat_completions",
      retryCount: 1,
      failureCategory: "tool_arguments_invalid_json",
      outcome: "recovered"
    });
    expect(line).not.toContain("must-not-leak");
  });
});

const validWorkerEnvironment = {
  LECODING_WORKER_ID: "worker-a",
  LECODING_PROJECT_ID: "project-1",
  LECODING_PROJECT_CONFIG_PATH: "/srv/lecoding/source/.ai-agent/project.yaml",
  LECODING_WORKTREE_ROOT: "/srv/lecoding/worktrees",
  LECODING_DOCKER_IMAGE:
    "registry.example/lecoding@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  LECODING_VERIFICATION_IMAGE:
    "registry.example/lecoding-verification@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  LECODING_MODEL_PROTOCOL: "openai_chat_completions",
  LECODING_MODEL_BASE_URL: "https://models.example/v1",
  LECODING_MODEL_API_KEY: "secret",
  LECODING_MODEL_ID: "model-a"
} as const;

describe("createWorkerRuntime", () => {
  it("starts recovery and shuts every owned resource down in reverse order", async () => {
    const calls: string[] = [];
    const engine = {
      dispose: vi.fn(async () => {
        calls.push("engine.dispose");
      })
    } as unknown as Engine;
    const recovery: RunRecoveryWorker = {
      start: vi.fn(() => {
        calls.push("recovery.start");
      }),
      stop: vi.fn(async () => {
        calls.push("recovery.stop");
      })
    };
    const eventDispatch = {
      start: vi.fn(() => calls.push("events.start")),
      stop: vi.fn(async () => {
        calls.push("events.stop");
      })
    };
    const closeDatabase = vi.fn(async () => {
      calls.push("database.close");
    });
    const runtime = createWorkerRuntime({
      engine,
      recovery,
      eventDispatch,
      control: createControlPlane(engine),
      closeDatabase
    });

    runtime.start();
    await runtime.stop();

    expect(calls).toEqual([
      "events.start",
      "recovery.start",
      "recovery.stop",
      "engine.dispose",
      "events.stop",
      "database.close"
    ]);
  });

  it("shares concurrent shutdown and still releases later resources after an error", async () => {
    const engine = {
      dispose: vi.fn(async () => {
        throw new Error("engine dispose failed");
      })
    } as unknown as Engine;
    const recovery: RunRecoveryWorker = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined)
    };
    const eventDispatch = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined)
    };
    const closeDatabase = vi.fn(async () => undefined);
    const runtime = createWorkerRuntime({
      engine,
      recovery,
      eventDispatch,
      control: createControlPlane(engine),
      closeDatabase
    });

    const firstStop = runtime.stop();
    const secondStop = runtime.stop();

    expect(secondStop).toBe(firstStop);
    await expect(firstStop).rejects.toThrow("engine dispose failed");
    expect(recovery.stop).toHaveBeenCalledTimes(1);
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it("does not restart background work after shutdown begins", async () => {
    const engine = { dispose: vi.fn(async () => undefined) } as unknown as Engine;
    const recovery: RunRecoveryWorker = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined)
    };
    const runtime = createWorkerRuntime({
      engine,
      recovery,
      eventDispatch: {
        start: vi.fn(),
        stop: vi.fn(async () => undefined)
      },
      control: createControlPlane(engine),
      closeDatabase: vi.fn(async () => undefined)
    });

    await runtime.stop();

    expect(() => runtime.start()).toThrow("Worker runtime has stopped");
    expect(recovery.start).not.toHaveBeenCalled();
  });
});

function createControlPlane(engine: Engine) {
  return {
    defaultProjectId: "project-1",
    projectIds: ["project-1"],
    runs: engine,
    history: { list: vi.fn(async () => []) },
    changes: { read: vi.fn(async () => ({ changedFiles: [], unifiedDiff: "", truncated: false })) },
    eventStream: {
      handle: vi.fn(async () => new Response("", { status: 200 }))
    }
  };
}

describe("composeProductionWorker", () => {
  it("wires durable adapters and awaits LISTEN cleanup before closing PostgreSQL", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "lecoding-worker-config-"));
    const worktreeRoot = join(fixtureRoot, "worktrees");
    const secondWorktreeRoot = join(fixtureRoot, "worktrees-2");
    const configDirectory = join(fixtureRoot, "source", ".ai-agent");
    const secondConfigDirectory = join(fixtureRoot, "source-2", ".ai-agent");
    const projectConfigPath = join(configDirectory, "project.yaml");
    const secondProjectConfigPath = join(secondConfigDirectory, "project.yaml");
    const registryPath = join(fixtureRoot, "projects.json");
    await Promise.all([
      mkdir(worktreeRoot, { recursive: true }),
      mkdir(secondWorktreeRoot, { recursive: true }),
      mkdir(configDirectory, { recursive: true }),
      mkdir(secondConfigDirectory, { recursive: true })
    ]);
    const projectYaml =
      `version: 1\nverify:\n  required:\n    - name: tests\n` +
      `      argv: [pnpm, test]\n      covers: [Tests pass]\n`;
    await Promise.all([
      writeFile(projectConfigPath, projectYaml, "utf8"),
      writeFile(secondProjectConfigPath, projectYaml, "utf8"),
      writeFile(
        registryPath,
        JSON.stringify({
          version: 1,
          projects: [
            {
              id: "project-1",
              configPath: projectConfigPath,
              worktreeRoot
            },
            {
              id: "project-2",
              configPath: secondProjectConfigPath,
              worktreeRoot: secondWorktreeRoot
            }
          ]
        }),
        "utf8"
      )
    ]);
    const calls: string[] = [];
    const executor = {
      query: vi.fn(async (sql: string) => {
        calls.push(`query:${sql.trim().split(/\s+/).slice(0, 3).join(" ")}`);
        return { rows: [] };
      })
    };
    const notifications = {
      query: executor.query,
      listen: vi.fn(async () => {
        calls.push("notifications.listen");
        return async () => {
          await Promise.resolve();
          calls.push("notifications.stop");
        };
      }),
      onClientDisconnect: vi.fn(() => () => undefined)
    };
    const close = vi.fn(async () => {
      calls.push("database.close");
    });
    try {
      const runtime = await composeProductionWorker({
        database: { executor, notifications, close },
        environment: {
          ...validWorkerEnvironment,
          LECODING_PROJECT_REGISTRY_PATH: registryPath,
          LECODING_WORKTREE_ROOT: worktreeRoot,
          LECODING_PROJECT_CONFIG_PATH: projectConfigPath
        }
      });

      runtime.start();
      expect(runtime.control.defaultProjectId).toBe("project-1");
      expect(runtime.control.projectIds).toEqual(["project-1", "project-2"]);
      await runtime.stop();

      expect(executor.query).toHaveBeenCalled();
      expect(notifications.listen).toHaveBeenCalledWith(
        "run_engine_cancel",
        expect.any(Function)
      );
      expect(calls.indexOf("notifications.stop")).toBeLessThan(
        calls.indexOf("database.close")
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("derives the reviewed source root without requiring a fixed Run workspace", () => {
    expect(loadWorkerProjectRegistration(validWorkerEnvironment)).toMatchObject({
      projectSourcePath: "/srv/lecoding/source",
      worktreeRoot: "/srv/lecoding/worktrees"
    });
  });

  it("loads exactly one administrator-controlled project registration", () => {
    expect(loadWorkerProjectRegistration(validWorkerEnvironment)).toEqual({
      projectId: "project-1",
      projectConfigPath: "/srv/lecoding/source/.ai-agent/project.yaml",
      projectSourcePath: "/srv/lecoding/source",
      worktreeRoot: "/srv/lecoding/worktrees"
    });
  });

  it("loads a strict versioned multi-project registry from an absolute file", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "lecoding-project-registry-"));
    const registryPath = join(fixtureRoot, "projects.json");
    const firstRoot = join(fixtureRoot, "worktrees-a");
    const secondRoot = join(fixtureRoot, "worktrees-b");
    await mkdir(join(fixtureRoot, "source-a", ".ai-agent"), { recursive: true });
    await mkdir(join(fixtureRoot, "source-b", ".ai-agent"), { recursive: true });
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    await writeFile(
      join(fixtureRoot, "source-a", ".ai-agent", "project.yaml"),
      "version: 1\n",
      "utf8"
    );
    await writeFile(
      join(fixtureRoot, "source-b", ".ai-agent", "project.yaml"),
      "version: 1\n",
      "utf8"
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: "project-a",
            configPath: join(fixtureRoot, "source-a", ".ai-agent", "project.yaml"),
            worktreeRoot: firstRoot
          },
          {
            id: "project-b",
            configPath: join(fixtureRoot, "source-b", ".ai-agent", "project.yaml"),
            worktreeRoot: secondRoot
          }
        ]
      }),
      "utf8"
    );
    const canonicalFixtureRoot = await realpath(fixtureRoot);
    try {
      await expect(
        loadWorkerProjectRegistry({ LECODING_PROJECT_REGISTRY_PATH: registryPath })
      ).resolves.toEqual([
        {
          projectId: "project-a",
          projectConfigPath: join(
            canonicalFixtureRoot,
            "source-a",
            ".ai-agent",
            "project.yaml"
          ),
          projectSourcePath: join(canonicalFixtureRoot, "source-a"),
          worktreeRoot: join(canonicalFixtureRoot, "worktrees-a")
        },
        {
          projectId: "project-b",
          projectConfigPath: join(
            canonicalFixtureRoot,
            "source-b",
            ".ai-agent",
            "project.yaml"
          ),
          projectSourcePath: join(canonicalFixtureRoot, "source-b"),
          worktreeRoot: join(canonicalFixtureRoot, "worktrees-b")
        }
      ]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects duplicate projects and overlapping worktree roots in the registry", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "lecoding-project-registry-"));
    const registryPath = join(fixtureRoot, "projects.json");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: "duplicate",
            configPath: join(fixtureRoot, "source-a", ".ai-agent", "project.yaml"),
            worktreeRoot: join(fixtureRoot, "worktrees")
          },
          {
            id: "duplicate",
            configPath: join(fixtureRoot, "source-b", ".ai-agent", "project.yaml"),
            worktreeRoot: join(fixtureRoot, "worktrees", "nested")
          }
        ]
      }),
      "utf8"
    );
    try {
      await expect(
        loadWorkerProjectRegistry({ LECODING_PROJECT_REGISTRY_PATH: registryPath })
      ).rejects.toThrow("duplicate or overlapping");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects worktree roots that alias the same canonical directory", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "lecoding-project-registry-"));
    const registryPath = join(fixtureRoot, "projects.json");
    const sharedWorktrees = join(fixtureRoot, "shared-worktrees");
    const aliasedWorktrees = join(fixtureRoot, "aliased-worktrees");
    const firstSourceRoot = join(fixtureRoot, "source-a");
    const secondSourceRoot = join(fixtureRoot, "source-b");
    await mkdir(join(firstSourceRoot, ".ai-agent"), { recursive: true });
    await mkdir(join(secondSourceRoot, ".ai-agent"), { recursive: true });
    await mkdir(sharedWorktrees);
    await symlink(sharedWorktrees, aliasedWorktrees);
    await writeFile(
      join(firstSourceRoot, ".ai-agent", "project.yaml"),
      "version: 1\n",
      "utf8"
    );
    await writeFile(
      join(secondSourceRoot, ".ai-agent", "project.yaml"),
      "version: 1\n",
      "utf8"
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: "project-a",
            configPath: join(firstSourceRoot, ".ai-agent", "project.yaml"),
            worktreeRoot: sharedWorktrees
          },
          {
            id: "project-b",
            configPath: join(secondSourceRoot, ".ai-agent", "project.yaml"),
            worktreeRoot: aliasedWorktrees
          }
        ]
      }),
      "utf8"
    );
    try {
      await expect(
        loadWorkerProjectRegistry({ LECODING_PROJECT_REGISTRY_PATH: registryPath })
      ).rejects.toThrow("duplicate or overlapping");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects a trusted source nested inside another project's mutable root", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "lecoding-project-registry-"));
    const registryPath = join(fixtureRoot, "projects.json");
    const firstWorktrees = join(fixtureRoot, "worktrees-a");
    const secondWorktrees = join(fixtureRoot, "worktrees-b");
    const firstSource = join(fixtureRoot, "source-a");
    const secondSource = join(firstWorktrees, "source-b");
    await mkdir(join(firstSource, ".ai-agent"), { recursive: true });
    await mkdir(join(secondSource, ".ai-agent"), { recursive: true });
    await mkdir(secondWorktrees);
    await writeFile(join(firstSource, ".ai-agent", "project.yaml"), "version: 1\n");
    await writeFile(join(secondSource, ".ai-agent", "project.yaml"), "version: 1\n");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: "project-a",
            configPath: join(firstSource, ".ai-agent", "project.yaml"),
            worktreeRoot: firstWorktrees
          },
          {
            id: "project-b",
            configPath: join(secondSource, ".ai-agent", "project.yaml"),
            worktreeRoot: secondWorktrees
          }
        ]
      }),
      "utf8"
    );
    try {
      await expect(
        loadWorkerProjectRegistry({ LECODING_PROJECT_REGISTRY_PATH: registryPath })
      ).rejects.toThrow("duplicate or overlapping");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("requires a separately pinned dependency-prepared verification image", () => {
    const { LECODING_VERIFICATION_IMAGE: _omitted, ...environment } =
      validWorkerEnvironment;

    expect(() => loadWorkerConfig(environment)).toThrow(
      "LECODING_VERIFICATION_IMAGE"
    );
    expect(loadWorkerConfig(validWorkerEnvironment).verificationImage).toBe(
      validWorkerEnvironment.LECODING_VERIFICATION_IMAGE
    );
  });

  it("accepts immutable local Docker image IDs for development hosts", () => {
    const runtimeImage = `sha256:${"c".repeat(64)}`;
    const verificationImage = `sha256:${"d".repeat(64)}`;

    expect(
      loadWorkerConfig({
        ...validWorkerEnvironment,
        LECODING_DOCKER_IMAGE: runtimeImage,
        LECODING_VERIFICATION_IMAGE: verificationImage
      })
    ).toMatchObject({ dockerImage: runtimeImage, verificationImage });
  });

  it("closes transferred database resources when configuration fails", async () => {
    const close = vi.fn(async () => undefined);

    await expect(
      composeProductionWorker({
        database: {
          executor: { query: vi.fn() },
          notifications: {
            query: vi.fn(),
            listen: vi.fn(),
            onClientDisconnect: vi.fn()
          },
          close
        },
        environment: {}
      })
    ).rejects.toThrow("LECODING_WORKER_ID");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
