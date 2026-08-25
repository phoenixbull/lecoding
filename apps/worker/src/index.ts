import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  createOpenAiCompatibleAgentModel,
  loadOpenAiCompatibleModelConfig,
  type ModelEnvironment
} from "@lecoding/openai-model";
import { createPolicyEngine } from "@lecoding/policy";
import type { Engine, RunRecoveryWorker } from "@lecoding/run-engine";
import {
  createInMemoryRunHandleRegistry,
  createIntervalLeaseHeartbeat,
  createIntervalRecoveryWorker,
  createPostgresRunCancelBus,
  createPostgresRunLease,
  createPostgresRunStore,
  createPostgresRunTransitionWriter,
  createPostgresToolCallLedger,
  createRunEngine,
  type PostgresExecutor,
  type PostgresNotifiable
} from "@lecoding/run-engine";
import { createDockerRunEnvironment } from "@lecoding/run-environment";
import {
  createPostgresRunEventRepository,
  createRunEventJournal
} from "@lecoding/run-events";
import type { Verifier } from "@lecoding/verifier";

/** Durable PostgreSQL resources supplied by the deployment-specific adapter. */
export interface WorkerDatabase {
  /** Shared pool used for queries, transactions, leases, and recovery scans. */
  executor: PostgresExecutor;
  /** Dedicated long-lived connection used by PostgreSQL LISTEN/NOTIFY. */
  notifications: PostgresNotifiable;
  /** Releases both resources after every Worker-owned consumer has stopped. */
  close(): Promise<void>;
}

/** Validated process settings needed to construct the production Worker. */
export interface WorkerConfig {
  workerId: string;
  worktreeRoot: string;
  workspacePath: string;
  dockerImage: string;
  recoveryIntervalMs: number;
}

/** Inputs whose concrete implementations belong to the deployment host. */
export interface ProductionWorkerOptions {
  database: WorkerDatabase;
  /** Production verification is injected until the dedicated verifier item lands. */
  verifier: Verifier;
  environment: ModelEnvironment;
  /** Deterministic clock seam shared by state and event persistence. */
  now?: () => string;
  /** Stable Run identifier seam; defaults to a cryptographically random UUID. */
  createId?: () => string;
}

/** Resources owned by one Worker process after dependency composition succeeds. */
export interface WorkerRuntimeResources {
  engine: Engine;
  recovery: RunRecoveryWorker;
  /** Closes the query pool and dedicated LISTEN connection after engine disposal. */
  closeDatabase(): Promise<void>;
}

/** Process lifecycle exposed to the executable entrypoint and deployment tests. */
export interface WorkerRuntime {
  /** Starts background recovery only after all durable dependencies exist. */
  start(): void;
  /** Stops producers before consumers, then releases durable connections. */
  stop(): Promise<void>;
}

/** Reads and validates security-sensitive Worker process settings. */
export function loadWorkerConfig(environment: ModelEnvironment): WorkerConfig {
  const workerId = requireSetting(environment, "LECODING_WORKER_ID");
  const worktreeRoot = requireAbsolutePath(
    environment,
    "LECODING_WORKTREE_ROOT"
  );
  const workspacePath = requireAbsolutePath(
    environment,
    "LECODING_WORKSPACE_PATH"
  );
  const workspaceWithinRoot = relative(worktreeRoot, workspacePath);
  if (
    workspaceWithinRoot === "" ||
    workspaceWithinRoot === ".." ||
    workspaceWithinRoot.startsWith(`..${sep}`) ||
    isAbsolute(workspaceWithinRoot)
  ) {
    throw new Error(
      "LECODING_WORKSPACE_PATH is outside LECODING_WORKTREE_ROOT"
    );
  }
  const dockerImage = requireSetting(environment, "LECODING_DOCKER_IMAGE");
  if (!/@sha256:[a-f0-9]{64}$/i.test(dockerImage)) {
    throw new Error(
      "LECODING_DOCKER_IMAGE must use an immutable sha256 digest"
    );
  }
  return {
    workerId,
    worktreeRoot,
    workspacePath,
    dockerImage,
    recoveryIntervalMs: readPositiveInteger(
      environment,
      "LECODING_RECOVERY_INTERVAL_MS",
      5_000
    )
  };
}

