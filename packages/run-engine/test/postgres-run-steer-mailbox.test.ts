import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createPostgresRunSteerMailbox } from "../src/index.js";
import {
  createPostgresRunEventRepository,
  createPostgresRunEventOutbox,
  createRunEventJournal
} from "@lecoding/run-events";

describe("PostgreSQL Run steer mailbox", () => {
  it("preserves ordered instructions across adapter instances", async () => {
    const database = new PGlite();
    const now = () => "2026-08-26T00:00:00.000Z";
    const firstWorker = await createPostgresRunSteerMailbox({ database, now });
    const first = await firstWorker.enqueue({
      runId: "run-1",
      commandId: "command-1",
      message: "Keep v1"
    });
    await firstWorker.enqueue({
      runId: "run-2",
      commandId: "command-other",
      message: "Unrelated Run"
    });
    await firstWorker.enqueue({
      runId: "run-1",
      commandId: "command-2",
      message: "Preserve error codes"
    });

    // Retrying the same command is accepted without another mailbox row or event.
    await expect(
      firstWorker.enqueue({
        runId: "run-1",
        commandId: "command-1",
        message: "Keep v1"
      })
    ).resolves.toEqual({ sequence: first.sequence, inserted: false });
    await expect(
      firstWorker.enqueue({
        runId: "run-1",
        commandId: "command-1",
        message: "Changed payload"
      })
    ).rejects.toThrow(/different message/i);

    // A replacement Worker continues strictly after the snapshot's durable cursor.
    const replacementWorker = await createPostgresRunSteerMailbox({ database, now });
    await expect(
      replacementWorker.readAfter("run-1", first.sequence, 20)
    ).resolves.toEqual([
      expect.objectContaining({ message: "Preserve error codes" })
    ]);
    const journal = createRunEventJournal({
      repository: createPostgresRunEventRepository(database),
      now
    });
    const submittedEvents = (await journal.resume("run-1"))
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)))
      .filter((event) => event.type === "user_message_submitted");
    expect(submittedEvents).toHaveLength(2);
    const claims = await createPostgresRunEventOutbox(database).claim({
      workerId: "event-worker",
      limit: 10,
      now: now(),
      leaseUntil: "2026-08-26T00:01:00.000Z"
    });
    expect(claims).toHaveLength(3);

    await database.close();
  });
});
