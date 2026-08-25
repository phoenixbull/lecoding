import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createPostgresToolCallLedger } from "../src/postgres-tool-call-ledger.js";

describe("PostgreSQL ToolCallLedger", () => {
  it("turns an unfinished duplicate call into an unknown outcome instead of reclaiming it", async () => {
    const database = new PGlite();
    const ledger = await createPostgresToolCallLedger(database);
    const call = {
      runId: "run-1",
      callId: "call-1",
      action: { type: "execute" as const, command: ["pnpm", "test"] }
    };

    await expect(ledger.claim(call)).resolves.toEqual({ status: "claimed" });

    // A replacement Worker cannot know whether the first process produced a side effect.
    await expect(ledger.claim(call)).resolves.toEqual({
      status: "outcome_unknown"
    });

    await database.close();
  });

  it("replays a durable completed result without granting execution again", async () => {
    const database = new PGlite();
    const ledger = await createPostgresToolCallLedger(database);
    const call = {
      runId: "run-1",
      callId: "call-1",
      action: { type: "execute" as const, command: ["pnpm", "test"] }
    };
    const result = { exitCode: 0, stdout: "passed", stderr: "" };

    await ledger.claim(call);
    await ledger.complete({ runId: call.runId, callId: call.callId, result });

    await expect(ledger.claim(call)).resolves.toEqual({
      status: "completed",
      result
    });

    await database.close();
  });
});
