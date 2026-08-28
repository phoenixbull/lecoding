import type { ModelEnvironment } from "@lecoding/openai-model";
import {
  composeProductionWorker,
  type ProductionWorkerOptions,
  type WorkerControlPlane,
  type WorkerDatabase,
  type WorkerRuntime
} from "./index.js";
import { createPostgresWorkerDatabase } from "./postgres-database.js";

/** Process signal surface injected so lifecycle behavior remains deterministic in tests. */
export interface WorkerProcessSignals {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
  emit(signal: NodeJS.Signals): boolean;
  listenerCount(signal: NodeJS.Signals): number;
}

/** Executable-host dependencies and failure reporting policy. */
export interface WorkerProcessHostOptions {
  environment: ModelEnvironment;
  signals?: WorkerProcessSignals;
  createDatabase?: (environment: ModelEnvironment) => Promise<WorkerDatabase>;
  composeWorker?: (options: ProductionWorkerOptions) => Promise<WorkerRuntime>;
  /** Starts HTTP/static serving only after the Worker control seams are ready. */
  startControlPlane?: (
    control: WorkerControlPlane
  ) => Promise<WorkerHostedControlPlane>;
  /** Called for shutdown failures triggered outside an awaitable caller path. */
  onFatalError?: (error: unknown) => void;
  /** Forwarded to model composition for secret-free malformed-JSON retry logs. */
  onModelRetry?: ProductionWorkerOptions["onModelRetry"];
  /** Forwarded to the seven-day Artifact cleanup audit logger. */
  onArtifactRetentionReport?: ProductionWorkerOptions["onArtifactRetentionReport"];
}

/** HTTP listener or equivalent service owned ahead of Worker teardown. */
export interface WorkerHostedControlPlane {
  stop(): Promise<void>;
}

/** Awaitable lifecycle exposed by the executable main module and deployment tests. */
export interface WorkerProcessHost {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Owns one trusted project registration and one Worker runtime per process.
 * SIGINT/SIGTERM remove their own handlers before stopping, so duplicate signals
 * cannot create parallel teardown paths.
 */
export function createWorkerProcessHost(
  options: WorkerProcessHostOptions
): WorkerProcessHost {
  const signals = options.signals ?? (process as WorkerProcessSignals);
  const createDatabase =
    options.createDatabase ??
    ((environment: ModelEnvironment) =>
      createPostgresWorkerDatabase({
        environment,
        ...(options.onFatalError
          ? { onUnexpectedError: options.onFatalError }
          : {})
      }));
  const composeWorker = options.composeWorker ?? composeProductionWorker;
  let runtime: WorkerRuntime | undefined;
  let controlPlane: WorkerHostedControlPlane | undefined;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let listening = false;

  const removeSignalHandlers = (): void => {
    if (!listening) {
      return;
    }
    listening = false;
    signals.off("SIGINT", handleSignal);
    signals.off("SIGTERM", handleSignal);
  };

  const stop = (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }
    // Remove synchronously before awaiting to collapse back-to-back signals.
    removeSignalHandlers();
    stopPromise = (async () => {
      await startPromise;
      await controlPlane?.stop();
      await runtime?.stop();
    })();
    return stopPromise;
  };

  function handleSignal(): void {
    void stop().catch((error: unknown) => {
      options.onFatalError?.(error);
    });
  }

  return {
    start() {
      if (stopPromise) {
        return Promise.reject(new Error("Worker process host has stopped"));
      }
      if (startPromise) {
        return startPromise;
      }
      startPromise = (async () => {
        const database = await createDatabase(options.environment);
        runtime = await composeWorker({
          database,
          environment: options.environment,
          ...(options.onFatalError
            ? { onBackgroundError: options.onFatalError }
            : {}),
          ...(options.onModelRetry ? { onModelRetry: options.onModelRetry } : {}),
          ...(options.onArtifactRetentionReport
            ? { onArtifactRetentionReport: options.onArtifactRetentionReport }
            : {})
        });
        try {
          await runtime.start();
          controlPlane = await options.startControlPlane?.(runtime.control);
        } catch (error) {
          await runtime.stop().catch(() => undefined);
          throw error;
        }
        signals.on("SIGINT", handleSignal);
        signals.on("SIGTERM", handleSignal);
        listening = true;
      })();
      return startPromise;
    },
    stop
  };
}
