import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import {
  createPgBossRecoveryWorker,
  createPostgresRunLease,
  createPostgresRunStore,
  type PostgresExecutor
} from "@lecoding/run-engine";
import { createProductionPgBossRecoveryQueue } from "../src/pg-boss-recovery.js";

describe("production pg-boss recovery queue", () => {
  it("claims an expired non-terminal Run through the real durable queue", async () => {
    const database = new PGlite();
    const executor: PostgresExecutor = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        parameters?: unknown[]
      ) {
        // PGlite requires simple-query mode for pg-boss multi-statement migrations.
        try {
          if (!parameters?.length && sql.trimStart().startsWith("BEGIN;")) {
            const results = await database.exec(sql);
            return { rows: (results.at(-1)?.rows ?? []) as Row[] };
          }
          const result = parameters?.length
            ? await database.query<Row>(sql, parameters)
            : await database.query<Row>(sql);
          return { rows: result.rows };
        } catch (error) {
          throw new Error(`PGlite query failed: ${sql.slice(0, 180)}`, {
            cause: error
          });
        }
      }
    };
    const errors: unknown[] = [];
    const queue = createProductionPgBossRecoveryQueue({
      executor,
      onError: (error) => errors.push(error)
    });
    const resumer = {
      resume: vi.fn(async () => undefined),
      recoverEnvironment: vi.fn(async () => undefined)
    };
    const worker = createPgBossRecoveryWorker({
      queue,
      executor,
      resumer,
      scanIntervalSeconds: 1
    });

    try {
      await createPostgresRunStore(executor);
      await createPostgresRunLease(executor);
      await executor.query(
        `
        INSERT INTO run_engine_runs (run_id, version, snapshot)
        VALUES ('run-expired', 1, '{"status":"running"}'::jsonb);
        `
      );
      await executor.query(
        `
        INSERT INTO run_engine_runs (run_id, version, snapshot)
        VALUES ('run-terminal', 1, '{"status":"succeeded"}'::jsonb);
        `
      );
      await executor.query(
        `
        INSERT INTO run_engine_leases (run_id, owner_id, lease_until, generation)
        VALUES ('run-expired', 'dead-worker', NOW() - INTERVAL '1 minute', 1);
        `
      );
      await executor.query(
        `
        INSERT INTO run_engine_leases (run_id, owner_id, lease_until, generation)
        VALUES ('run-terminal', 'old-worker', NOW() - INTERVAL '1 minute', 1);
        `
      );

      await worker.start();
      await vi.waitFor(
        () => expect(resumer.resume).toHaveBeenCalledWith("run-expired"),
        { timeout: 10_000, interval: 100 }
      );
      expect(resumer.resume).not.toHaveBeenCalledWith("run-terminal");
      expect(errors).toEqual([]);
    } finally {
      await worker.stop();
      await database.close();
    }
  }, 15_000);
});
