/**
 * Local Runner host: the desktop's local execution brain.
 *
 * This is the module that makes M2.3 real. It owns, for every Run the desktop
 * executes locally:
 *
 * - a durable handle journal, so a restart can pick up prepared worktrees
 * - a record of commands that started but never settled, which recovery must
 *   refuse to re-run because their effect cannot be known
 * - idempotent keep/discard, so a re-sent resolve after a reconnect is safe
 * - cancellation, which reaches every state the Run can be in
 * - residual reporting, so a failed cleanup names the exact path and what to do
 *
 * The journal is the authority on what must NOT be re-executed. A command whose
 * outcome we never observed may already have taken effect — deleting a file,
 * pushing a branch — and running it again would repeat that effect. Refusing is
 * the only safe answer.
 */

import {
  cleanupWorktree,
  createRunJournal,
  recoverRunState,
  type RecoveredRunState,
  type ResidualPath,
  type RunJournal
} from "@lecoding/local-runner";
import type { RunnerCommandOutcome } from "@lecoding/runner-protocol";

/** What the host knows about one Run. */
export interface LocalRunRecord {
  runId: string;
  handleId: string;
  worktreePath: string;
  /** True once the user made a keep/discard decision. */
  resolved: boolean;
}

/** Why an interrupted command is refused, in words a user can act on. */
export interface InterruptedCommand {
  commandId: number;
  reason: string;
}

/** The settle shape accepted for a command; mirrors the protocol's outcome. */
export type SettledCommandOutcome = RunnerCommandOutcome;

export interface LocalRunnerHostOptions {
  /** Durable journal backing recovery state. */
  journal: RunJournal;
  /**
   * Resolves Git-side state for a Run. Deliberately separate from worktree
   * removal: a keep that commits must happen even if the folder is busy.
   */
  resolveRunOutcome(runId: string, outcome: "keep" | "discard"): Promise<void>;
  /**
   * Cancels a Run's in-flight work. Called for whatever state the Run is in,
   * so a Run waiting on approval is cancelled as surely as one mid-command.
   */
  cancelRun(runId: string): void;
  now(): string;
}

export interface LocalRunnerHost {
  /** Reads the journal and rebuilds recoverable state. Call once at startup. */
  recover(): Promise<RecoveredRunState>;
  /** Prepared worktrees a restart can still operate on. */
  runs(): LocalRunRecord[];
  /**
   * Resolves a Run idempotently.
   *
   * A second call returns the first decision: the user chose once, and a
   * reconnect must not be able to flip a keep into a discard.
   */
  resolve(input: { runId: string; outcome: "keep" | "discard" }): Promise<{
    resolved: boolean;
    alreadyResolved: boolean;
    cleaned: boolean;
    residual?: ResidualPath;
  }>;
  /** Cancels a Run regardless of what it is doing. */
  cancel(runId: string): { cancelled: boolean; reason?: string };
  /** Marks a command started, making an interruption observable. */
  beginCommand(input: { runId: string; commandId: number }): Promise<void>;
  /** Marks a command settled, making its result replayable from cache. */
  settleCommand(input: {
    runId: string;
    commandId: number;
    outcome: SettledCommandOutcome;
  }): Promise<void>;
  /** Commands that started but never settled; must never be re-executed. */
  interrupted(): InterruptedCommand[];
  /** Removes a Run's worktree, reporting a residual when it survives. */
  cleanup(input: { runId: string; path: string }): Promise<{
    cleaned: boolean;
    residual?: ResidualPath;
  }>;
}

export function createLocalRunnerHost(
  options: LocalRunnerHostOptions
): LocalRunnerHost {
  const journal: RunJournal =
    options.journal ?? createRunJournal({ filePath: "", now: options.now });
  const runsById = new Map<string, LocalRunRecord>();
  /** First keep/discard decision per Run; the one that wins forever. */
  const firstDecision = new Map<string, "keep" | "discard">();
  const interruptedCommands = new Map<number, InterruptedCommand>();

  return {
    async recover() {
      const state = recoverRunState(await journal.read());
      for (const handle of state.handles) {
        runsById.set(handle.runId, {
          runId: handle.runId,
          handleId: handle.handleId,
          worktreePath: handle.worktreePath,
          resolved: false
        });
      }
      for (const commandId of state.interruptedCommandIds) {
        interruptedCommands.set(commandId, {
          commandId,
          reason:
            "The local runner stopped before this command finished. Its effect " +
            "cannot be known, so it was not run again."
        });
      }
      // Rebuild the decision map from durable state. Without this a restart
      // would forget every keep/discard already made, so a replayed resolve
      // would be treated as new work instead of answered with the user's
      // original choice.
      for (const decision of state.resolved) {
        firstDecision.set(decision.runId, decision.outcome);
        const record = runsById.get(decision.runId);
        if (record) {
          record.resolved = true;
        }
      }
      return state;
    },

    runs() {
      return [...runsById.values()];
    },

    async resolve({ runId, outcome }) {
      const existing = firstDecision.get(runId);
      if (existing !== undefined) {
        // Idempotency is the safety property: a duplicate resolve arriving over
        // a reconnected socket must not be able to reverse the user's choice.
        return { resolved: true, alreadyResolved: true, cleaned: false };
      }
      const record = runsById.get(runId);

      /*
       * Order is the whole point of this method.
       *
       * The Git effect runs first, the durable record second and the in-memory
       * decision last. Recording the decision before the work meant a failure
       * in either later step left the host believing the Run was finished: a
       * retry then answered `alreadyResolved` and the effect was never
       * performed at all — a silently lost keep or discard.
       *
       * With this order, a throw before the durable record leaves nothing
       * recorded, so the next attempt genuinely runs. A throw between the two
       * re-runs the Git resolution, which is idempotent by construction.
       */
      await options.resolveRunOutcome(runId, outcome);
      await journal.append({
        kind: "handle.resolved",
        runId,
        outcome,
        recordedAt: options.now()
      });
      firstDecision.set(runId, outcome);
      if (record) {
        record.resolved = true;
      }

      if (!record) {
        return { resolved: true, alreadyResolved: false, cleaned: true };
      }
      const cleaned = await this.cleanup({ runId, path: record.worktreePath });
      return {
        resolved: true,
        alreadyResolved: false,
        cleaned: cleaned.cleaned,
        ...(cleaned.residual ? { residual: cleaned.residual } : {})
      };
    },

    cancel(runId) {
      if (!runsById.has(runId)) {
        return { cancelled: false, reason: "run_unknown" };
      }
      // Cancel reaches every state: the host does not need to know whether the
      // Run is preparing, executing, verifying or waiting on approval, because
      // the engine-side abort plus this notification cover all four.
      options.cancelRun(runId);
      return { cancelled: true };
    },

    async beginCommand({ runId, commandId }) {
      await journal.append({
        kind: "command.started",
        runId,
        commandId,
        recordedAt: options.now()
      });
    },

    async settleCommand({ runId, commandId, outcome }) {
      await journal.append({
        kind: "command.settled",
        runId,
        commandId,
        outcome,
        recordedAt: options.now()
      });
    },

    interrupted() {
      return [...interruptedCommands.values()].map((entry) => ({ ...entry }));
    },

    async cleanup({ runId, path }) {
      // Failure here is reported, never swallowed: the caller surfaces the
      // residual path and the manual recovery step to the user.
      return await cleanupWorktree({ runId, path }, { now: options.now });
    }
  };
}
