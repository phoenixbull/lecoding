import type {
  ArtifactPruneResult,
  PostgresLocalArtifactStore
} from "./postgres-local-artifact-store.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

/** Stable cleanup projection that excludes retained Artifact content. */
export interface ArtifactRetentionReport {
  event: "artifact_retention_completed";
  deletedCount: number;
  failureCount: number;
  residualPaths: string[];
}

/** Lifecycle owned by the production Worker beside recovery and event dispatch. */
export interface ArtifactRetentionWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Creates a startup-plus-daily seven-day Artifact cleanup loop. */
export function createIntervalArtifactRetentionWorker(options: {
  store: Pick<PostgresLocalArtifactStore, "pruneExpired">;
  now?: () => string;
  intervalMs?: number;
  onReport?: (report: ArtifactRetentionReport) => void;
  onError?: (error: unknown) => void;
}): ArtifactRetentionWorker {
  const now = options.now ?? (() => new Date().toISOString());
  const intervalMs = options.intervalMs ?? ONE_DAY_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) {
    throw new Error("Artifact retention interval must be at least one minute");
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let stopped = false;

  const runOnce = (): Promise<void> => {
    if (active) {
      return active;
    }
    active = (async () => {
      const timestamp = Date.parse(now());
      if (!Number.isFinite(timestamp)) {
        throw new Error("Artifact retention clock must return an ISO timestamp");
      }
      const result = await options.store.pruneExpired({
        before: new Date(timestamp - SEVEN_DAYS_MS).toISOString()
      });
      options.onReport?.(toReport(result));
    })()
      .catch((error) => {
        options.onError?.(error);
      })
      .finally(() => {
        active = undefined;
      });
    return active;
  };

  return {
    async start() {
      if (stopped) {
        throw new Error("Artifact retention worker has stopped");
      }
      if (timer) {
        await active;
        return;
      }
      await runOnce();
      timer = setInterval(() => {
        void runOnce();
      }, intervalMs);
      // Retention must not keep an otherwise stopped CLI process alive.
      timer.unref?.();
    },

    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      await active;
    }
  };
}

function toReport(result: ArtifactPruneResult): ArtifactRetentionReport {
  return {
    event: "artifact_retention_completed",
    deletedCount: result.deletedIds.length,
    failureCount: result.failures.length,
    residualPaths: result.failures.map(({ storageKey }) => storageKey)
  };
}
