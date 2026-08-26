import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine, RunRecoveryWorker } from "@lecoding/run-engine";
import {
  composeProductionWorker,
  createWorkerRuntime,
  loadWorkerConfig
} from "../src/index.js";

const validWorkerEnvironment = {
  LECODING_WORKER_ID: "worker-a",
  LECODING_PROJECT_ID: "project-1",
  LECODING_PROJECT_CONFIG_PATH: "/srv/lecoding/source/.ai-agent/project.yaml",
  LECODING_WORKTREE_ROOT: "/srv/lecoding/worktrees",
  LECODING_WORKSPACE_PATH: "/srv/lecoding/worktrees/run-a",
  LECODING_DOCKER_IMAGE:
    "registry.example/lecoding@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    const closeDatabase = vi.fn(async () => {
      calls.push("database.close");
    });
    const runtime = createWorkerRuntime({ engine, recovery, closeDatabase });

    runtime.start();
    await runtime.stop();

    expect(calls).toEqual([
      "recovery.start",
      "recovery.stop",
      "engine.dispose",
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
    const closeDatabase = vi.fn(async () => undefined);
    const runtime = createWorkerRuntime({ engine, recovery, closeDatabase });

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
      closeDatabase: vi.fn(async () => undefined)
    });

    await runtime.stop();

    expect(() => runtime.start()).toThrow("Worker runtime has stopped");
    expect(recovery.start).not.toHaveBeenCalled();
  });
});

describe("composeProductionWorker", () => {
  it("wires durable adapters and awaits LISTEN cleanup before closing PostgreSQL", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "lecoding-worker-config-"));
    const worktreeRoot = join(fixtureRoot, "worktrees");
    const workspacePath = join(worktreeRoot, "run-a");
    const configDirectory = join(fixtureRoot, "source", ".ai-agent");
    const projectConfigPath = join(configDirectory, "project.yaml");
    await Promise.all([
      mkdir(workspacePath, { recursive: true }),
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
          LECODING_WORKSPACE_PATH: workspacePath,
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

  it("rejects a workspace outside the registered root during startup", () => {
    expect(() =>
      loadWorkerConfig({
        ...validWorkerEnvironment,
        LECODING_WORKSPACE_PATH: "/srv/other/run-a"
      })
    ).toThrow("outside LECODING_WORKTREE_ROOT");
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
