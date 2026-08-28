import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPostgresLocalArtifactStore } from "../src/postgres-local-artifact-store.js";

describe("PostgreSQL local Artifact store", () => {
  it("keeps only immutable metadata in PostgreSQL and verifies local content by hash", async () => {
    const database = new PGlite();
    const root = await mkdtemp(join(tmpdir(), "lecoding-artifacts-"));
    const store = await createPostgresLocalArtifactStore(database, {
      root,
      now: () => "2026-08-28T06:00:00.000Z"
    });

    try {
      const reference = await store.write({
        runId: "run-1",
        projectId: "project-1",
        kind: "command_stdout",
        // The caller-side redactor has already replaced the provider credential.
        content: "build output [REDACTED]"
      });
      const metadata = await store.get(reference.id);

      expect(metadata).toMatchObject({
        ...reference,
        runId: "run-1",
        projectId: "project-1",
        createdAt: "2026-08-28T06:00:00.000Z"
      });
      await expect(store.read(reference.id)).resolves.toBe(
        "build output [REDACTED]"
      );
      await expect(
        readFile(join(root, metadata?.storageKey ?? "missing"), "utf8")
      ).resolves.toBe("build output [REDACTED]");

      const columns = await database.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_name = 'run_engine_artifacts'`
      );
      expect(columns.rows.map((row) => row.column_name)).not.toContain("content");
    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes expired bytes and metadata while retaining newer Artifacts", async () => {
    const database = new PGlite();
    const root = await mkdtemp(join(tmpdir(), "lecoding-artifacts-retention-"));
    let now = "2026-08-20T00:00:00.000Z";
    const store = await createPostgresLocalArtifactStore(database, {
      root,
      now: () => now
    });

    try {
      const expired = await store.write({
        runId: "run-old",
        projectId: "project-1",
        kind: "command_stdout",
        content: "old output"
      });
      now = "2026-08-28T00:00:00.000Z";
      const retained = await store.write({
        runId: "run-new",
        projectId: "project-1",
        kind: "command_stdout",
        content: "new output"
      });

      await expect(
        store.pruneExpired({ before: "2026-08-21T00:00:00.000Z" })
      ).resolves.toEqual({ deletedIds: [expired.id], failures: [] });
      await expect(store.get(expired.id)).resolves.toBeUndefined();
      await expect(store.read(retained.id)).resolves.toBe("new output");
    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
