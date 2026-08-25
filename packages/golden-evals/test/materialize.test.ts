import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadGoldenTaskCatalog,
  materializeGoldenTask
} from "../src/index.js";

describe("materializeGoldenTask", () => {
  it("creates clean Git repositories with a stable base revision", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "lecoding-golden-"));
    const task = loadGoldenTaskCatalog()[0]!;
    try {
      const first = await materializeGoldenTask(task, {
        repositoryPath: join(temporaryRoot, "first")
      });
      const second = await materializeGoldenTask(task, {
        repositoryPath: join(temporaryRoot, "second")
      });

      expect(first.baseRef).toBe(second.baseRef);
      expect(first.status).toBe("");
      await expect(
        readFile(join(first.repositoryPath, "src/subject.js"), "utf8")
      ).resolves.toBe(task.repository.seedFiles[1]!.content);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
