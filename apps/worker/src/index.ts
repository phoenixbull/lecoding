import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createOpenAiCompatibleAgentModel,
  loadOpenAiCompatibleModelConfig,
  type ModelEnvironment,
  type OpenAiMalformedJsonRetryEvent
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
  createProductionVerifier,
  type Verifier
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
  dockerImage: string;
  verificationImage: string;
  recoveryIntervalMs: number;
  eventDispatchIntervalMs: number;
}

/** Trusted project registration resolved before composing the Worker. */
export interface WorkerProjectRegistration {
  projectId: string;
  projectConfigPath: string;
  projectSourcePath: string;
  worktreeRoot: string;
}

const MAX_PROJECT_REGISTRY_BYTES = 64 * 1024;

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
  /** Receives provider retry telemetry containing only stable enums and Run identity. */
  onModelRetry?: (event: OpenAiMalformedJsonRetryEvent) => void;
}

/** Serializes the fixed retry projection without spreading caller-owned fields. */
export function formatModelRetryLog(event: OpenAiMalformedJsonRetryEvent): string {
  return JSON.stringify({
    event: "model_malformed_json_retry",
    runId: event.runId,
    protocol: event.protocol,
    retryCount: event.retryCount,
    failureCategory: event.failureCategory,
    outcome: event.outcome
  });
}

/** HTTP-facing seams exposed only after production composition succeeds. */
export interface WorkerControlPlane {
  defaultProjectId: string;
  projectIds: readonly string[];
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
 * Loads the legacy administrator-controlled project tuple used when no registry
 * path is configured.
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

/**
 * Loads the administrator-owned project allowlist, falling back to the legacy
 * single-project variables when no registry path is configured.
 */
export async function loadWorkerProjectRegistry(
  environment: ModelEnvironment
): Promise<WorkerProjectRegistration[]> {
  const registryPath = environment.LECODING_PROJECT_REGISTRY_PATH?.trim();
  if (!registryPath) {
    return [loadWorkerProjectRegistration(environment)];
  }
  if (!isAbsolute(registryPath) || resolve(registryPath) !== registryPath) {
    throw new Error("LECODING_PROJECT_REGISTRY_PATH must be a canonical absolute path");
  }
  const registryStat = await stat(registryPath);
  if (!registryStat.isFile() || registryStat.size > MAX_PROJECT_REGISTRY_BYTES) {
    throw new Error("Project registry exceeds 64 KiB or is not a file");
  }
  const source = await readFile(registryPath, "utf8");
  if (Buffer.byteLength(source, "utf8") > MAX_PROJECT_REGISTRY_BYTES) {
    throw new Error("Project registry exceeds 64 KiB");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(source) as unknown;
  } catch {
    throw new Error("Project registry contains invalid JSON");
  }
  const root = requireRegistryRecord(decoded);
  requireRegistryKeys(root, ["version", "projects"]);
  if (root.version !== 1 || !Array.isArray(root.projects) || root.projects.length === 0) {
    throw new Error("Project registry requires version 1 and at least one project");
  }
  const registrations = root.projects.map((value) => {
    const entry = requireRegistryRecord(value);
    requireRegistryKeys(entry, ["id", "configPath", "worktreeRoot"]);
    if (
      typeof entry.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/u.test(entry.id) ||
      typeof entry.configPath !== "string" ||
      !isAbsolute(entry.configPath) ||
      resolve(entry.configPath) !== entry.configPath ||
      typeof entry.worktreeRoot !== "string" ||
      !isAbsolute(entry.worktreeRoot) ||
      resolve(entry.worktreeRoot) !== entry.worktreeRoot
    ) {
      throw new Error("Project registry contains an invalid project entry");
    }
    return {
      projectId: entry.id,
      projectConfigPath: entry.configPath,
      projectSourcePath: dirname(dirname(entry.configPath)),
      worktreeRoot: entry.worktreeRoot
    };
  });
  for (let index = 0; index < registrations.length; index += 1) {
    const current = registrations[index]!;
    for (let peerIndex = 0; peerIndex < index; peerIndex += 1) {
      const peer = registrations[peerIndex]!;
      if (
        current.projectId === peer.projectId ||
        current.projectConfigPath === peer.projectConfigPath ||
        pathsOverlap(current.worktreeRoot, peer.worktreeRoot)
      ) {
        throw new Error("Project registry contains duplicate or overlapping entries");
      }
    }
  }
  let canonicalRegistrations: WorkerProjectRegistration[];
  try {
    canonicalRegistrations = await Promise.all(
      registrations.map(async (registration) => {
        // Canonical paths prevent two lexical aliases from sharing a trust boundary.
        const [projectConfigPath, worktreeRoot] = await Promise.all([
          realpath(registration.projectConfigPath),
          realpath(registration.worktreeRoot)
        ]);
        return {
          ...registration,
          projectConfigPath,
          projectSourcePath: dirname(dirname(projectConfigPath)),
          worktreeRoot
        };
      })
    );
  } catch {
    throw new Error("Project registry paths must reference existing trusted resources");
  }
  for (let index = 0; index < canonicalRegistrations.length; index += 1) {
    const current = canonicalRegistrations[index]!;
    for (let peerIndex = 0; peerIndex < index; peerIndex += 1) {
      const peer = canonicalRegistrations[peerIndex]!;
      if (
        current.projectId === peer.projectId ||
        current.projectConfigPath === peer.projectConfigPath ||
        current.projectSourcePath === peer.projectSourcePath ||
        pathsOverlap(current.worktreeRoot, peer.worktreeRoot)
      ) {
        throw new Error("Project registry contains duplicate or overlapping entries");
      }
    }
    for (const registration of canonicalRegistrations) {
      // No project's mutable worktrees may contain or sit within a trusted source.
      if (pathsOverlap(current.projectSourcePath, registration.worktreeRoot)) {
        throw new Error("Project registry contains duplicate or overlapping entries");
      }
    }
  }
  return canonicalRegistrations;
}

function requireRegistryRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Project registry contains an invalid object");
  }
  return value as Record<string, unknown>;
}

function requireRegistryKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("Project registry contains an unknown field");
  }
}

function pathsOverlap(first: string, second: string): boolean {
  return isPathWithin(first, second) || isPathWithin(second, first);
}

function isPathWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
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
    const projects = await loadWorkerProjectRegistry(options.environment);
    const projectById = new Map(
      projects.map((project) => [project.projectId, project] as const)
    );
    const modelConfig = loadOpenAiCompatibleModelConfig(options.environment);
    const now = options.now ?? (() => new Date().toISOString());
    const runtimeFactories = new Map(
      projects.map((project) => {
        const workspace = createGitWorkspace({ worktreeRoot: project.worktreeRoot });
        return [
          project.projectId,
          createGitWorktreeRunEnvironmentFactory({
            workspace,
            sourceRepo: project.projectSourcePath,
            baseRef: "HEAD",
            createEnvironment: (workspacePath) =>
              createDockerRunEnvironment({
                image: config.dockerImage,
                worktreeRoot: project.worktreeRoot,
                workspacePath,
                network: "none"
              })
          })
        ] as const;
      })
    );
    const verifiers = new Map<string, Verifier>();
    for (const project of projects) {
      const plans = await createProjectYamlVerificationPlanProvider({
        projectId: project.projectId,
        configPath: project.projectConfigPath,
        mutableWorktreeRoot: project.worktreeRoot
      });
      const verificationEnvironment = createRoutedRunEnvironment({
        create(spec) {
          if (spec.projectId !== project.projectId) {
            throw new Error("Verification environment received a mismatched project");
          }
          /* Verification reuses only this project's exact managed Run worktree. */
          const workspacePath = join(project.worktreeRoot, spec.runId);
          return createDockerRunEnvironment({
            image: config.verificationImage,
            worktreeRoot: project.worktreeRoot,
            workspacePath,
            containerWorkspacePath: "/workspace/project",
            dependencyVolumePath: "/workspace/project/node_modules",
            network: "none"
          });
        }
      });
      verifiers.set(
        project.projectId,
        createProductionVerifier({
          plans,
          environment: verificationEnvironment,
          diffSafety: createGitRunDiffSafetyChecker({
            sourceRepo: project.projectSourcePath,
            worktreeRoot: project.worktreeRoot
          })
        })
      );
    }
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
    const runtimeEnvironment = createRoutedRunEnvironment({
      create(spec) {
        const factory = runtimeFactories.get(spec.projectId);
        if (!factory) {
          throw new Error("Run requested an unregistered project");
        }
        return factory.create(spec);
      }
    });
    const verifier: Verifier = {
      verify(input, signal) {
        const selected = verifiers.get(input.run.projectId);
        if (!selected) {
          return Promise.resolve({
            outcome: "inconclusive",
            checks: [
              {
                name: "project registration",
                outcome: "inconclusive",
                detail: "Run project is not registered by this Worker"
              }
            ]
          });
        }
        return selected.verify(input, signal);
      }
    };
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
      model: createOpenAiCompatibleAgentModel({
        config: modelConfig,
        ...(options.onModelRetry
          ? { onMalformedJsonRetry: options.onModelRetry }
          : {})
      }),
      policy: createPolicyEngine(),
      events,
      verifier,
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
        defaultProjectId: projects[0]!.projectId,
        projectIds: projects.map((project) => project.projectId),
        runs: engine,
        history: store,
        changes: {
          async read(runId) {
            const run = await engine.inspect(runId);
            const project = projectById.get(run.projectId);
            if (!project) {
              throw new Error("Run project is not registered by this Worker");
            }
            return createGitRunChangesReader({
              sourceRepo: project.projectSourcePath,
              worktreeRoot: project.worktreeRoot
            }).read(runId);
          }
        },
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
