import { describe, expect, it, vi } from "vitest";
import {
  cleanupWorktree,
  residualProgressEvent,
  type ResidualPath
} from "../src/cleanup.js";
import {
  createMemoryJournalFileSystem,
  createRunJournal,
  recoverRunState,
  type RunJournalEntry
} from "../src/run-journal.js";

const now = () => "2026-09-03T00:00:00.000Z";

function journal() {
  const fs = createMemoryJournalFileSystem();
  return {
    fs,
    journal: createRunJournal({ filePath: "/state/run-journal.jsonl", now, fs })
  };
}

describe("createRunJournal", () => {
  it("appends and reads back entries in order", async () => {
    const { journal: j } = journal();
    await j.append({
      kind: "handle.prepared",
      runId: "run-1",
      handleId: "h1",
      worktreePath: "/work/run-1",
      recordedAt: now()
    });
    await j.append({
      kind: "command.started",
      runId: "run-1",
      commandId: 1,
      recordedAt: now()
    });

    const entries = await j.read();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.kind).toBe("handle.prepared");
  });

  it("returns an empty journal when the file does not exist", async () => {
    const { journal: j } = journal();
    await expect(j.read()).resolves.toEqual([]);
  });

  it("skips a truncated final line instead of losing the record", async () => {
    // A crash mid-write is the realistic corruption; earlier entries must survive.
    const { fs, journal: j } = journal();
    await j.append({
      kind: "handle.prepared",
      runId: "run-1",
      handleId: "h1",
      worktreePath: "/work/run-1",
      recordedAt: now()
    });
    fs.append("/state/run-journal.jsonl", '{"kind":"command.started","runI');
    await expect(j.read()).resolves.toHaveLength(1);
  });

  it("skips entries with an unknown kind", async () => {
    const fs = createMemoryJournalFileSystem();
    await fs.write("/state/run-journal.jsonl", '{"kind":"whatever","recordedAt":"t"}\n');
    const j = createRunJournal({ filePath: "/state/run-journal.jsonl", now, fs });
    await expect(j.read()).resolves.toEqual([]);
  });

  it("compacts away resolved runs but keeps active ones", async () => {
    const { journal: j } = journal();
    await j.append({ kind: "handle.prepared", runId: "run-1", handleId: "h1", worktreePath: "/w/1", recordedAt: now() });
    await j.append({ kind: "handle.resolved", runId: "run-1", outcome: "discard", recordedAt: now() });
    await j.append({ kind: "handle.prepared", runId: "run-2", handleId: "h2", worktreePath: "/w/2", recordedAt: now() });

    // run-1 is finished, so every one of its records is garbage; run-2 is live
    // and must survive intact.
    const result = await j.compact(["run-2"]);
    expect(result.removed).toBe(2);
    const remaining = await j.read();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ runId: "run-2" });
  });

  it("keeps an idle run that has not been resolved", async () => {
    // Compaction must not drop a prepared worktree whose server session has
    // not reconnected yet — that would lose recoverable state.
    const { journal: j } = journal();
    await j.append({ kind: "handle.prepared", runId: "run-9", handleId: "h9", worktreePath: "/w/9", recordedAt: now() });

    await j.compact([]);
    await expect(j.read()).resolves.toHaveLength(1);
  });

  it("writes compaction atomically so a crash cannot truncate the journal", async () => {
    const { fs, journal: j } = journal();
    await j.append({ kind: "handle.prepared", runId: "run-1", handleId: "h1", worktreePath: "/w/1", recordedAt: now() });
    const rename = vi.spyOn(fs, "rename");

    await j.compact(["run-1"]);
    // Published by rename, not by an in-place rewrite.
    expect(rename).toHaveBeenCalled();
  });
});

