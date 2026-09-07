import { describe, expect, it, vi } from "vitest";
import { createIntervalArtifactRetentionWorker } from "../src/artifact-retention.js";
import type { ArtifactPruneResult } from "../src/postgres-local-artifact-store.js";

describe("Artifact retention worker", () => {
  it("runs the seven-day cleanup at startup and reports residual paths", async () => {
    const pruneExpired = vi.fn(async () => ({
      deletedIds: ["artifact-old"],
      failures: [{ id: "artifact-stuck", storageKey: "project/run/stuck.txt" }]
    }));
    const onReport = vi.fn();
    const worker = createIntervalArtifactRetentionWorker({
      store: { pruneExpired },
      now: () => "2026-08-28T00:00:00.000Z",
      onReport
    });

    await worker.start();
    await worker.stop();

    expect(pruneExpired).toHaveBeenCalledWith({
      before: "2026-08-21T00:00:00.000Z"
    });
    expect(onReport).toHaveBeenCalledWith({
      event: "artifact_retention_completed",
      deletedCount: 1,
      failureCount: 1,
      residualPaths: ["project/run/stuck.txt"]
    });
  });

  /** A store that records each call and resolves with the given result. */
  function fakeStore(result: ArtifactPruneResult) {
    const pruneExpired = vi.fn(async () => result);
    return { pruneExpired };
  }

  const EMPTY = { deletedIds: [], failures: [] };

  it("computes the seven-day boundary from the injected clock", async () => {
    const store = fakeStore(EMPTY);
    const worker = createIntervalArtifactRetentionWorker({
      store,
      now: () => "2026-09-07T12:00:00.000Z"
    });

    await worker.start();
    await worker.stop();

    expect(store.pruneExpired).toHaveBeenCalledWith({
      before: "2026-08-31T12:00:00.000Z"
    });
  });

  it("reports a clean run as zero failures and no residual paths", async () => {
    const onReport = vi.fn();
    const worker = createIntervalArtifactRetentionWorker({
      store: fakeStore({ deletedIds: ["a", "b"], failures: [] }),
      now: () => "2026-09-07T00:00:00.000Z",
      onReport
    });

    await worker.start();
    await worker.stop();

    // A clean run must still be observable: silence is indistinguishable from
    // the worker never having run.
    expect(onReport).toHaveBeenCalledWith({
      event: "artifact_retention_completed",
      deletedCount: 2,
      failureCount: 0,
      residualPaths: []
    });
  });

  it("surfaces every failed deletion as a residual path for alerting", async () => {
    const onReport = vi.fn();
    const worker = createIntervalArtifactRetentionWorker({
      store: fakeStore({
        deletedIds: ["a"],
        failures: [
          { id: "x", storageKey: "p/run/x.txt" },
          { id: "y", storageKey: "p/run/y.txt" }
        ]
      }),
      now: () => "2026-09-07T00:00:00.000Z",
      onReport
    });

    await worker.start();
    await worker.stop();

    // Retention that fails must be loud: a silently retained Artifact is both
    // a storage cost and a possible data-retention breach.
    expect(onReport.mock.calls[0]?.[0]).toMatchObject({
      failureCount: 2,
      residualPaths: ["p/run/x.txt", "p/run/y.txt"]
    });
  });

  it("routes a pruning failure to onError instead of the caller", async () => {
    const onError = vi.fn();
    const worker = createIntervalArtifactRetentionWorker({
      store: {
        pruneExpired: vi.fn(async () => {
          throw new Error("database unavailable");
        })
      },
      now: () => "2026-09-07T00:00:00.000Z",
      onError
    });

    await expect(worker.start()).resolves.toBeUndefined();
    await worker.stop();

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("routes an unusable clock to onError rather than pruning with NaN", async () => {
    const store = fakeStore(EMPTY);
    const onError = vi.fn();
    const worker = createIntervalArtifactRetentionWorker({
      store,
      now: () => "not-a-timestamp",
      onError
    });

    await worker.start();
    await worker.stop();

    // Pruning with a NaN boundary would delete the wrong rows, so the run is
    // refused instead.
    expect(store.pruneExpired).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not overlap two runs started together", async () => {
    const store = fakeStore(EMPTY);
    const worker = createIntervalArtifactRetentionWorker({
      store,
      now: () => "2026-09-07T00:00:00.000Z"
    });

    await Promise.all([worker.start(), worker.start()]);
    await worker.stop();

    expect(store.pruneExpired).toHaveBeenCalledTimes(1);
  });

  it("rejects a restart after stop", async () => {
    const worker = createIntervalArtifactRetentionWorker({
      store: fakeStore(EMPTY),
      now: () => "2026-09-07T00:00:00.000Z"
    });

    await worker.start();
    await worker.stop();

    await expect(worker.start()).rejects.toThrow(/has stopped/);
  });

  it("tolerates a repeated stop", async () => {
    const worker = createIntervalArtifactRetentionWorker({
      store: fakeStore(EMPTY),
      now: () => "2026-09-07T00:00:00.000Z"
    });

    await worker.start();
    await worker.stop();
    // Shutdown paths stop the worker alongside other consumers; a second stop
    // must not throw or leave the shutdown half-finished.
    await expect(worker.stop()).resolves.toBeUndefined();
  });

  it("refuses an interval below one minute", () => {
    expect(() =>
      createIntervalArtifactRetentionWorker({
        store: fakeStore(EMPTY),
        intervalMs: 1_000
      })
    ).toThrow(/at least one minute/);
  });
});