/**
 * Composes the production Worker around PostgreSQL durability, Docker isolation,
 * the configured OpenAI-compatible model, policy checks, and recovery scanning.
 * The deployment host remains responsible for creating real pg connections and
 * injecting a Verifier; ownership transfers here and close() runs on shutdown.
 */
export async function composeProductionWorker(
  options: ProductionWorkerOptions
): Promise<WorkerRuntime> {
  try {
    const config = loadWorkerConfig(options.environment);
    const modelConfig = loadOpenAiCompatibleModelConfig(options.environment);
    const now = options.now ?? (() => new Date().toISOString());
    /* Initialize schemas before accepting work, so startup fails as one unit. */
    const store = await createPostgresRunStore(options.database.executor);
    const transitions = await createPostgresRunTransitionWriter({
      database: options.database.executor,
      now
    });
    const toolCalls = await createPostgresToolCallLedger(
      options.database.executor
    );
    const lease = await createPostgresRunLease(options.database.executor);
    const events = createRunEventJournal({
      repository: createPostgresRunEventRepository(options.database.executor),
      now
    });
    const cancelBus = createPostgresRunCancelBus(
      options.database.notifications
    );
    const engine = await createRunEngine({
      store,
      transitions,
      toolCalls,
      lease,
      heartbeat: createIntervalLeaseHeartbeat(lease),
      handles: createInMemoryRunHandleRegistry(),
      cancelBus,
      environment: createDockerRunEnvironment({
        image: config.dockerImage,
        worktreeRoot: config.worktreeRoot,
        workspacePath: config.workspacePath,
        network: "none"
      }),
      model: createOpenAiCompatibleAgentModel({ config: modelConfig }),
      policy: createPolicyEngine(),
      events,
      verifier: options.verifier,
      workerId: config.workerId,
      now,
      createId: options.createId ?? randomUUID
    });
    const recovery = createIntervalRecoveryWorker({
      executor: options.database.executor,
      resumer: engine,
      intervalMs: config.recoveryIntervalMs,
      now
    });
    return createWorkerRuntime({
      engine,
      recovery,
      // Preserve adapters that implement close() as a receiver-bound method.
      closeDatabase: () => options.database.close()
    });
  } catch (error) {
    // Composition owns the supplied connections and must not leak on partial init.
    await options.database.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Owns Worker startup and reverse-order shutdown.
 * The caller must register process signals and await stop() before process exit.
 */
export function createWorkerRuntime(
  resources: WorkerRuntimeResources
): WorkerRuntime {
  let started = false;
  let stopPromise: Promise<void> | undefined;

  return {
    start() {
      if (stopPromise) {
        throw new Error("Worker runtime has stopped");
      }
      if (started) {
        return;
      }
      started = true;
      resources.recovery.start();
    },

    stop() {
      if (stopPromise) {
        return stopPromise;
      }
      /*
       * Stop recovery first so it cannot call resume while engine subscriptions
       * and database connections are being dismantled. Each cleanup is attempted
       * even after an earlier failure so a partial shutdown cannot leak the pool.
       */
      stopPromise = (async () => {
        const failures: unknown[] = [];
        for (const cleanup of [
          () => resources.recovery.stop(),
          () => resources.engine.dispose(),
          () => resources.closeDatabase()
        ]) {
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
          throw new AggregateError(failures, "Worker shutdown failed");
        }
      })();
      return stopPromise;
    }
  };
}

function requireSetting(
  environment: ModelEnvironment,
  name: string
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`Missing required Worker setting: ${name}`);
  }
  return value;
}

function requireAbsolutePath(
  environment: ModelEnvironment,
  name: string
): string {
  const value = requireSetting(environment, name);
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${name} must be a canonical absolute path`);
  }
  return value;
}

function readPositiveInteger(
  environment: ModelEnvironment,
  name: string,
  fallback: number
): number {
  const raw = environment[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
