import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  createOpenAiCompatibleAgentModel,
  loadOpenAiCompatibleModelConfig,
  type ModelEnvironment
} from "@lecoding/openai-model";
import { createPolicyEngine } from "@lecoding/policy";
import type { Engine, RunHistory, RunRecoveryWorker } from "@lecoding/run-engine";
import {
  createInMemoryRunHandleRegistry,
  createIntervalLeaseHeartbeat,
  createIntervalRecoveryWorker,
  createPostgresRunCancelBus,
  createPostgresRunLease,
  createPostgresRunStore,
  createPostgresRunSteerMailbox,
  createPostgresRunTransitionWriter,
  createPostgresToolCallLedger,
  createRunEngine,
  type PostgresExecutor,
  type PostgresNotifiable
} from "@lecoding/run-engine";
import {
  createDockerRunEnvironment,
  createGitWorktreeRunEnvironmentFactory,
  createRoutedRunEnvironment
} from "@lecoding/run-environment";
import {
  createIntervalRunEventDispatchWorker,
  createPostgresRunEventRepository,
  createPostgresRunEventOutbox,
  createRunEventDispatcher,
  createRunEventJournal,
  createRunEventLiveBroadcaster,
  createRunEventSseHandler,
  type RunEventDispatchWorker,
  type RunEventSseHandler
} from "@lecoding/run-events";
import {
  createProjectYamlVerificationPlanProvider,
  createProductionVerifier
} from "@lecoding/verifier";
import {
  createGitRunChangesReader,
  createGitRunDiffSafetyChecker,
  createGitWorkspace,
  type RunChangesReader
} from "@lecoding/workspace";

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
  projectId: string;
  projectConfigPath: string;
  projectSourcePath: string;
  worktreeRoot: string;
  dockerImage: string;
  verificationImage: string;
  recoveryIntervalMs: number;
  eventDispatchIntervalMs: number;
}

/** Trusted single-project registration resolved before composing the Worker. */
export interface WorkerProjectRegistration {
  projectId: string;
  projectConfigPath: string;
  projectSourcePath: string;
  worktreeRoot: string;
}

/** Inputs whose concrete implementations belong to the deployment host. */
export interface ProductionWorkerOptions {
  database: WorkerDatabase;
  environment: ModelEnvironment;
  /** Deterministic clock seam shared by state and event persistence. */
  now?: () => string;
  /** Stable Run identifier seam; defaults to a cryptographically random UUID. */
  createId?: () => string;
  /** Receives recoverable background-loop failures without leaking into requests. */
  onBackgroundError?: (error: unknown) => void;
}

/** HTTP-facing seams exposed only after production composition succeeds. */
export interface WorkerControlPlane {
  projectId: string;
  runs: Engine;
  history: RunHistory;
  changes: RunChangesReader;
  eventStream: RunEventSseHandler;
}

/** Resources owned by one Worker process after dependency composition succeeds. */
export interface WorkerRuntimeResources {
  engine: Engine;
  recovery: RunRecoveryWorker;
  eventDispatch: RunEventDispatchWorker;
  control: WorkerControlPlane;
  /** Closes the query pool and dedicated LISTEN connection after engine disposal. */
  closeDatabase(): Promise<void>;
}

/** Process lifecycle exposed to the executable entrypoint and deployment tests. */
export interface WorkerRuntime {
  /** Versioned HTTP API dependencies bound to this Worker's trusted project. */
  readonly control: WorkerControlPlane;
  /** Starts background recovery only after all durable dependencies exist. */
  start(): void;
  /** Stops producers before consumers, then releases durable connections. */
  stop(): Promise<void>;
}

/** Reads and validates security-sensitive Worker process settings. */
export function loadWorkerConfig(environment: ModelEnvironment): WorkerConfig {
  const workerId = requireSetting(environment, "LECODING_WORKER_ID");
  const project = loadWorkerProjectRegistration(environment);
  const dockerImage = requireSetting(environment, "LECODING_DOCKER_IMAGE");
  if (!isImmutableDockerImageReference(dockerImage)) {
    throw new Error(
      "LECODING_DOCKER_IMAGE must use an immutable sha256 digest or image ID"
    );
  }
  const verificationImage = requireSetting(
    environment,
    "LECODING_VERIFICATION_IMAGE"
  );
  if (!isImmutableDockerImageReference(verificationImage)) {
    throw new Error(
      "LECODING_VERIFICATION_IMAGE must use an immutable sha256 digest or image ID"
    );
  }
  return {
    workerId,
    ...project,
    dockerImage,
    verificationImage,
    recoveryIntervalMs: readPositiveInteger(
      environment,
      "LECODING_RECOVERY_INTERVAL_MS",
      5_000
    ),
    eventDispatchIntervalMs: readPositiveInteger(
      environment,
      "LECODING_EVENT_DISPATCH_INTERVAL_MS",
      100
    )
  };
}

/** Accepts registry digests in deployment and exact image IDs on local Docker hosts. */
function isImmutableDockerImageReference(value: string): boolean {
  return /^(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})$/i.test(
    value
  );
}

/**
 * Loads the administrator-controlled project registry entry for this process.
 * Phase 1 intentionally permits exactly one project per Worker; a future
 * multi-project host can replace this seam without weakening config ownership.
 */
export function loadWorkerProjectRegistration(
  environment: ModelEnvironment
): WorkerProjectRegistration {
  const projectId = requireSetting(environment, "LECODING_PROJECT_ID");
  const projectConfigPath = requireAbsolutePath(
    environment,
    "LECODING_PROJECT_CONFIG_PATH"
  );
  const worktreeRoot = requireAbsolutePath(
    environment,
    "LECODING_WORKTREE_ROOT"
  );
  // The reviewed config is fixed at <source>/.ai-agent/project.yaml.
  const projectSourcePath = dirname(dirname(projectConfigPath));
  return { projectId, projectConfigPath, projectSourcePath, worktreeRoot };
}

