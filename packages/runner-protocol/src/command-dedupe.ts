/**
 * Command idempotency table — the mechanism behind "a resent command never
 * repeats a side effect".
 *
 * It lives on the Runner, which is the only side that can cause a side effect,
 * and it is keyed by the server-allocated `commandId`. Three states matter:
 *
 * - **unknown** — never seen; the command may execute.
 * - **running** — executing now. A resend *attaches* to the in-flight attempt
 *   and receives the same outcome when it settles. This is why resending during
 *   a command is safe rather than merely rejected.
 * - **settled** — finished; the recorded outcome is returned immediately and
 *   `execute` is never called again.
 *
 * `seed` is the restart seam: M2.3's durable journal replays "started but
 * outcome unknown" into `seed` with `command_interrupted`, so a Runner that
 * crashed mid-command refuses to re-run it instead of guessing.
 */

import type { RunnerCommandOutcome } from "./envelope.js";

export type CommandStatus = "unknown" | "running" | "settled";

export interface CommandDedupeOptions {
  /**
   * How many completed commands to remember. Bounded because a long Run
   * produces thousands of commands; the server only ever resends from
   * `replayFromCommandId`, so anything older than this window is unreachable.
   * Default 512.
   */
  maxTrackedCommands?: number;
}

export interface CommandDedupe {
  /**
   * Resolves the outcome of `id`, calling `execute` at most once for that id.
   *
   * A throw from `execute` is converted to an `internal` outcome and cached
   * like any other failure: once execution has been attempted we cannot know
   * which side effects landed, so retrying risks repeating them.
   */
  run(
    id: number,
    execute: () => Promise<RunnerCommandOutcome>
  ): Promise<RunnerCommandOutcome>;

  /** The recorded outcome, or undefined when `id` is unknown or still running. */
  peek(id: number): RunnerCommandOutcome | undefined;

  /** Whether `id` is unknown, in flight, or finished. */
  status(id: number): CommandStatus;

  /**
   * Records an outcome without executing, for restoring from durable state.
   *
   * Returns false and changes nothing when `id` is already tracked, so a
   * journal replay can never clobber a fresher result recorded this session.
   */
  seed(id: number, outcome: RunnerCommandOutcome): boolean;

  /** Tracked commands, for assertions and capacity tests. */
  size(): number;
}

/** Error text is truncated so a pathological message cannot bloat the frame. */
const MAX_ERROR_CHARS = 500;

type Entry =
  | { status: "running"; promise: Promise<RunnerCommandOutcome> }
  | { status: "settled"; outcome: RunnerCommandOutcome };

export function createCommandDedupe(
  options: CommandDedupeOptions = {}
): CommandDedupe {
  const maxTracked = options.maxTrackedCommands ?? 512;
  // Map preserves insertion order; settled entries are re-inserted on settle so
  // iteration order doubles as least-recently-used order for eviction.
  const entries = new Map<number, Entry>();

  function evictIfNeeded(): void {
    if (entries.size <= maxTracked) {
      return;
    }
    for (const [id, entry] of entries) {
      // In-flight entries are never evicted: forgetting one would let a resend
      // start a second execution of a command that is still running.
      if (entry.status === "settled") {
        entries.delete(id);
        if (entries.size <= maxTracked) {
          return;
        }
      }
    }
  }

  return {
    async run(id, execute) {
      const existing = entries.get(id);
      if (existing) {
        return existing.status === "running"
          ? await existing.promise
          : existing.outcome;
      }

      const promise = (async () => {
        try {
          return await execute();
        } catch (error) {
          return {
            ok: false,
            code: "internal",
            message: describeError(error).slice(0, MAX_ERROR_CHARS)
          } satisfies RunnerCommandOutcome;
        }
      })();

      entries.set(id, { status: "running", promise });
      void promise
        .then((outcome) => {
          // Guard the replacement: eviction or a concurrent seed may have
          // changed this entry while the command was in flight.
          const current = entries.get(id);
          if (current?.status === "running" && current.promise === promise) {
            entries.delete(id);
            entries.set(id, { status: "settled", outcome });
            evictIfNeeded();
          }
        })
        .catch(() => undefined);

      return await promise;
    },

    peek(id) {
      const entry = entries.get(id);
      return entry?.status === "settled" ? entry.outcome : undefined;
    },

    status(id) {
      return entries.get(id)?.status ?? "unknown";
    },

    seed(id, outcome) {
      if (entries.has(id)) {
        return false;
      }
      entries.set(id, { status: "settled", outcome });
      evictIfNeeded();
      return true;
    },

    size() {
      return entries.size;
    }
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "Command execution failed";
}
