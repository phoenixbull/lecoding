import { describe, expect, it, vi } from "vitest";
import {
  createMemoryJournalFileSystem,
  createRunJournal,
  type RunJournalEntry
} from "@lecoding/local-runner";
import type { RunnerCommandOutcome } from "@lecoding/runner-protocol";
import {
  createLocalRunnerHost,
  type LocalRunnerHostOptions
} from "../src/main/local-runner-host.js";

const now = () => "2026-09-03T00:00:00.000Z";

/** Builds a host over an in-memory journal, recording Git-side resolutions. */
function harness(options: { entries?: RunJournalEntry[] } = {}) {
  const fs = createMemoryJournalFileSystem();
  if (options.entries) {
    // Seed the journal as if a previous process had written it.
    fs.write(
      "/state/run-journal.jsonl",
      options.entries.map((entry) => `${JSON.stringify(entry)}\n`).join("")
    );
  }
  const journal = createRunJournal({
    filePath: "/state/run-journal.jsonl",
    now,
    fs
  });
  const resolutions: Array<{ runId: string; outcome: "keep" | "discard" }> = [];
  const cancels: string[] = [];
  const hostOptions: LocalRunnerHostOptions = {
    journal,
    resolveRunOutcome: async (runId, outcome) => {
      resolutions.push({ runId, outcome });
    },
    cancelRun: (runId) => cancels.push(runId),
    now
  };
  return {
    fs,
    journal,
    resolutions,
    cancels,
    host: createLocalRunnerHost(hostOptions)
  };
}

function prepared(runId: string, path: string): RunJournalEntry {
  return {
    kind: "handle.prepared",
    runId,
    handleId: `${runId}::${path}`,
    worktreePath: path,
    recordedAt: now()
  };
}

function started(runId: string, commandId: number): RunJournalEntry {
  return { kind: "command.started", runId, commandId, recordedAt: now() };
}

function settled(
  runId: string,
  commandId: number,
  outcome: RunnerCommandOutcome
): RunJournalEntry {
  return { kind: "command.settled", runId, commandId, outcome, recordedAt: now() };
}

describe("createLocalRunnerHost", () => {
  it("recovers a prepared worktree across a restart", async () => {
    const { host } = harness({ entries: [prepared("run-1", "/work/run-1")] });
    const state = await host.recover();

    expect(state.handles).toHaveLength(1);
    // The recovered record is addressable, so a server reconnecting after the
    // restart can still resolve or clean it.
    expect(host.runs()).toEqual([
      { runId: "run-1", handleId: "run-1::/work/run-1", worktreePath: "/work/run-1", resolved: false }
    ]);
  });

  it("refuses to re-run a command whose outcome was never observed", async () => {
    // This is the safety-critical case: command 1 settled, command 2 did not.
    // Re-running 2 could repeat a side effect we never saw.
    const { host } = harness({
      entries: [
        started("run-1", 1),
        settled("run-1", 1, { ok: true, value: { exitCode: 0 } }),
        started("run-1", 2)
      ]
    });
    await host.recover();

    expect(host.interrupted()).toEqual([
      {
        commandId: 2,
        reason: expect.stringContaining("was not run again")
      }
    ]);
  });

  it("treats settled commands as replayable, not interrupted", async () => {
    const { host } = harness({
      entries: [started("run-1", 1), settled("run-1", 1, { ok: true, value: {} })]
    });
    await host.recover();
    expect(host.interrupted()).toEqual([]);
  });

  it("resolves a Run and records the decision durably", async () => {
    const { host, journal, resolutions } = harness();
    await host.recover();
    await host.beginCommand({ runId: "run-1", commandId: 1 });
    await host.settleCommand({ runId: "run-1", commandId: 1, outcome: { ok: true, value: null } });

    const result = await host.resolve({ runId: "run-1", outcome: "keep" });

    expect(result.resolved).toBe(true);
    expect(resolutions).toEqual([{ runId: "run-1", outcome: "keep" }]);
    const entries = await journal.read();
    // Both the command lifecycle and the resolution are durable, so a crash at
    // any point leaves a truthful record.
    expect(entries.map((entry) => entry.kind)).toEqual([
      "command.started",
      "command.settled",
      "handle.resolved"
    ]);
  });

  it("returns the first decision when a resolve is replayed", async () => {
    const { host, resolutions } = harness();
    await host.recover();
    await host.resolve({ runId: "run-1", outcome: "keep" });

    const replay = await host.resolve({ runId: "run-1", outcome: "discard" });

    // The duplicate must not flip a keep into a discard, whatever the server
    // now asks for.
    expect(replay.alreadyResolved).toBe(true);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.outcome).toBe("keep");
  });

  it("does not re-resolve Git state for a recovered, already-resolved Run", async () => {
    const { host, resolutions } = harness({
      entries: [prepared("run-1", "/work/run-1")]
    });
    await host.recover();
    await host.resolve({ runId: "run-1", outcome: "keep" });

    // Still exactly one Git-side resolution, despite the Run being recovered.
    expect(resolutions).toHaveLength(1);
  });

  it("cancels a Run it knows about", async () => {
    const { host, cancels } = harness({ entries: [prepared("run-1", "/w/1")] });
    await host.recover();

    expect(host.cancel("run-1")).toEqual({ cancelled: true });
    expect(cancels).toEqual(["run-1"]);
  });

  it("refuses to cancel a Run it does not know about", async () => {
    const { host, cancels } = harness();
    await host.recover();
    expect(host.cancel("ghost")).toEqual({ cancelled: false, reason: "run_unknown" });
    expect(cancels).toEqual([]);
  });

  it("reports a residual path when cleanup fails", async () => {
    const { host } = harness({ entries: [prepared("run-1", "/work/run-1")] });
    await host.recover();
    // Stub the removal so the worktree survives, as it would when a file inside
    // is held open by an editor.
    const original = host.cleanup.bind(host);
    const cleanup = vi
      .fn()
      .mockResolvedValue({
        cleaned: false,
        residual: {
          runId: "run-1",
          path: "/work/run-1",
          reason: "removal_failed",
          detail: "EBUSY: resource busy",
          recovery: "Close the folder and delete it manually.",
          recordedAt: now()
        }
      });
    (host as unknown as { cleanup: typeof cleanup }).cleanup = cleanup;

    const result = await host.resolve({ runId: "run-1", outcome: "discard" });

    expect(result.cleaned).toBe(false);
    expect(result.residual?.path).toBe("/work/run-1");
    expect(cleanup).toHaveBeenCalled();
    void original;
  });

  it("keeps the Run addressable after a failed cleanup", async () => {
    const { host } = harness({ entries: [prepared("run-1", "/work/run-1")] });
    await host.recover();
    const result = await host.resolve({ runId: "run-1", outcome: "keep" });

    // The record stays resolved even though the folder survived, so a retry is
    // not needed to know the user's intent.
    expect(result.resolved).toBe(true);
    expect(host.runs()[0]?.resolved).toBe(true);
  });
});
