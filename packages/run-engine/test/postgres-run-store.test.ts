import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { RunConflictError, type StoredRun } from "../src/index.js";
import { createPostgresRunStore } from "../src/postgres-run-store.js";

/** Builds a complete persisted Run snapshot through the public RunStore seam. */
function createStoredRun(): StoredRun {
  return {
    id: "run-1",
    input: {
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Persist this run",
      acceptanceCriteria: ["Run survives a worker restart"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    },
    status: "queued",
    version: 0,
    toolResults: []
  };
}

describe("PostgreSQL RunStore", () => {
  it("persists a Run snapshot across store instances", async () => {
    const database = new PGlite();
    const firstProcessStore = await createPostgresRunStore(database);
    const run = createStoredRun();

    run.version = await firstProcessStore.save(run);

    // A new adapter instance represents a replacement Worker process.
    const replacementProcessStore = await createPostgresRunStore(database);
    await expect(replacementProcessStore.get(run.id)).resolves.toEqual(run);

    await database.close();
  });

  it("rejects a stale snapshot instead of overwriting a newer Run", async () => {
    const database = new PGlite();
    const store = await createPostgresRunStore(database);
    const original = createStoredRun();
    original.version = await store.save(original);
    const stale = structuredClone(original);

    original.status = "running";
    original.version = await store.save(original);
    stale.status = "cancelled";

    await expect(store.save(stale)).rejects.toBeInstanceOf(RunConflictError);
    await expect(store.get(original.id)).resolves.toEqual(original);

    await database.close();
  });
});
