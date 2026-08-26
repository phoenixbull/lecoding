import { PGlite } from "@electric-sql/pglite";
import type { RunEventV1 } from "@lecoding/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  RUN_EVENT_SCHEMA_SQL,
  createIntervalRunEventDispatchWorker,
  createPostgresRunEventOutbox,
  createPostgresRunEventRepository,
  createRunEventDispatcher,
  createRunEventJournal
} from "../src/index.js";

describe("RunEventDispatcher", () => {
  it("delivers leased outbox events once after successful acknowledgement", async () => {
    const database = new PGlite();
    await database.exec(RUN_EVENT_SCHEMA_SQL);
    const outbox = createPostgresRunEventOutbox(database);
    const journal = createRunEventJournal({
      repository: createPostgresRunEventRepository(database),
      now: () => "2026-08-19T00:00:00.000Z"
    });
    const delivered: RunEventV1[] = [];
    const dispatcher = createRunEventDispatcher({
      outbox,
      target: {
        async deliver(event) {
          delivered.push(event);
        }
      },
      workerId: "dispatcher-1",
      batchSize: 10,
      leaseMilliseconds: 30_000,
      now: () => "2026-08-19T00:00:01.000Z"
    });
    await journal.publish({
      runId: "run-1",
      type: "status_changed",
      data: { status: "running" }
    });

    const first = await dispatcher.dispatchOnce();
    // A second pass proves the first delivery was acknowledged, not merely leased.
    const second = await dispatcher.dispatchOnce();

    expect({ first, second, delivered: delivered.map((event) => event.sequence) }).toEqual({
      first: { delivered: 1 },
      second: { delivered: 0 },
      delivered: [1]
    });
    await database.close();
  });
});

describe("interval RunEvent dispatcher", () => {
  it("dispatches immediately and stops without leaving a timer behind", async () => {
    let dispatches = 0;
    const worker = createIntervalRunEventDispatchWorker({
      dispatcher: {
        async dispatchOnce() {
          dispatches += 1;
          return { delivered: 0 };
        }
      },
      intervalMs: 10
    });

    worker.start();
    await vi.waitFor(() => expect(dispatches).toBeGreaterThan(0));
    await worker.stop();
    const stoppedAt = dispatches;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(dispatches).toBe(stoppedAt);
  });
});
