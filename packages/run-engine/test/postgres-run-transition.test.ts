import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  createPostgresRunEventRepository,
  createRunEventJournal
} from "@lecoding/run-events";
import { RunConflictError, type StoredRun } from "../src/index.js";
import { createPostgresRunStore } from "../src/postgres-run-store.js";
import { createPostgresRunTransitionWriter } from "../src/postgres-run-transition.js";

/** Builds the initial snapshot persisted by the atomic transition seam. */
function createStoredRun(): StoredRun {
  return {
    id: "run-1",
    input: {
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Persist state and event atomically",
      acceptanceCriteria: ["State and event agree"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    },
    status: "queued",
    version: 0,
    toolResults: []
  };
}

describe("PostgreSQL RunTransitionWriter", () => {
  it("persists a Run status and its resumable event as one transition", async () => {
    const database = new PGlite();
    const store = await createPostgresRunStore(database);
    const transitions = await createPostgresRunTransitionWriter({
      database,
      now: () => "2026-08-25T08:00:00.000Z"
    });
    const run = createStoredRun();

    run.version = await transitions.persist(run, "queued");

    const events = createRunEventJournal({
      repository: createPostgresRunEventRepository(database),
      now: () => "unused"
    });
    await expect(store.get(run.id)).resolves.toEqual(run);
    await expect(events.resume(run.id)).resolves.toContain(
      'data: {"version":1,"sequence":1,"runId":"run-1","type":"status_changed","occurredAt":"2026-08-25T08:00:00.000Z","data":{"status":"queued"}}'
    );

    await database.close();
  });

  it("emits no event when the Run snapshot compare-and-swap fails", async () => {
    const database = new PGlite();
    const store = await createPostgresRunStore(database);
    const transitions = await createPostgresRunTransitionWriter({
      database,
      now: () => "2026-08-25T08:00:00.000Z"
    });
    const run = createStoredRun();
    run.version = await transitions.persist(run, "queued");
    const stale = structuredClone(run);
    run.version = await transitions.persist(run, "running");

    await expect(transitions.persist(stale, "cancelled")).rejects.toBeInstanceOf(
      RunConflictError
    );

    const events = createRunEventJournal({
      repository: createPostgresRunEventRepository(database),
      now: () => "unused"
    });
    const replay = await events.resume(run.id);
    expect(replay.match(/^id: /gm)).toHaveLength(2);
    expect(replay).not.toContain('"status":"cancelled"');
    await expect(store.get(run.id)).resolves.toEqual({ ...run, status: "running" });

    await database.close();
  });
});
