import { Client, Pool, type ClientConfig, type PoolConfig } from "pg";
import type { EventEmitter } from "node:events";
import {
  wrapPgClient,
  type PostgresExecutor,
  type PostgresNotifiable
} from "@lecoding/run-engine";
import type { ModelEnvironment } from "@lecoding/openai-model";
import type { WorkerDatabase } from "./index.js";

/** Validated node-postgres settings owned by one Worker process. */
export interface PostgresWorkerConfig {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
}

/** Minimal Pool surface used by the deployment adapter and its tests. */
export interface WorkerPgPool extends EventEmitter, PostgresExecutor {
  end(): Promise<void>;
}

/** Minimal dedicated Client surface required for LISTEN/NOTIFY. */
export interface WorkerPgClient extends EventEmitter {
  connect(): Promise<void>;
  query(sql: string, parameters?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

/** Real Worker database plus a connection-local operational diagnostic seam. */
export interface PostgresWorkerDatabase extends WorkerDatabase {
  /** Ends only this Worker's LISTEN session so reconnection can be smoke-tested. */
  disconnectNotifications(): Promise<void>;
}

/** Injectable constructors keep readiness and cleanup behavior testable without PostgreSQL. */
export interface PostgresWorkerDatabaseOptions {
  environment: ModelEnvironment;
  createPool?: (config: PoolConfig) => WorkerPgPool;
  createClient?: (config: ClientConfig) => WorkerPgClient;
  /** Receives idle-pool failures without exposing the connection URI. */
  onUnexpectedError?: (error: unknown) => void;
}

/** Reads the database URI and conservative pool readiness limits. */
export function loadPostgresWorkerConfig(
  environment: ModelEnvironment
): PostgresWorkerConfig {
  const connectionString = environment.LECODING_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("Missing required Worker setting: LECODING_DATABASE_URL");
  }
  let protocol: string;
  try {
    protocol = new URL(connectionString).protocol;
  } catch {
    throw new Error("LECODING_DATABASE_URL must be a PostgreSQL connection URI");
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error("LECODING_DATABASE_URL must be a PostgreSQL connection URI");
  }
  return {
    connectionString,
    max: readBoundedInteger(environment, "LECODING_DATABASE_POOL_MAX", 10, 1, 100),
    connectionTimeoutMillis: readBoundedInteger(
      environment,
      "LECODING_DATABASE_CONNECT_TIMEOUT_MS",
      5_000,
      100,
      120_000
    )
  };
}

/**
 * Creates the real PostgreSQL resources for one Worker.
 * Queries use a bounded Pool while cancellation subscriptions keep a dedicated
 * session, because PostgreSQL LISTEN state belongs to a single connection.
 */
export async function createPostgresWorkerDatabase(
  options: PostgresWorkerDatabaseOptions
): Promise<PostgresWorkerDatabase> {
  const config = loadPostgresWorkerConfig(options.environment);
  const poolConfig: PoolConfig = {
    connectionString: config.connectionString,
    max: config.max,
    connectionTimeoutMillis: config.connectionTimeoutMillis
  };
  const createPool =
    options.createPool ??
    ((value: PoolConfig) => new Pool(value) as unknown as WorkerPgPool);
  const createClient =
    options.createClient ??
    ((value: ClientConfig) => new Client(value) as unknown as WorkerPgClient);
  const pool = createPool(poolConfig);
  const listener = createRotatingNotificationClient(createClient, poolConfig);

  /* Pool errors need a listener or EventEmitter turns them into process crashes. */
  pool.on("error", (error: unknown) => {
    options.onUnexpectedError?.(error);
  });

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }
    closePromise = closePostgresResources(listener, pool);
    return closePromise;
  };

  try {
    // Connect LISTEN first, then force the otherwise-lazy Pool to prove readiness.
    await listener.connect();
    await pool.query("SELECT 1");
    return {
      executor: pool,
      notifications: {
        // Publishing is an ordinary query and must not interfere with LISTEN state.
        query: pool.query.bind(pool) as PostgresNotifiable["query"],
        listen: listener.listen,
        onClientDisconnect: listener.onClientDisconnect
      },
      disconnectNotifications: listener.disconnect,
      close
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

async function closePostgresResources(
  listener: RotatingNotificationClient,
  pool: WorkerPgPool
): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of [() => listener.close(), () => pool.end()]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "PostgreSQL shutdown failed");
  }
}

interface NotificationClientState {
  client: WorkerPgClient;
  disconnected: boolean;
}

interface RotatingNotificationClient {
  connect(): Promise<void>;
  listen: PostgresNotifiable["listen"];
  onClientDisconnect: PostgresNotifiable["onClientDisconnect"];
  disconnect(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Recreates the dedicated session after error/end. node-postgres Client objects
 * represent one backend session and are not treated as reusable after disconnect.
 */
function createRotatingNotificationClient(
  createClient: (config: ClientConfig) => WorkerPgClient,
  config: ClientConfig
): RotatingNotificationClient {
  const clients = new Set<WorkerPgClient>();
  const disconnectHandlers = new Set<() => void>();
  let current: NotificationClientState | undefined;
  let connecting: Promise<NotificationClientState> | undefined;
  let closing = false;

  const markDisconnected = (state: NotificationClientState): void => {
    if (closing || state.disconnected) {
      return;
    }
    state.disconnected = true;
    for (const handler of disconnectHandlers) {
      try {
        handler();
      } catch {
        // A consumer failure must not interrupt other disconnect subscribers.
      }
    }
  };

  const connect = async (): Promise<NotificationClientState> => {
    if (current && !current.disconnected) {
      return current;
    }
    if (connecting) {
      return connecting;
    }
    connecting = (async () => {
      const client = createClient(config);
      const state: NotificationClientState = { client, disconnected: false };
      clients.add(client);
      client.on("error", () => markDisconnected(state));
      client.on("end", () => markDisconnected(state));
      await client.connect();
      current = state;
      return state;
    })();
    try {
      return await connecting;
    } finally {
      connecting = undefined;
    }
  };

  return {
    async connect() {
      await connect();
    },
    listen: async (channel, callback) => {
      const state = await connect();
      return wrapPgClient(state.client).listen(channel, callback);
    },
    onClientDisconnect(handler) {
      disconnectHandlers.add(handler);
      return () => {
        disconnectHandlers.delete(handler);
      };
    },
    async disconnect() {
      const state = current;
      if (!state || state.disconnected) {
        return;
      }
      await state.client.end();
      // Some Client doubles do not emit `end`; preserve the disconnect contract.
      markDisconnected(state);
      clients.delete(state.client);
      if (current === state) {
        current = undefined;
      }
    },
    async close() {
      closing = true;
      const failures: unknown[] = [];
      for (const client of clients) {
        try {
          await client.end();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "PostgreSQL listener shutdown failed");
      }
    }
  };
}

function readBoundedInteger(
  environment: ModelEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = environment[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}
