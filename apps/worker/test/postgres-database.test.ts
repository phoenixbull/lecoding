import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createPostgresRunCancelBus } from "@lecoding/run-engine";
import {
  createPostgresWorkerDatabase,
  loadPostgresWorkerConfig,
  type WorkerPgClient,
  type WorkerPgPool
} from "../src/postgres-database.js";

const databaseEnvironment = {
  LECODING_DATABASE_URL: "postgresql://worker:secret@db.example/lecoding",
  LECODING_DATABASE_POOL_MAX: "7",
  LECODING_DATABASE_CONNECT_TIMEOUT_MS: "4500"
};

describe("loadPostgresWorkerConfig", () => {
  it("validates the PostgreSQL URI and bounded connection settings", () => {
    expect(loadPostgresWorkerConfig(databaseEnvironment)).toEqual({
      connectionString: databaseEnvironment.LECODING_DATABASE_URL,
      max: 7,
      connectionTimeoutMillis: 4500
    });
    expect(() =>
      loadPostgresWorkerConfig({ LECODING_DATABASE_URL: "https://db.example" })
    ).toThrow("PostgreSQL connection URI");
  });
});

describe("createPostgresWorkerDatabase", () => {
  it("uses the pool for queries and a connected dedicated client for LISTEN", async () => {
    const calls: string[] = [];
    const pool = createPool(calls);
    const client = createClient(calls);

    const database = await createPostgresWorkerDatabase({
      environment: databaseEnvironment,
      createPool: vi.fn(() => pool),
      createClient: vi.fn(() => client)
    });
    const stopListening = await database.notifications.listen(
      "run_engine_cancel",
      () => undefined
    );
    await database.executor.query("SELECT $1::text", ["run-1"]);
    await stopListening();
    await database.close();

    expect(calls).toEqual([
      "client.connect",
      "pool.query:SELECT 1",
      'client.query:LISTEN "run_engine_cancel"',
      "pool.query:SELECT $1::text",
      'client.query:UNLISTEN "run_engine_cancel"',
      "client.end",
      "pool.end"
    ]);
  });

  it("closes both partially initialized resources when readiness fails", async () => {
    const calls: string[] = [];
    const pool = createPool(calls);
    pool.query = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const client = createClient(calls);

    await expect(
      createPostgresWorkerDatabase({
        environment: databaseEnvironment,
        createPool: () => pool,
        createClient: () => client
      })
    ).rejects.toThrow("database unavailable");

    expect(calls).toEqual(["client.connect", "client.end", "pool.end"]);
  });

  it("shares concurrent close and attempts the pool after client shutdown fails", async () => {
    const calls: string[] = [];
    const pool = createPool(calls);
    const client = createClient(calls);
    client.end = vi.fn(async () => {
      calls.push("client.end");
      throw new Error("listener close failed");
    });
    const database = await createPostgresWorkerDatabase({
      environment: databaseEnvironment,
      createPool: () => pool,
      createClient: () => client
    });

    const first = database.close();
    const second = database.close();

    expect(second).toBe(first);
    await expect(first).rejects.toThrow("listener close failed");
    expect(calls.slice(-2)).toEqual(["client.end", "pool.end"]);
  });

  it("replaces a disconnected LISTEN session before the cancel bus subscribes again", async () => {
    const calls: string[] = [];
    const pool = createPool(calls);
    const clients = [createClient(calls), createClient(calls)];
    const createClientFactory = vi.fn(() => clients.shift()!);
    const database = await createPostgresWorkerDatabase({
      environment: databaseEnvironment,
      createPool: () => pool,
      createClient: createClientFactory
    });
    const bus = createPostgresRunCancelBus(database.notifications);
    const stop = await bus.subscribe(() => undefined);

    // A real pg.Client cannot be reused after disconnect; the wrapper must rotate it.
    const firstClient = createClientFactory.mock.results[0]!.value;
    firstClient.emit("error", new Error("network partition"));
    await vi.waitFor(() => expect(createClientFactory).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(calls.filter((call) => call === "client.connect")).toHaveLength(2)
    );

    await stop();
    await database.close();
  });
});

function createPool(calls: string[]): WorkerPgPool {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    query: vi.fn(async (sql: string) => {
      calls.push(`pool.query:${sql}`);
      return { rows: [] };
    }),
    end: vi.fn(async () => {
      calls.push("pool.end");
    })
  });
}

function createClient(calls: string[]): WorkerPgClient {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    connect: vi.fn(async () => {
      calls.push("client.connect");
    }),
    query: vi.fn(async (sql: string) => {
      calls.push(`client.query:${sql}`);
      return { rows: [] };
    }),
    end: vi.fn(async () => {
      calls.push("client.end");
    })
  });
}
