import { describe, expect, it, vi } from "vitest";
import { createIntervalArtifactRetentionWorker } from "../src/artifact-retention.js";

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
});
