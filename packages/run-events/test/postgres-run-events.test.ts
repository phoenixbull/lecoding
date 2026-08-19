import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  RUN_EVENT_SCHEMA_SQL,
  createPostgresRunEventOutbox,
  createPostgresRunEventRepository,
  createRunEventJournal
} from "../src/index.js";

describe("PostgreSQL Run events", () => {
  it("persists ordered events and leases their transactional outbox records", async () => {
    const database = new PGlite();
    await database.exec(RUN_EVENT_SCHEMA_SQL);
    const repository = createPostgresRunEventRepository(database);
    const outbox = createPostgresRunEventOutbox(database);
    const journal = createRunEventJournal({
      repository,
      now: () => "2026-08-19T00:00:00.000Z"
    });

    await journal.publish({
      runId: "run-1",
      type: "status_changed",
      data: { status: "running" }
    });
    await journal.publish({
      runId: "run-1",
      type: "status_changed",
      data: { status: "verifying" }
    });

    const stream = await journal.resume("run-1");
    const firstClaim = await outbox.claim({
      workerId: "worker-a",
      limit: 10,
      now: "2026-08-19T00:00:00.000Z",
      leaseUntil: "2026-08-19T00:01:00.000Z"
    });
    // A second worker cannot claim rows while the first worker's lease is active.
    const secondClaim = await outbox.claim({
      workerId: "worker-b",
      limit: 10,
      now: "2026-08-19T00:00:30.000Z",
      leaseUntil: "2026-08-19T00:01:00.000Z"
    });
    await outbox.ack({
      workerId: "worker-a",
      claimIds: firstClaim.map((claim) => claim.id),
      deliveredAt: "2026-08-19T00:00:45.000Z"
    });
    // Acknowledged rows stay delivered even after their former lease expires.
    const afterAck = await outbox.claim({
      workerId: "worker-b",
      limit: 10,
      now: "2026-08-19T00:02:00.000Z",
      leaseUntil: "2026-08-19T00:03:00.000Z"
    });

    expect({
      eventIds: stream
        .split("\n")
        .filter((line) => line.startsWith("id: ")),
      claimedSequences: firstClaim.map((claim) => claim.event.sequence),
      secondClaim,
      afterAck
    }).toEqual({
      eventIds: ["id: 1", "id: 2"],
      claimedSequences: [1, 2],
      secondClaim: [],
      afterAck: []
    });

    await database.close();
  });
});
