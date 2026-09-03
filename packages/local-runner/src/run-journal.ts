/**
 * Durable journal for Local Runner recovery.
 *
 * The Runner is a desktop process that gets quit, updated and crashed. Without
 * a durable record, a restart would either lose every prepared worktree or —
 * far worse — re-run a command whose outcome was never observed. This journal
 * exists to make both recoverable.
 *
 * It is append-only, one JSON object per line. Append-only matters twice over:
 * a partially written final line can be skipped on read, whereas a truncated
 * JSON document would destroy the whole record, and an entry can never be
 * edited to hide that a command started.
 *
 * Two facts are recorded and they answer different questions:
 *
 * - **Handle lifecycle** — what worktree exists, and whether it has been
 *   resolved. Recovery uses this to pick up prepared worktrees after a restart.
 * - **Command lifecycle** — which command ids started and which settled.
 *   The difference between the two is exactly the set that must NOT be
 *   re-executed, because their side effects cannot be known.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunnerCommandOutcome } from "@lecoding/runner-protocol";

export type RunJournalEntry =
  | {
      kind: "handle.prepared";
      runId: string;
      handleId: string;
      worktreePath: string;
      recordedAt: string;
    }
  | { kind: "handle.resolved"; runId: string; outcome: "keep" | "discard"; recordedAt: string }
  | { kind: "command.started"; runId: string; commandId: number; recordedAt: string }
  | {
      kind: "command.settled";
      runId: string;
      commandId: number;
      outcome: RunnerCommandOutcome;
      recordedAt: string;
    };

/** The filesystem surface the journal needs; tests substitute memory. */
export interface JournalFileSystem {
  append(path: string, chunk: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  /** Atomic within a directory; used to publish a compaction. */
  rename(source: string, target: string): Promise<void>;
  ensureDirectory(path: string): Promise<void>;
}

export interface RunJournalOptions {
  filePath: string;
  /** Injected clock so recovery tests are deterministic. */
  now(): string;
  fs?: JournalFileSystem;
}

export interface RunJournal {
  append(entry: RunJournalEntry): Promise<void>;
  read(): Promise<RunJournalEntry[]>;
  /** Drops resolved handles and settled commands, keeping the file bounded. */
  compact(activeRunIds: readonly string[]): Promise<{ kept: number; removed: number }>;
}

/**
 * Replays the journal into recoverable state.
 *
 * `interruptedCommandIds` is the safety-critical output: those commands started
 * but never settled, so the Runner must answer `command_interrupted` instead of
 * running them again.
 */
export interface RecoveredRunState {
  /** Prepared and not yet resolved, keyed by run id. */
  handles: Array<{ runId: string; handleId: string; worktreePath: string }>;
  /** Run ids that already reached a keep/discard decision. */
  resolvedRunIds: string[];
  /** Command ids with a known outcome, safe to replay from cache. */
  settledCommands: Array<{ commandId: number; outcome: RunnerCommandOutcome }>;
  /** Command ids that started but never settled — must not be re-executed. */
  interruptedCommandIds: number[];
  /** Highest command id ever accepted, used for the reconnect resume hint. */
  highestCommandId: number;
}

export function createRunJournal(options: RunJournalOptions): RunJournal {
  const fs = options.fs ?? createNodeJournalFileSystem();

  return {
    async append(entry) {
      await fs.ensureDirectory(dirname(options.filePath));
      await fs.append(options.filePath, `${JSON.stringify(entry)}\n`);
    },

    async read() {
      let contents: string;
      try {
        contents = await fs.read(options.filePath);
      } catch {
        return [];
      }
      const entries: RunJournalEntry[] = [];
      for (const line of contents.split("\n")) {
        if (line.trim() === "") {
          continue;
        }
        const parsed = parseEntry(line);
        if (parsed) {
          entries.push(parsed);
        }
      }
      return entries;
    },

    async compact(activeRunIds) {
      const entries = await this.read();
      const active = new Set(activeRunIds);
      // A run is droppable only once it has been resolved AND is no longer
      // active. Dropping a merely idle run would lose a prepared worktree whose
      // server session has not reconnected yet.
      const finished = new Set(
        entries.filter((entry) => entry.kind === "handle.resolved").map((entry) => entry.runId)
      );
      const droppable = new Set([...finished].filter((runId) => !active.has(runId)));

      const kept: RunJournalEntry[] = [];
      let removed = 0;
      for (const entry of entries) {
        if (droppable.has(entry.runId)) {
          removed += 1;
          continue;
        }
        kept.push(entry);
      }
      // Write-then-rename so a crash mid-compaction cannot truncate the journal.
      const serialized = kept.map((entry) => JSON.stringify(entry)).join("\n");
      await fs.ensureDirectory(dirname(options.filePath));
      const temporary = `${options.filePath}.compact`;
      await fs.write(temporary, serialized.length > 0 ? `${serialized}\n` : "");
      await fs.rename(temporary, options.filePath);
      return { kept: kept.length, removed };
    }
  };
}

/** Rebuilds recoverable state from the journal's append-only history. */
export function recoverRunState(entries: readonly RunJournalEntry[]): RecoveredRunState {
  const prepared = new Map<string, { runId: string; handleId: string; worktreePath: string }>();
  const resolved = new Set<string>();
  const started = new Map<number, string>();
  const settled = new Map<number, RunnerCommandOutcome>();
  let highestCommandId = 0;

  for (const entry of entries) {
    switch (entry.kind) {
      case "handle.prepared": {
        // Last write wins only for unresolved runs; a resolved run is dropped
        // below so a re-prepared run id cannot resurrect a finished worktree.
        prepared.set(entry.runId, {
          runId: entry.runId,
          handleId: entry.handleId,
          worktreePath: entry.worktreePath
        });
        resolved.delete(entry.runId);
        break;
      }
      case "handle.resolved": {
        resolved.add(entry.runId);
        prepared.delete(entry.runId);
        break;
      }
      case "command.started": {
        started.set(entry.commandId, entry.runId);
        if (entry.commandId > highestCommandId) {
          highestCommandId = entry.commandId;
        }
        break;
      }
      case "command.settled": {
        settled.set(entry.commandId, entry.outcome);
        if (entry.commandId > highestCommandId) {
          highestCommandId = entry.commandId;
        }
        break;
      }
      default:
        break;
    }
  }

  const interruptedCommandIds = [...started.keys()]
    .filter((commandId) => !settled.has(commandId))
    .sort((left, right) => left - right);

  return {
    handles: [...prepared.values()],
    resolvedRunIds: [...resolved],
    settledCommands: [...settled.entries()].map(([commandId, outcome]) => ({
      commandId,
      outcome
    })),
    interruptedCommandIds,
    highestCommandId
  };
}

/** Validates one line; returns undefined for a truncated or unknown record. */
function parseEntry(line: string): RunJournalEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record["recordedAt"] !== "string") {
    return undefined;
  }
  switch (record["kind"]) {
    case "handle.prepared": {
      const { runId, handleId, worktreePath } = record;
      if (typeof runId !== "string" || typeof handleId !== "string" || typeof worktreePath !== "string") {
        return undefined;
      }
      return {
        kind: "handle.prepared",
        runId,
        handleId,
        worktreePath,
        recordedAt: record["recordedAt"]
      };
    }
    case "handle.resolved": {
      const { runId, outcome } = record;
      if (typeof runId !== "string" || (outcome !== "keep" && outcome !== "discard")) {
        return undefined;
      }
      return {
        kind: "handle.resolved",
        runId,
        outcome,
        recordedAt: record["recordedAt"]
      };
    }
    case "command.started": {
      const { runId, commandId } = record;
      if (typeof runId !== "string" || !Number.isSafeInteger(commandId)) {
        return undefined;
      }
      return {
        kind: "command.started",
        runId,
        commandId: commandId as number,
        recordedAt: record["recordedAt"]
      };
    }
    case "command.settled": {
      const { runId, commandId, outcome } = record;
      if (typeof runId !== "string" || !Number.isSafeInteger(commandId)) {
        return undefined;
      }
      const parsedOutcome = parseOutcome(outcome);
      if (!parsedOutcome) {
        return undefined;
      }
      return {
        kind: "command.settled",
        runId,
        commandId: commandId as number,
        outcome: parsedOutcome,
        recordedAt: record["recordedAt"]
      };
    }
    default:
      return undefined;
  }
}

