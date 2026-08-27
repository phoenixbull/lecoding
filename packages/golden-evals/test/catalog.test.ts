import { describe, expect, it } from "vitest";
import {
  loadGoldenTaskCatalog,
  selectAcceptanceGoldenTasks,
  selectRepresentativeGoldenTasks
} from "../src/index.js";

describe("GoldenTaskCatalog", () => {
  it("provides 20 deterministic repository tasks with executable acceptance evidence", () => {
    const catalog = loadGoldenTaskCatalog();

    expect(catalog).toHaveLength(20);
    expect(new Set(catalog.map((task) => task.id)).size).toBe(20);
    for (const task of catalog) {
      expect(task.repository.seedFiles.length).toBeGreaterThan(0);
      expect(task.acceptanceCriteria.length).toBeGreaterThan(0);
      expect(task.verificationCommands.length).toBeGreaterThan(0);
    }
  });

  it("selects five stable representatives across the Phase 0 risk categories", () => {
    const selected = selectRepresentativeGoldenTasks(loadGoldenTaskCatalog());

    expect(selected.map((task) => task.id)).toEqual([
      "ts-fix-boundary",
      "python-add-validation",
      "security-path-traversal",
      "docs-quickstart",
      "performance-deduplicate"
    ]);
    expect(new Set(selected.map((task) => task.category)).size).toBe(5);
  });

  it("uses a real Python fixture for the representative Python task", () => {
    const task = loadGoldenTaskCatalog().find(
      (candidate) => candidate.id === "python-add-validation"
    );

    expect(task?.repository.seedFiles.map((file) => file.path)).toContain(
      "subject.py"
    );
    expect(task?.verificationCommands).toEqual([
      ["python3", "-m", "unittest", "-v"]
    ]);
  });

  it("selects a stable category-balanced 12-task acceptance suite", () => {
    const selected = selectAcceptanceGoldenTasks(loadGoldenTaskCatalog());

    expect(selected.map((task) => task.id)).toEqual([
      "ts-fix-boundary",
      "js-fix-async-race",
      "python-fix-parser",
      "ts-add-required-field",
      "python-add-validation",
      "ui-empty-state",
      "security-path-traversal",
      "schema-unique-call-id",
      "docs-quickstart",
      "docs-error-reference",
      "performance-deduplicate",
      "performance-bounded-log"
    ]);
    expect(
      Object.fromEntries(
        [...new Set(selected.map((task) => task.category))].map((category) => [
          category,
          selected.filter((task) => task.category === category).length
        ])
      )
    ).toEqual({ bugfix: 3, feature: 3, security: 2, docs: 2, performance: 2 });
  });
});
