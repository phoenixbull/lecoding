import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import type { PostgresExecutor } from "@lecoding/run-engine";
import type { WorkerDatabase } from "../src/index.js";
import { runPostgresFailoverSmoke } from "../src/postgres-failover-smoke.js";

describe("PostgreSQL failover smoke", () => {
  it("lets exactly one of two recovery Workers claim an expired Run", async () => {
    const postgres = new PGlite();
    const executor: PostgresExecutor = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        parameters?: unknown[]
      ) {
        // pg-boss migrations contain transaction batches that require simple mode.
        if (!parameters?.length && sql.trimStart().startsWith("BEGIN;")) {
          const results = await postgres.exec(sql);
          return { rows: (results.at(-1)?.rows ?? []) as Row[] };
        }
        const result = parameters?.length
          ? await postgres.query<Row>(sql, parameters)
          : await postgres.query<Row>(sql);
        return { rows: result.rows };
      }
    };
    const createDatabase = async (): Promise<WorkerDatabase> => ({
      executor,
      notifications: {} as WorkerDatabase["notifications"],
      close: async () => undefined
    });

    try {
      await expect(
        runPostgresFailoverSmoke({ environment: {}, createDatabase })
      ).resolves.toEqual({
        status: "passed",
        checks: {
          recoveryWorkers: 2,
          expiredRunClaims: 1,
          distinctClaimers: 1,
          isolatedFixtureCleanup: "complete"
        }
      });
    } finally {
      await postgres.close();
    }
  }, 15_000);
});
