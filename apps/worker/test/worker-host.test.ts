import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WorkerDatabase } from "../src/index.js";
import {
  createWorkerProcessHost,
  type WorkerProcessSignals
} from "../src/worker-host.js";

describe("createWorkerProcessHost", () => {
  it("connects, composes, starts, and gracefully stops on SIGTERM", async () => {
    const calls: string[] = [];
    const signals = new EventEmitter() as WorkerProcessSignals;
    const database = createDatabase();
    const runtime = {
      control: createControlPlane(),
      start: vi.fn(() => calls.push("runtime.start")),
      stop: vi.fn(async () => {
        calls.push("runtime.stop");
      })
    };
    const onModelRetry = vi.fn();
    const host = createWorkerProcessHost({
      environment: {},
      signals,
      createDatabase: vi.fn(async () => {
        calls.push("database.connect");
        return database;
      }),
      composeWorker: vi.fn(async ({ database: supplied, onModelRetry: suppliedRetry }) => {
        expect(supplied).toBe(database);
        expect(suppliedRetry).toBe(onModelRetry);
        calls.push("worker.compose");
        return runtime;
      }),
      onModelRetry
    });

    await host.start();
    signals.emit("SIGTERM");
    await host.stop();

    expect(calls).toEqual([
      "database.connect",
      "worker.compose",
      "runtime.start",
      "runtime.stop"
    ]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("shares shutdown across duplicate signals and reports asynchronous failure", async () => {
    const signals = new EventEmitter() as WorkerProcessSignals;
    const failure = new Error("shutdown failed");
    const runtime = {
      control: createControlPlane(),
      start: vi.fn(),
      stop: vi.fn(async () => {
        throw failure;
      })
    };
    const onFatalError = vi.fn();
    const host = createWorkerProcessHost({
      environment: {},
      signals,
      createDatabase: async () => createDatabase(),
      composeWorker: async () => runtime,
      onFatalError
    });
    await host.start();

    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    await expect(host.stop()).rejects.toThrow("shutdown failed");
    await vi.waitFor(() => expect(onFatalError).toHaveBeenCalledWith(failure));
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });

  it("stops the HTTP control plane before stopping Worker resources", async () => {
    const calls: string[] = [];
    const signals = new EventEmitter() as WorkerProcessSignals;
    const runtime = {
      control: createControlPlane(),
      start: vi.fn(),
      stop: vi.fn(async () => {
        calls.push("runtime.stop");
      })
    };
    const host = createWorkerProcessHost({
      environment: {},
      signals,
      createDatabase: async () => createDatabase(),
      composeWorker: async () => runtime,
      startControlPlane: vi.fn(async () => {
        calls.push("api.start");
        return {
          stop: vi.fn(async () => {
            calls.push("api.stop");
          })
        };
      })
    });

    await host.start();
    await host.stop();

    expect(calls).toEqual(["api.start", "api.stop", "runtime.stop"]);
  });
});

function createDatabase(): WorkerDatabase {
  return {
    executor: { query: vi.fn(async () => ({ rows: [] })) },
    notifications: {
      query: vi.fn(async () => ({ rows: [] })),
      listen: vi.fn(async () => async () => undefined),
      onClientDisconnect: vi.fn(() => () => undefined)
    },
    close: vi.fn(async () => undefined)
  };
}

function createControlPlane() {
  return {
    defaultProjectId: "project-1",
    projectIds: ["project-1"],
    runs: {} as never,
    history: { list: vi.fn(async () => []) },
    changes: { read: vi.fn(async () => ({ changedFiles: [], unifiedDiff: "", truncated: false })) },
    eventStream: { handle: vi.fn() }
  };
}