describe("recoverRunState", () => {
  function entry(partial: RunJournalEntry): RunJournalEntry {
    return partial;
  }

  it("recovers prepared handles that were never resolved", () => {
    const state = recoverRunState([
      entry({ kind: "handle.prepared", runId: "run-1", handleId: "h1", worktreePath: "/w/1", recordedAt: now() })
    ]);
    expect(state.handles).toEqual([{ runId: "run-1", handleId: "h1", worktreePath: "/w/1" }]);
  });

  it("drops handles that were resolved", () => {
    // A restart must not resurrect a worktree the user already discarded.
    const state = recoverRunState([
      entry({ kind: "handle.prepared", runId: "run-1", handleId: "h1", worktreePath: "/w/1", recordedAt: now() }),
      entry({ kind: "handle.resolved", runId: "run-1", outcome: "discard", recordedAt: now() })
    ]);
    expect(state.handles).toEqual([]);
    expect(state.resolvedRunIds).toEqual(["run-1"]);
  });

  it("separates settled commands from interrupted ones", () => {
    const state = recoverRunState([
      entry({ kind: "command.started", runId: "r", commandId: 1, recordedAt: now() }),
      entry({ kind: "command.settled", runId: "r", commandId: 1, outcome: { ok: true, value: { exitCode: 0 } }, recordedAt: now() }),
      entry({ kind: "command.started", runId: "r", commandId: 2, recordedAt: now() })
    ]);

    expect(state.settledCommands).toEqual([{ commandId: 1, outcome: { ok: true, value: { exitCode: 0 } } }]);
    // Command 2 started but never settled: re-running it could repeat a side
    // effect whose result we never observed, so it must be refused.
    expect(state.interruptedCommandIds).toEqual([2]);
  });

  it("reports the highest command id for the resume hint", () => {
    const state = recoverRunState([
      entry({ kind: "command.started", runId: "r", commandId: 7, recordedAt: now() }),
      entry({ kind: "command.started", runId: "r", commandId: 3, recordedAt: now() })
    ]);
    expect(state.highestCommandId).toBe(7);
  });

  it("returns empty state for an empty journal", () => {
    const state = recoverRunState([]);
    expect(state).toEqual({
      handles: [],
      resolvedRunIds: [],
      resolved: [],
      settledCommands: [],
      interruptedCommandIds: [],
      highestCommandId: 0
    });
  });

  it("recovers the outcome each resolved Run reached", () => {
    // Recovery needs the decision, not just the fact of resolution: a
    // relaunched desktop must answer a replayed resolve with the user's
    // original choice rather than treating it as new work.
    const state = recoverRunState([
      entry({ kind: "handle.prepared", runId: "run-1", handleId: "h1", worktreePath: "/w/1", recordedAt: now() }),
      entry({ kind: "handle.resolved", runId: "run-1", outcome: "keep", recordedAt: now() })
    ]);
    expect(state.resolved).toEqual([{ runId: "run-1", outcome: "keep" }]);
  });

  it("keeps the latest resolution when a Run was resolved more than once", () => {
    const state = recoverRunState([
      entry({ kind: "handle.resolved", runId: "run-1", outcome: "discard", recordedAt: now() }),
      entry({ kind: "handle.resolved", runId: "run-1", outcome: "keep", recordedAt: now() })
    ]);
    expect(state.resolved).toEqual([{ runId: "run-1", outcome: "keep" }]);
  });

  it("treats a re-prepared run as live again", () => {
    // Handles matter, not history: prepare after resolve starts a new Run
    // under a reused id, which must be recoverable.
    const state = recoverRunState([
      entry({ kind: "handle.resolved", runId: "run-1", outcome: "keep", recordedAt: now() }),
      entry({ kind: "handle.prepared", runId: "run-1", handleId: "h2", worktreePath: "/w/1", recordedAt: now() })
    ]);
    expect(state.handles).toHaveLength(1);
    expect(state.resolvedRunIds).toEqual([]);
  });
});

describe("cleanupWorktree", () => {
  it("reports success when the path is already gone", async () => {
    // Idempotent by construction: keep/discard can arrive twice after a
    // reconnect, and the second call must not look like a failure.
    const result = await cleanupWorktree(
      { runId: "run-1", path: "/work/run-1" },
      { now, exists: () => false }
    );
    expect(result).toEqual({ cleaned: true });
  });

  it("reports success when removal removes the path", async () => {
    let present = true;
    const result = await cleanupWorktree(
      { runId: "run-1", path: "/work/run-1" },
      {
        now,
        exists: () => present,
        remove: async () => {
          present = false;
        }
      }
    );
    expect(result.cleaned).toBe(true);
    expect(result.residual).toBeUndefined();
  });

  it("leaves a residual record when removal throws", async () => {
    const result = await cleanupWorktree(
      { runId: "run-1", path: "/work/run-1" },
      {
        now,
        exists: () => true,
        remove: async () => {
          throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
        }
      }
    );

    expect(result.cleaned).toBe(false);
    expect(result.residual).toMatchObject({
      runId: "run-1",
      path: "/work/run-1",
      reason: "removal_failed",
      detail: "EBUSY: resource busy"
    });
    // The user must be told what to do, not just that something failed.
    expect(result.residual?.recovery).toMatch(/delete it manually/i);
  });

  it("does not trust a removal that left the path behind", async () => {
    // `rm --force` can leave entries on a busy mount; reporting success would
    // leave the user with an invisible worktree.
    const result = await cleanupWorktree(
      { runId: "run-1", path: "/work/run-1" },
      { now, exists: () => true, remove: async () => undefined }
    );
    expect(result.cleaned).toBe(false);
    expect(result.residual?.reason).toBe("still_present");
  });

  it("projects a residual onto the progress event contract", () => {
    const residual: ResidualPath = {
      runId: "run-1",
      path: "/work/run-1",
      reason: "removal_failed",
      detail: "EBUSY",
      recovery: "Close the folder and delete it manually.",
      recordedAt: now()
    };
    const event = residualProgressEvent(residual);
    expect(event.type).toBe("residual.path");
    if (event.type === "residual.path") {
      expect(event.path).toBe("/work/run-1");
      expect(event.reason).toContain("EBUSY");
    }
  });
});