function parseOutcome(value: unknown): RunnerCommandOutcome | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record["ok"] === true) {
    return { ok: true, value: record["value"] as never };
  }
  if (record["ok"] === false) {
    const { code, message } = record;
    if (typeof code !== "string" || typeof message !== "string") {
      return undefined;
    }
    return { ok: false, code: code as never, message };
  }
  return undefined;
}

function createNodeJournalFileSystem(): JournalFileSystem {
  return {
    async append(path, chunk) {
      await appendFile(path, chunk, "utf8");
    },
    async read(path) {
      return await readFile(path, "utf8");
    },
    async write(path, contents) {
      await writeFile(path, contents, "utf8");
    },
    async ensureDirectory(path) {
      await mkdir(path, { recursive: true });
    },
    async rename(source, target) {
      await rename(source, target);
    }
  };
}

/** In-memory journal filesystem for tests. */
export function createMemoryJournalFileSystem(): JournalFileSystem & {
  contents(path: string): string;
} {
  const files = new Map<string, string>();
  return {
    async append(path, chunk) {
      files.set(path, (files.get(path) ?? "") + chunk);
    },
    async read(path) {
      const contents = files.get(path);
      if (contents === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return contents;
    },
    async write(path, data) {
      files.set(path, data);
    },
    async ensureDirectory() {
      // Directories are implicit in the in-memory model.
    },
    async rename(source, target) {
      const contents = files.get(source);
      if (contents === undefined) {
        throw Object.assign(new Error(`ENOENT: ${source}`), { code: "ENOENT" });
      }
      files.delete(source);
      files.set(target, contents);
    },
    contents(path) {
      return files.get(path) ?? "";
    }
  };
}
