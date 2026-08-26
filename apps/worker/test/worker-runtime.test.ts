import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine, RunRecoveryWorker } from "@lecoding/run-engine";
import {
  composeProductionWorker,
  createWorkerRuntime,
  loadWorkerConfig,
  loadWorkerProjectRegistration
} from "../src/index.js";

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
    projectId: "project-1",
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
    const configDirectory = join(fixtureRoot, "source", ".ai-agent");
    const projectConfigPath = join(configDirectory, "project.yaml");
    await Promise.all([
      mkdir(worktreeRoot, { recursive: true }),
      mkdir(configDirectory, { recursive: true })
    ]);
    await writeFile(
      projectConfigPath,
      `version: 1\nverify:\n  required:\n    - name: tests\n      argv: [pnpm, test]\n      covers: [Tests pass]\n`,
      "utf8"
    );
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
          LECODING_WORKTREE_ROOT: worktreeRoot,
          LECODING_PROJECT_CONFIG_PATH: projectConfigPath
        }
      });

      runtime.start();
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
    expect(loadWorkerConfig(validWorkerEnvironment)).toMatchObject({
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
