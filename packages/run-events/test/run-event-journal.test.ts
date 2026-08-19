import { describe, expect, it } from "vitest";
import { createInMemoryRunEventJournal } from "../src/index.js";

describe("RunEventJournal", () => {
  it("resumes an SSE stream strictly after the client's last event ID", async () => {
    const journal = createInMemoryRunEventJournal({
      now: () => "2026-08-19T00:00:00.000Z"
    });

    await journal.publish({
      runId: "run-1",
      type: "status_changed",
      data: { status: "running" }
    });
    await journal.publish({
      runId: "run-1",
      type: "verification_completed",
      data: { outcome: "passed" }
    });

    // Last-Event-ID 1 means event 1 was delivered before the connection dropped.
    await expect(journal.resume("run-1", "1")).resolves.toBe(
      'id: 2\nevent: verification_completed\ndata: {"version":1,"sequence":2,"runId":"run-1","type":"verification_completed","occurredAt":"2026-08-19T00:00:00.000Z","data":{"outcome":"passed"}}\n\n'
    );
  });
});
