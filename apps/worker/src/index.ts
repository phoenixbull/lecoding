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
import type {
  ArtifactRetentionReport,
  ArtifactRetentionWorker,
  Engine,
  RecoveryJobQueue,
  RunHistory,
  RunRecoveryWorker,
  RunBudgetLimits,
  RunModelPricing
} from "@lecoding/run-engine";
import {
  createInMemoryRunHandleRegistry,
  createIntervalArtifactRetentionWorker,
  createIntervalLeaseHeartbeat,
  createPgBossRecoveryWorker,
  createPostgresRunCancelBus,
  createPostgresRunBudgetManager,
  createPostgresLocalArtifactStore,
  createPostgresApprovalLedger,
  createPostgresPolicyReviewAudit,
  createPostgresProjectPolicyRules,
  createPostgresRunLease,
  createPostgresRunStore,
  createPostgresRunSteerMailbox,
  createPostgresRunTransitionWriter,
  createPostgresToolCallLedger,
  createRunEngine,
  RunBudgetExceededError,
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
  createPostgresRunOperationalActionRecorder,
  createPostgresRunOperationalMetricsReader,
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
  createDeviceBindingHttpHandler,
  createDeviceBindingService
} from "@lecoding/device-binding";
import { createPostgresDeviceBindingStore } from "@lecoding/device-binding/postgres";
import {
  createGitRunChangesReader,
  createGitRunDiffSafetyChecker,
  createGitRunResultManager,
  createGitWorkspace,
  type RunChangesReader,
  type RunResultManager
} from "@lecoding/workspace";
import { createProductionPgBossRecoveryQueue } from "./pg-boss-recovery.js";
import type {
  RunApiAccessControl,
  RunApiMembershipAdministration,
  RunApiProjectPolicyAdministration
} from "./api.js";
import { createPostgresRunApiAccessControl } from "./postgres-access-control.js";
import { createDeviceAwareAccessControl } from "./device-access.js";
import {
  createGitHubOAuthLogin,
  loadGitHubOAuthConfig,
  type GitHubOAuthLogin
} from "./github-oauth.js";

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
  /** Provider-neutral per-request envelope enforced before any billable call. */
  modelRequestLimits: {
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  budgetLimits: RunBudgetLimits;
  pricing: RunModelPricing;
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
  /** Receives content-free seven-day cleanup counts and residual storage keys. */
  onArtifactRetentionReport?: (report: ArtifactRetentionReport) => void;
  /** Test/deployment seam for supplying the durable pg-boss queue adapter. */
  createRecoveryQueue?: (executor: PostgresExecutor) => RecoveryJobQueue;
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

/**
 * Builds the persistence-boundary redactor from administrator-owned credentials.
 * Exact configured values are removed before generic bearer/API-key shapes.
 */
export function createDeploymentSecretRedactor(
  environment: ModelEnvironment
): (value: string) => string {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(environment)) {
    const normalized = value?.trim();
    if (
      normalized &&
      /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/u.test(name) &&
      normalized.length >= 4
    ) {
      secrets.add(normalized);
    }
  }
  const databaseUrl = environment.LECODING_DATABASE_URL?.trim();
  if (databaseUrl) {
    secrets.add(databaseUrl);
    try {
      const password = decodeURIComponent(new URL(databaseUrl).password);
      if (password.length >= 4) {
        secrets.add(password);
      }
    } catch {
      // Database configuration validation owns malformed-URL failure reporting.
    }
  }
  const orderedSecrets = [...secrets].sort((left, right) => right.length - left.length);
  return (value) => {
    let redacted = value;
    for (const secret of orderedSecrets) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
    /* Provider-shaped keys and bearer values can be emitted even when they were
     * not sourced from this Worker's own deployment environment. */
    return redacted
      .replace(/\bBearer\s+([A-Za-z0-9._~+/=-]{4,})/giu, (match, token: string) =>
        /[0-9._~+/=-]/u.test(token) ? "Bearer [REDACTED]" : match
      )
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]");
  };
}

