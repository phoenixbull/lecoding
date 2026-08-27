import { describe, expect, it, vi } from "vitest";
import type { RunResumer } from "@lecoding/contracts";
import type { PostgresExecutor } from "../src/postgres-run-lease.js";
import { createPgBossRecoveryWorker } from "../src/recovery-worker.js";

describe("pg-boss recovery worker", () => {
  it("durably scans expired leases and routes each Run through retryable recovery", async () => {
    const handlers = new Map<string, (job: { data: unknown }) => Promise<void>>();
    const queue = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      createQueue: vi.fn(async () => undefined),
      send: vi.fn(async () => "job-1"),
      work: vi.fn(
        async (
          name: string,
          _options: unknown,
          handler: (job: { data: unknown }) => Promise<void>
        ) => {
          handlers.set(name, handler);
          return `worker:${name}`;
        }
      )
    };
    const executor: PostgresExecutor = {
      async query<Row extends Record<string, unknown>>() {
        return {
          rows: [
            { run_id: "run-expired-a" },
            { run_id: "run-expired-b" }
          ] as unknown as Row[]
        };
      }
    };
    const resumer: RunResumer = {
      resume: vi.fn(async () => undefined),
      recoverEnvironment: vi.fn(async () => undefined)
    };
    const worker = createPgBossRecoveryWorker({
      queue,
      executor,
      resumer,
      scanIntervalSeconds: 7
    });

    await worker.start();
    const scan = handlers.get("lecoding-run-recovery-scan");
    const recover = handlers.get("lecoding-run-recovery");
    expect(scan).toBeDefined();
    expect(recover).toBeDefined();
    expect(queue.work).toHaveBeenCalledWith(
      "lecoding-run-recovery",
      { batchSize: 1 },
      expect.any(Function)
    );

    await scan!({ data: {} });
    expect(queue.send).toHaveBeenCalledWith(
      "lecoding-run-recovery",
      { runId: "run-expired-a" },
      expect.objectContaining({ singletonKey: "run-expired-a" })
    );
    expect(queue.send).toHaveBeenCalledWith(
      "lecoding-run-recovery-scan",
      {},
      expect.objectContaining({ startAfter: 7 })
    );

    await recover!({ data: { runId: "run-expired-a" } });
    expect(resumer.resume).toHaveBeenCalledWith("run-expired-a");
  });
});
