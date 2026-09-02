import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  DEVICE_BINDING_SCHEMA_SQL,
  createPostgresDeviceBindingStore
} from "../src/postgres.js";

const liveDatabaseUrl = process.env["LECODING_DATABASE_URL"];
const runLiveConcurrency =
  process.env["RUN_LIVE_POSTGRES_CONCURRENCY"] === "1" &&
  typeof liveDatabaseUrl === "string";

/**
 * A real multi-session PostgreSQL test is required here because an embedded
 * single-session adapter cannot reproduce READ COMMITTED snapshot races.
 */
describe.skipIf(!runLiveConcurrency)("PostgreSQL device-code concurrency", () => {
  it("never lets concurrent sessions exceed one live code for a user", async () => {
    const pool = new Pool({
      connectionString: liveDatabaseUrl,
      max: 12,
      // Fail with a useful infrastructure error instead of consuming the
      // suite-wide test timeout when the configured live database is unhealthy.
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000
    });
    const token = randomUUID().replaceAll("-", "");
    const userId = `m0_concurrency_${token}`;
    const triggerFunction = `m0_delay_${token}`;
    const triggerName = `m0_delay_trigger_${token}`;
    let schemaReady = false;
    let triggerReady = false;

    try {
      await pool.query(DEVICE_BINDING_SCHEMA_SQL);
      schemaReady = true;
      // Delay matching inserts after their statement snapshot is established.
      // The old count-then-insert statement lets every concurrent caller pass;
      // a correct per-user lock admits exactly one before the delayed insert.
      await pool.query(`
        CREATE FUNCTION ${triggerFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.user_id = '${userId}' THEN
            PERFORM pg_sleep(0.15);
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER ${triggerName}
          BEFORE INSERT ON device_binding_codes
          FOR EACH ROW EXECUTE FUNCTION ${triggerFunction}();
      `);
      triggerReady = true;
      const store = createPostgresDeviceBindingStore(pool);
      const now = new Date("2026-09-02T00:00:00.000Z");
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          store.reserveCodeSlot(
            {
              codeHash: `${token}_${index}`,
              userId,
              email: "concurrency@example.com",
              projectId: "project-1",
              projectName: "Project One"
            },
            { maxLiveCodesPerUser: 1, now, ttlMs: 60_000 }
          )
        )
      );

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(
        results.filter(
          (result) => !result.ok && result.reason === "too_many_codes"
        )
      ).toHaveLength(7);
    } finally {
      if (triggerReady) {
        await pool.query(
          `DROP TRIGGER IF EXISTS ${triggerName} ON device_binding_codes`
        );
        await pool.query(`DROP FUNCTION IF EXISTS ${triggerFunction}()`);
      }
      if (schemaReady) {
        await pool.query("DELETE FROM device_binding_codes WHERE user_id = $1", [
          userId
        ]);
      }
      await pool.end();
    }
  });
});