/** HTTP-facing seams exposed only after production composition succeeds. */
export interface WorkerControlPlane {
  defaultProjectId: string;
  projectIds: readonly string[];
  runs: Engine;
  history: RunHistory;
  changes: RunChangesReader;
  results: RunResultManager;
  artifacts?: import("@lecoding/run-engine").PostgresLocalArtifactStore;
  access: RunApiAccessControl;
  memberships?: RunApiMembershipAdministration;
  projectPolicy?: RunApiProjectPolicyAdministration;
  /** Content-free operational metrics derived from the durable Run timeline. */
  metrics?: import("@lecoding/run-events").RunOperationalMetricsReader;
  /** Durable successful keep/discard outcome recorder. */
  actions?: import("@lecoding/run-events").RunOperationalActionRecorder;
  login?: GitHubOAuthLogin & {
    revokeRequestSession(request: Request): Promise<void>;
  };
  eventStream: RunEventSseHandler;
  /**
   * Device binding routes (`/api/v1/devices/*`). Optional in tests, but a real
   * Worker must mount them or the desktop client can never bind a device.
   */
  devices?: import("@lecoding/device-binding").DeviceBindingHttpHandler;
}

/** Resources owned by one Worker process after dependency composition succeeds. */
export interface WorkerRuntimeResources {
  engine: Engine;
  recovery: RunRecoveryWorker;
  eventDispatch: RunEventDispatchWorker;
  artifactRetention?: ArtifactRetentionWorker;
  control: WorkerControlPlane;
  /** Closes the query pool and dedicated LISTEN connection after engine disposal. */
  closeDatabase(): Promise<void>;
}

