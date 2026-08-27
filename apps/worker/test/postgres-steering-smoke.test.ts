import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import type { PostgresExecutor } from "@lecoding/run-engine";
import type { WorkerDatabase } from "../src/index.js";
import { runPostgresSteeringSmoke } from "../src/postgres-steering-smoke.js";

describe("PostgreSQL cross-Worker steering smoke", () => {
  it("preserves order and command idempotency for a replacement Worker", async () => {
    const postgres = new PGlite();
    const executor: PostgresExecutor = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        parameters?: unknown[]
      ) {
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
        runPostgresSteeringSmoke({ environment: {}, createDatabase })
      ).resolves.toEqual({
        status: "passed",
        checks: {
          workerAdapters: 2,
          insertedMessages: 2,
          idempotentRetries: 1,
          replacementReadMessages: 2,
          cursorRemainingMessages: 1,
          durableSubmittedEvents: 2,
          isolatedFixtureCleanup: "complete"
        }
      });
    } finally {
      await postgres.close();
    }
  });
});
