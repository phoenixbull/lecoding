/**
 * Bounded replay window for everything the Runner sends upward.
 *
 * `result` and `event` share one cursor sequence. They must: replay has to
 * reproduce the Runner's original interleaving, and two independent sequences
 * could not express "this audit row came before that command finished".
 *
 * The window exists so a reconnecting session can re-send frames the server
 * never acknowledged. It is bounded, and the bound is honest: when the server
 * stops acknowledging, the oldest frames are dropped and `overflowed()` starts
 * counting. The session is expected to treat a non-zero count as a broken
 * stream and fail, rather than silently deliver a partial replay and claim the
 * guarantee held.
 *
 * Cursor 0 means "nothing yet", so the first recorded frame is cursor 1 and
 * `replayFromCursor = lastAckedCursor + 1` is correct from the very first frame.
 */

import type { RunnerCommandOutcome, RunnerProgressEvent } from "./envelope.js";

/** An upward frame before the window has assigned its cursor. */
export type EventWindowInput =
  | { kind: "result"; id: number; outcome: RunnerCommandOutcome }
  | { kind: "event"; event: RunnerProgressEvent };

/** An upward frame after cursor assignment — what goes on the wire. */
export type UpwardFrame =
  | {
      v: 1;
      kind: "result";
      id: number;
      cursor: number;
      outcome: RunnerCommandOutcome;
    }
  | { v: 1; kind: "event"; cursor: number; event: RunnerProgressEvent };

export interface EventWindowOptions {
  /**
   * Frames retained for replay. Must be large enough to cover the gap between
   * server acknowledgements. Default 256.
   *
   * Caller obligation: size this against how long the server can go without
   * acknowledging, not against the Run's total output. Overflow is recorded
   * rather than hidden, so an undersized window surfaces as a failed recovery
   * instead of a silent gap — but it still fails the Run, so it is worth
   * sizing generously.
   */
  maxFrames?: number;
}

export interface EventWindow {
  /**
   * Assigns the next cursor, stores the frame, and returns it.
   *
   * The returned frame is the one to put on the wire: buffering an earlier
   * copy and sending it later would desynchronize the cursor the peer acks.
   */
  record(input: EventWindowInput): UpwardFrame;
  /** Stored frames with a cursor strictly greater than `after`, in order. */
  after(after: number): UpwardFrame[];
  /**
   * Forgets frames at or below `cursor` because the peer acknowledged them.
   *
   * Caller obligation: only pass a cursor the peer actually acknowledged.
   * Trimming past unacknowledged frames would drop them from replay while the
   * peer still expects them.
   */
  trim(cursor: number): void;
  /** Highest cursor ever assigned; 0 before the first record. */
  latest(): number;
  /**
   * Frames discarded because the peer stopped acknowledging.
   *
   * Non-zero means replay can no longer be complete. The session must surface
   * this instead of presenting a truncated replay as a successful recovery.
   */
  overflowed(): number;
  /** Frames currently retained. */
  size(): number;
}

export function createEventWindow(options: EventWindowOptions = {}): EventWindow {
  const maxFrames = options.maxFrames ?? 256;
  let frames: UpwardFrame[] = [];
  // Never rewound, even by trim: a reused cursor would make replay ambiguous.
  let cursor = 0;
  let dropped = 0;

  return {
    record(input) {
      cursor += 1;
      const frame: UpwardFrame =
        input.kind === "result"
          ? {
              v: 1,
              kind: "result",
              id: input.id,
              cursor,
              outcome: input.outcome
            }
          : { v: 1, kind: "event", cursor, event: input.event };

      frames.push(frame);
      while (frames.length > maxFrames) {
        frames.shift();
        dropped += 1;
      }
      return frame;
    },

    after(after) {
      return frames.filter((frame) => frame.cursor > after);
    },

    trim(acknowledgedCursor) {
      frames = frames.filter((frame) => frame.cursor > acknowledgedCursor);
    },

    latest() {
      return cursor;
    },

    overflowed() {
      return dropped;
    },

    size() {
      return frames.length;
    }
  };
}
