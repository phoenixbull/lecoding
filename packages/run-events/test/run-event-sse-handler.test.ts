import { describe, expect, it } from "vitest";
import {
  createInMemoryRunEventJournal,
  createRunEventLiveBroadcaster,
  createRunEventSseHandler
} from "../src/index.js";

describe("RunEventSseHandler", () => {
  it("streams backlog then live events without repeating a delivered sequence", async () => {
    const journal = createInMemoryRunEventJournal({
      now: () => "2026-08-19T00:00:00.000Z"
    });
    const broadcaster = createRunEventLiveBroadcaster();
    const handler = createRunEventSseHandler({ journal, broadcaster });
    await journal.publish({
      runId: "run-1",
      type: "status_changed",
      data: { status: "running" }
    });

    const response = await handler.handle(
      new Request("https://agent.example/api/v1/runs/run-1/events"),
      "run-1"
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const backlog = decoder.decode((await reader.read()).value);

    const verifying = await journal.publish({
      runId: "run-1",
      type: "status_changed",
      data: { status: "verifying" }
    });
    await broadcaster.deliver(verifying);
    const live = decoder.decode((await reader.read()).value);

    // At-least-once outbox delivery may repeat event 2; the handler must suppress it.
    await broadcaster.deliver(verifying);
    const succeeded = await journal.publish({
      runId: "run-1",
      type: "status_changed",
      data: { status: "succeeded" }
    });
    await broadcaster.deliver(succeeded);
    const afterDuplicate = decoder.decode((await reader.read()).value);
    await reader.cancel();

    expect({
      contentType: response.headers.get("content-type"),
      eventIds: `${backlog}${live}${afterDuplicate}`
        .split("\n")
        .filter((line) => line.startsWith("id: "))
    }).toEqual({
      contentType: "text/event-stream; charset=utf-8",
      eventIds: ["id: 1", "id: 2", "id: 3"]
    });
  });
});
