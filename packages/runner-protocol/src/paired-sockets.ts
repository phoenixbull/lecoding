/**
 * In-memory `RunnerSocket` pair for deterministic protocol tests.
 *
 * The point of this adapter is control, not fidelity. Two knobs matter:
 *
 * - **`autoDeliver: true`** (default) flushes each frame as it is sent, in FIFO
 *   order. Frames that a listener sends in response are appended to the same
 *   queue and flushed by the same loop, so a request/response exchange resolves
 *   without recursion and without awaiting a microtask — assertions can run
 *   synchronously right after `send`.
 *
 * - **`autoDeliver: false`** holds frames in the queue so a test can `drop()`
 *   them to simulate a lost connection, or `deliver()` them one at a time to
 *   observe intermediate states. This is how reconnection and replay are proven
 *   in M2.1 without depending on real network flakiness.
 *
 * Closing either side discards everything still queued: a real socket does not
 * deliver frames that were in flight when the connection dropped.
 */

import type {
  RunnerSocket,
  RunnerSocketClose,
  RunnerSocketUnsubscribe
} from "./runner-socket.js";

/** One frame as it appeared on the wire, including frames that were later dropped. */
export interface WireFrame {
  from: "a" | "b";
  text: string;
}

export interface RunnerSocketPair {
  readonly a: RunnerSocket;
  readonly b: RunnerSocket;
  /** Delivers up to `count` queued frames (default: all) in FIFO order. */
  deliver(count?: number): void;
  /** Discards up to `count` queued frames without delivering them. */
  drop(count?: number): void;
  /** Frames sent but not yet delivered or dropped. */
  queued(): number;
  /** Every frame that entered the wire, in order — the ground truth for assertions. */
  wire(): ReadonlyArray<WireFrame>;
  /** True once either side has closed. */
  closed(): boolean;
}

export interface PairedRunnerSocketOptions {
  /**
   * When true (default), each `send` flushes the queue immediately.
   * Set false to drive delivery manually for fault injection.
   */
  autoDeliver?: boolean;
}

type Side = "a" | "b";

/** One endpoint's subscriber sets, shared with the pair so delivery can reach them. */
interface EndpointListeners {
  message: Set<(text: string) => void>;
  close: Set<(info: RunnerSocketClose) => void>;
}

export function createPairedRunnerSockets(
  options: PairedRunnerSocketOptions = {}
): RunnerSocketPair {
  const autoDeliver = options.autoDeliver ?? true;
  const queue: WireFrame[] = [];
  const wire: WireFrame[] = [];
  const listeners: Record<Side, EndpointListeners> = {
    a: { message: new Set(), close: new Set() },
    b: { message: new Set(), close: new Set() }
  };
  let closed = false;
  let flushing = false;

  const sockets: Record<Side, RunnerSocket> = {
    a: createEndpoint("a"),
    b: createEndpoint("b")
  };

  function peerOf(side: Side): Side {
    return side === "a" ? "b" : "a";
  }

  function createEndpoint(side: Side): RunnerSocket {
    return {
      send(text: string): void {
        if (closed) {
          return;
        }
        wire.push({ from: side, text });
        queue.push({ from: side, text });
        if (autoDeliver) {
          flush();
        }
      },

      close(code: number, reason = ""): void {
        if (closed) {
          return;
        }
        closePair(code, reason);
      },

      onMessage(listener: (text: string) => void): RunnerSocketUnsubscribe {
        listeners[side].message.add(listener);
        return () => listeners[side].message.delete(listener);
      },

      onClose(listener: (info: RunnerSocketClose) => void): RunnerSocketUnsubscribe {
        listeners[side].close.add(listener);
        return () => listeners[side].close.delete(listener);
      }
    };
  }

  /**
   * Drains the queue iteratively, never recursively.
   *
   * A listener that responds by calling `send` would otherwise re-enter this
   * function and grow the stack once per exchange, so a long request/response
   * conversation could overflow it. The `flushing` guard makes nested calls
   * enqueue only: the outermost loop keeps draining, so ordering stays FIFO and
   * the conversation resolves within a single stack frame.
   *
   * Consequence worth knowing in tests: `deliver()` called from inside a
   * listener is ignored, because the outer drain already covers it.
   */
  function flush(limit = Number.POSITIVE_INFINITY): void {
    if (flushing) {
      return;
    }
    flushing = true;
    try {
      let delivered = 0;
      while (queue.length > 0 && delivered < limit) {
        const frame = queue.shift()!;
        delivered += 1;
        if (closed) {
          return;
        }
        const target = listeners[peerOf(frame.from)];
        // Snapshot: a listener may unsubscribe itself or another during delivery.
        for (const listener of [...target.message]) {
          listener(frame.text);
        }
      }
    } finally {
      flushing = false;
    }
  }

  function closePair(code: number, reason: string): void {
    closed = true;
    queue.length = 0;
    const info: RunnerSocketClose = { code, reason };
    for (const side of ["a", "b"] as const) {
      for (const listener of [...listeners[side].close]) {
        listener(info);
      }
    }
  }

  return {
    a: sockets.a,
    b: sockets.b,
    deliver(count?: number): void {
      flush(count ?? Number.POSITIVE_INFINITY);
    },
    drop(count?: number): void {
      queue.splice(0, Math.max(0, count ?? queue.length));
    },
    queued(): number {
      return queue.length;
    },
    wire(): ReadonlyArray<WireFrame> {
      return [...wire];
    },
    closed(): boolean {
      return closed;
    }
  };
}