/** Process lifecycle exposed to the executable entrypoint and deployment tests. */
export interface WorkerRuntime {
  /** Versioned HTTP API dependencies bound to this Worker's trusted project. */
  readonly control: WorkerControlPlane;
  /** Starts background recovery only after all durable dependencies exist. */
  start(): Promise<void>;
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
  const teamMonthlyMaxUsd = readFiniteAmount(
    environment,
    "LECODING_TEAM_MONTHLY_MAX_USD",
    undefined,
    true
  );
  const warningCostUsd = readFiniteAmount(
    environment,
    "LECODING_RUN_COST_WARNING_USD",
    1
  );
  const maxCostUsd = readFiniteAmount(
    environment,
    "LECODING_RUN_COST_MAX_USD",
    2,
    true
  );
  const teamMonthlyWarningUsd = readFiniteAmount(
    environment,
    "LECODING_TEAM_MONTHLY_WARNING_USD",
    teamMonthlyMaxUsd * 0.8
  );
  // Warning bands must remain reachable before their corresponding hard stop.
  assertWarningAtOrBelowMax(
    "LECODING_RUN_COST_WARNING_USD",
    warningCostUsd,
    "LECODING_RUN_COST_MAX_USD",
    maxCostUsd
  );
  assertWarningAtOrBelowMax(
    "LECODING_TEAM_MONTHLY_WARNING_USD",
    teamMonthlyWarningUsd,
    "LECODING_TEAM_MONTHLY_MAX_USD",
    teamMonthlyMaxUsd
  );
  return {
    workerId,
    dockerImage,
    verificationImage,
    recoveryIntervalMs: readPositiveInteger(
      environment,
      "LECODING_RECOVERY_INTERVAL_MS",
      5_000,
      3_600_000
    ),
    eventDispatchIntervalMs: readPositiveInteger(
      environment,
      "LECODING_EVENT_DISPATCH_INTERVAL_MS",
      100
    ),
    modelRequestLimits: {
      maxInputTokens: readPositiveInteger(
        environment,
        "LECODING_MODEL_MAX_INPUT_TOKENS",
        240_000,
        2_000_000
      ),
      maxOutputTokens: readPositiveInteger(
        environment,
        "LECODING_MODEL_MAX_OUTPUT_TOKENS",
        16_000,
        1_000_000
      )
    },
    budgetLimits: {
      maxTotalTokens: readPositiveInteger(
        environment,
        "LECODING_RUN_MAX_TOTAL_TOKENS",
        1_000_000,
        100_000_000
      ),
      warningCostUsd,
      maxCostUsd,
      maxWallTimeMs: readPositiveInteger(
        environment,
        "LECODING_RUN_MAX_WALL_TIME_MS",
        30 * 60_000,
        24 * 60 * 60_000
      ),
      maxToolCalls: readPositiveInteger(
        environment,
        "LECODING_RUN_MAX_TOOL_CALLS",
        60,
        10_000
      ),
      maxModelRetries: readPositiveInteger(
        environment,
        "LECODING_RUN_MAX_MODEL_RETRIES",
        3,
        100
      ),
      maxActiveRunsPerUser: readPositiveInteger(
        environment,
        "LECODING_USER_MAX_ACTIVE_RUNS",
        2,
        100
      ),
      maxActiveRunsPerProject: readPositiveInteger(
        environment,
        "LECODING_PROJECT_MAX_ACTIVE_RUNS",
        5,
        1_000
      ),
      teamMonthlyWarningUsd,
      teamMonthlyMaxUsd
    },
    pricing: {
      modelId: requireSetting(environment, "LECODING_MODEL_ID"),
      version: requireSetting(environment, "LECODING_MODEL_PRICING_VERSION"),
      inputUsdPerMillion: readFiniteAmount(
        environment,
        "LECODING_MODEL_INPUT_USD_PER_MILLION"
      ),
      outputUsdPerMillion: readFiniteAmount(
        environment,
        "LECODING_MODEL_OUTPUT_USD_PER_MILLION"
      )
    }
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
export { createPostgresRunApiAccessControl } from "./postgres-access-control.js";
export { createGitHubOAuthLogin, loadGitHubOAuthConfig } from "./github-oauth.js";
export type {
  RunApiAccessControl,
  RunApiHandler,
  RunApiHandlerOptions,
  RunApiMembershipAdministration,
  RunApiOperations,
  RunApiPrincipal,
  RunApiProjectMembership,
  RunApiProjectRole
} from "./api.js";
export type {
  IssueSessionInput,
  IssuedSession,
  PostgresRunApiAccessControl,
  PostgresRunApiAccessControlOptions,
  ProvisionProjectInput,
  ProvisionUserInput,
  SetProjectMembershipInput
} from "./postgres-access-control.js";
export type {
  CompleteGitHubOAuthInput,
  GitHubOAuthConfig,
  GitHubOAuthLogin,
  GitHubOAuthLoginOptions,
  GitHubOAuthStateStore
} from "./github-oauth.js";
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
    const authMode = options.environment.LECODING_AUTH_MODE?.trim();
    if (authMode && authMode !== "database_sessions") {
      // Composition must fail closed even when used without the HTTP host loader.
      throw new Error("LECODING_AUTH_MODE must be database_sessions when set");
    }
    const projects = await loadWorkerProjectRegistry(options.environment);
    const projectById = new Map(
      projects.map((project) => [project.projectId, project] as const)
    );
    const now = options.now ?? (() => new Date().toISOString());
    // One service instance owns both exchange and subsequent API
    // authentication so revocation/expiry semantics cannot diverge.
    const deviceService = createDeviceBindingService({
      store: createPostgresDeviceBindingStore(options.database.executor),
      now: () => new Date(now())
    });
    let access: RunApiAccessControl;
    let memberships: RunApiMembershipAdministration | undefined;
    let login: WorkerControlPlane["login"];
    if (authMode === "database_sessions") {
      const persistentAccess = await createPostgresRunApiAccessControl(
        options.database.executor,
        options.now ? { now: options.now } : {}
      );
      for (const project of projects) {
        // Registry ownership is established before memberships can reference a project.
        await persistentAccess.provisionProject({
          id: project.projectId,
          name: project.projectId,
          repository: project.projectSourcePath,
          defaultBranch: "HEAD"
        });
      }
      const oauthConfig = loadGitHubOAuthConfig(options.environment);
      const bootstrapAdminEmails = new Set(oauthConfig.bootstrapAdminEmails);
      const oauth = createGitHubOAuthLogin({
        ...oauthConfig,
        stateStore: persistentAccess,
        sessions: persistentAccess,
        async onProvisionedUser(identity) {
          if (!bootstrapAdminEmails.has(identity.email.toLowerCase())) {
            return;
          }
          for (const project of projects) {
            // The configured bootstrap identity can claim each project only once.
            await persistentAccess.bootstrapProjectAdmin(
              project.projectId,
              identity.userId
            );
          }
        },
        ...(options.now ? { now: options.now } : {})
      });
      login = {
        ...oauth,
        revokeRequestSession: (request) =>
          persistentAccess.revokeRequestSession(request)
      };
      memberships = {
        list: (projectId) => persistentAccess.listMemberships(projectId),
        set: (input) => persistentAccess.setMembership(input),
        remove: (projectId, userId) =>
          persistentAccess.removeMembership(projectId, userId)
      };
      access = persistentAccess;
    } else {
      access = {
        async authenticate() {
          // Legacy loopback/static-token deployments retain one explicit local admin.
          return { userId: "local-admin" };
        },
        async roleFor(_userId, projectId) {
          return projectById.has(projectId) ? "admin" : undefined;
        }
      };
    }
    access = createDeviceAwareAccessControl({ sessions: access, devices: deviceService });
    const modelConfig = loadOpenAiCompatibleModelConfig(options.environment);
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
    /* Artifact bytes live beside, not inside, mutable Run worktrees so sandbox
     * mounts can never read another Run's retained command output. */
    const artifacts = await createPostgresLocalArtifactStore(
      options.database.executor,
      {
        root: join(dirname(projects[0]!.worktreeRoot), "artifacts"),
        now
      }
    );
    const approvals = await createPostgresApprovalLedger(
      options.database.executor,
      { now }
    );
    const policyReviewAudit = await createPostgresPolicyReviewAudit(
      options.database.executor,
      { now }
    );
    const projectRules = await createPostgresProjectPolicyRules(
      options.database.executor,
      { now }
    );
    const steerMailbox = await createPostgresRunSteerMailbox({
      database: options.database.executor,
      now
    });
    const lease = await createPostgresRunLease(options.database.executor);
    const budgets = await createPostgresRunBudgetManager(
      options.database.executor,
      {
        limits: config.budgetLimits,
        pricing: config.pricing,
        now
      }
    );
    const eventRepository = createPostgresRunEventRepository(
      options.database.executor
    );
    const metrics = createPostgresRunOperationalMetricsReader(
      options.database.executor,
      { now }
    );
    const actions = await createPostgresRunOperationalActionRecorder(
      options.database.executor,
      { now }
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
      artifacts,
      redactOutput: createDeploymentSecretRedactor(options.environment),
      approvals,
      projectRules,
      steerMailbox,
      lease,
      heartbeat: createIntervalLeaseHeartbeat(lease),
      handles: createInMemoryRunHandleRegistry(),
      cancelBus,
      environment: runtimeEnvironment,
      model: createOpenAiCompatibleAgentModel({
        config: modelConfig,
        maxInputTokens: config.modelRequestLimits.maxInputTokens,
        maxOutputTokens: config.modelRequestLimits.maxOutputTokens,
        // Worst-case exposure is reserved atomically before provider I/O begins.
        onRequestStart: async (request) => {
          const decision = await budgets.reserveModelRequest(request);
          if (!decision.allowed) {
            throw new RunBudgetExceededError(decision.reason);
          }
        },
        // Provider usage is durably settled before RunEngine may consume the turn.
        onUsage: async (usage) => {
          if (!usage.requestId) {
            throw new Error("Reserved model usage is missing its request identity");
          }
          const decision = await budgets.settleModelRequest({
            runId: usage.runId,
            requestId: usage.requestId,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: usage.cachedInputTokens
          });
          if (!decision.allowed) {
            throw new RunBudgetExceededError(decision.reason);
          }
        },
        // Unknowable billing is conservatively charged at the reserved maximum.
        onRequestFailure: async (request) => {
          const decision = await budgets.forfeitModelRequest(request);
          if (!decision.allowed) {
            throw new RunBudgetExceededError(decision.reason);
          }
        },
        // Retry admission is persisted before another provider request can begin,
        // so another Worker or a resumed turn observes the same Run-wide count.
        onBeforeModelRetry: async ({ runId }) => {
          const decision = await budgets.recordModelRetry(runId);
          if (!decision.allowed) {
            throw new RunBudgetExceededError(decision.reason);
          }
        },
        ...(options.onModelRetry
          ? { onMalformedJsonRetry: options.onModelRetry }
          : {})
      }),
      policy: createPolicyEngine({
        audit: policyReviewAudit,
        projectRules
      }),
      events,
      budgets,
      verifier,
      workerId: config.workerId,
      now,
      createId: options.createId ?? randomUUID
    });
    const recoveryQueue = options.createRecoveryQueue
      ? options.createRecoveryQueue(options.database.executor)
      : createProductionPgBossRecoveryQueue({
          executor: options.database.executor,
          ...(options.onBackgroundError ? { onError: options.onBackgroundError } : {})
        });
    const recovery = createPgBossRecoveryWorker({
      queue: recoveryQueue,
      executor: options.database.executor,
      resumer: engine,
      scanIntervalSeconds: Math.max(
        1,
        Math.ceil(config.recoveryIntervalMs / 1_000)
      ),
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
    const artifactRetention = createIntervalArtifactRetentionWorker({
      store: artifacts,
      now,
      ...(options.onArtifactRetentionReport
        ? { onReport: options.onArtifactRetentionReport }
        : {}),
      ...(options.onBackgroundError ? { onError: options.onBackgroundError } : {})
    });
    return createWorkerRuntime({
      engine,
      recovery,
      eventDispatch,
      artifactRetention,
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
        results: {
          async resolve(runId, outcome) {
            // Resolve the server-owned project from durable Run state; callers never choose paths.
            const run = await engine.inspect(runId);
            const project = projectById.get(run.projectId);
            if (!project) {
              throw new Error("Run project is not registered by this Worker");
            }
            return createGitRunResultManager({
              sourceRepo: project.projectSourcePath,
              worktreeRoot: project.worktreeRoot
            }).resolve(runId, outcome);
          }
        },
        artifacts,
        access,
        ...(memberships ? { memberships } : {}),
        projectPolicy: {
          list: (projectId) => projectRules.list(projectId),
          revoke: (projectId, ruleId, revokedBy) =>
            projectRules.revoke(projectId, ruleId, revokedBy)
        },
        metrics,
        actions,
        ...(login ? { login } : {}),
        eventStream: createRunEventSseHandler({
          journal: events,
          broadcaster: eventBroadcaster
        }),
        // Device binding lets the desktop client exchange a one-time code for
        // a scoped device credential. The service injects the same clock the
        // rest of the Worker uses so code and device expiry stay verifiable.
        devices: createDeviceBindingHttpHandler({
          service: deviceService,
          principal: {
            async authenticate(request) {
              const principal = await access.authenticate(request);
              return principal
                ? { userId: principal.userId, email: principal.email ?? "" }
                : undefined;
            }
          },
          projectIds: projects.map((project) => project.projectId),
          projectName: (projectId) => projectById.get(projectId)?.projectId
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
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  return {
    control: resources.control,
    start() {
      if (stopPromise) {
        return Promise.reject(new Error("Worker runtime has stopped"));
      }
      if (startPromise) {
        return startPromise;
      }
      startPromise = (async () => {
        resources.eventDispatch.start();
        await resources.artifactRetention?.start();
        // Durable queue startup must finish before the HTTP control plane opens.
        await resources.recovery.start();
      })();
      return startPromise;
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
        // Collapse a stop-during-start race before tearing down shared connections.
        await startPromise?.catch(() => undefined);
        for (const cleanup of [
          () => resources.recovery.stop(),
          () => resources.artifactRetention?.stop(),
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
  fallback: number,
  maximum?: number
): number {
  const raw = environment[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    (maximum !== undefined && value > maximum)
  ) {
    if (maximum !== undefined) {
      throw new Error(`${name} must be an integer from 1 to ${maximum}`);
    }
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function readFiniteAmount(
  environment: ModelEnvironment,
  name: string,
  fallback?: number,
  positive = false
): number {
  const raw = environment[name]?.trim();
  if (!raw) {
    if (fallback === undefined) {
      throw new Error(`Missing required Worker setting: ${name}`);
    }
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
    throw new Error(
      `${name} must be a ${positive ? "positive" : "non-negative"} finite amount`
    );
  }
  return value;
}

function assertWarningAtOrBelowMax(
  warningName: string,
  warning: number,
  maxName: string,
  max: number
): void {
  if (warning > max) {
    throw new Error(`${warningName} must not exceed ${maxName}`);
  }
}