export {
  createPostgresWorkerDatabase,
  loadPostgresWorkerConfig
} from "./postgres-database.js";
export type {
  PostgresWorkerConfig,
  PostgresWorkerDatabaseOptions,
  WorkerPgClient,
  WorkerPgPool
} from "./postgres-database.js";
export { createWorkerProcessHost } from "./worker-host.js";
export type {
  WorkerHostedControlPlane,
  WorkerProcessHost,
  WorkerProcessHostOptions,
  WorkerProcessSignals
} from "./worker-host.js";
export { createRunApiHandler } from "./api.js";
export type {
  RunApiHandler,
  RunApiHandlerOptions,
  RunApiOperations
} from "./api.js";
export {
  loadWorkerHttpConfig,
  startWorkerHttpServer
} from "./http-server.js";
export type {
  StartWorkerHttpServerOptions,
  WorkerHttpConfig,
  WorkerHttpServer
} from "./http-server.js";

/**
 * Composes the production Worker around PostgreSQL durability, Docker isolation,
 * the configured OpenAI-compatible model, policy checks, and recovery scanning.
 * The deployment host remains responsible for creating real pg connections and
 * loading reviewed plans; ownership transfers here and close() runs on shutdown.
 */
export async function composeProductionWorker(
  options: ProductionWorkerOptions
): Promise<WorkerRuntime> {
  try {
    const config = loadWorkerConfig(options.environment);
    const modelConfig = loadOpenAiCompatibleModelConfig(options.environment);
    const now = options.now ?? (() => new Date().toISOString());
    const verificationPlans =
      await createProjectYamlVerificationPlanProvider({
        projectId: config.projectId,
        configPath: config.projectConfigPath,
        mutableWorktreeRoot: config.worktreeRoot
      });
    /* Initialize schemas before accepting work, so startup fails as one unit. */
    const store = await createPostgresRunStore(options.database.executor);
    const transitions = await createPostgresRunTransitionWriter({
      database: options.database.executor,
      now
    });
    const toolCalls = await createPostgresToolCallLedger(
      options.database.executor
    );
    const steerMailbox = await createPostgresRunSteerMailbox({
      database: options.database.executor,
      now
    });
    const lease = await createPostgresRunLease(options.database.executor);
    const eventRepository = createPostgresRunEventRepository(
      options.database.executor
    );
    const events = createRunEventJournal({
      repository: eventRepository,
      now
    });
    const eventBroadcaster = createRunEventLiveBroadcaster();
    const cancelBus = createPostgresRunCancelBus(
      options.database.notifications
    );
    const workspace = createGitWorkspace({ worktreeRoot: config.worktreeRoot });
    const runtimeEnvironment = createRoutedRunEnvironment(
      createGitWorktreeRunEnvironmentFactory({
        workspace,
        sourceRepo: config.projectSourcePath,
        baseRef: "HEAD",
        createEnvironment: (workspacePath) =>
          createDockerRunEnvironment({
            image: config.dockerImage,
            worktreeRoot: config.worktreeRoot,
            workspacePath,
            network: "none"
          })
      })
    );
    const verificationEnvironment = createRoutedRunEnvironment({
      create(spec) {
        /* Verification reuses the exact Run worktree but an independent container. */
        const workspacePath = join(config.worktreeRoot, spec.runId);
        return createDockerRunEnvironment({
          image: config.verificationImage,
          worktreeRoot: config.worktreeRoot,
          workspacePath,
          containerWorkspacePath: "/workspace/project",
          dependencyVolumePath: "/workspace/project/node_modules",
          network: "none"
        });
      }
    });
    const engine = await createRunEngine({
      store,
      transitions,
      toolCalls,
      steerMailbox,
      lease,
      heartbeat: createIntervalLeaseHeartbeat(lease),
      handles: createInMemoryRunHandleRegistry(),
      cancelBus,
      environment: runtimeEnvironment,
      model: createOpenAiCompatibleAgentModel({ config: modelConfig }),
      policy: createPolicyEngine(),
      events,
      verifier: createProductionVerifier({
        plans: verificationPlans,
        environment: verificationEnvironment,
        // Git metadata stays host-owned while the verifier reuses the isolated patch.
        diffSafety: createGitRunDiffSafetyChecker({
          sourceRepo: config.projectSourcePath,
          worktreeRoot: config.worktreeRoot
        })
      }),
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
    const eventDispatch = createIntervalRunEventDispatchWorker({
      dispatcher: createRunEventDispatcher({
        outbox: createPostgresRunEventOutbox(options.database.executor),
        target: eventBroadcaster,
        workerId: `${config.workerId}:events`,
        batchSize: 100,
        leaseMilliseconds: 30_000,
        now
      }),
      intervalMs: config.eventDispatchIntervalMs,
      ...(options.onBackgroundError
        ? { onError: options.onBackgroundError }
        : {})
    });
    return createWorkerRuntime({
      engine,
      recovery,
      eventDispatch,
      control: {
        projectId: config.projectId,
        runs: engine,
        history: store,
        changes: createGitRunChangesReader({
          sourceRepo: config.projectSourcePath,
          worktreeRoot: config.worktreeRoot
        }),
        eventStream: createRunEventSseHandler({
          journal: events,
          broadcaster: eventBroadcaster
        })
      },
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
    control: resources.control,
    start() {
      if (stopPromise) {
        throw new Error("Worker runtime has stopped");
      }
      if (started) {
        return;
      }
      started = true;
      resources.eventDispatch.start();
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
          () => resources.eventDispatch.stop(),
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
