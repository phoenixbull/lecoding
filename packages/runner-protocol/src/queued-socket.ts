/**
 * Transport adapter that queues frames sent before the peer is ready.
 *
 * WebSocket connections are not usable the instant they are constructed: a
 * client socket sits in CONNECTING until the handshake completes. Any frame
 * sent in that window is silently dropped by the transport, which for this
 * protocol means the `hello` frame — the one frame whose loss is unrecoverable,
 * because without it the Runner never authenticates.
 *
 * So the queue is not an optimisation, it is the reason the handshake works.
 * Both `ws` adapters (Worker server, desktop client) funnel through here so the
 * two ends cannot drift: one implementation, one set of rules.
 *
 * The queue is bounded. A session that queues without ever opening is a broken
 * peer, and buffering unboundedly would turn a dropped handshake into memory
 * growth. When the bound is hit the socket is closed, which surfaces as a
 * reconnect rather than a silent stall.
 */

import type {
  RunnerSocket,
  RunnerSocketClose,
  RunnerSocketUnsubscribe
} from "./runner-socket.js";

/** A duplex that reports when it can accept frames. */
export interface RawRunnerDuplex {
  send(text: string): void;
  close(code: number, reason?: string): void;
  onMessage(listener: (text: string) => void): RunnerSocketUnsubscribe;
  onClose(listener: (info: RunnerSocketClose) => void): RunnerSocketUnsubscribe;
  /**
   * Fires once frames may be sent. Must also fire, synchronously or not, if the
   * duplex is already open at subscription time — otherwise every frame would
   * queue forever behind an event that already happened.
   */
  onOpen(listener: () => void): RunnerSocketUnsubscribe;
}

export interface QueuedSocketOptions {
  /** Frames buffered before open; exceeding it closes the socket. Default 256. */
  maxQueuedFrames?: number;
}

export function createQueuedRunnerSocket(
  raw: RawRunnerDuplex,
  options: QueuedSocketOptions = {}
): RunnerSocket {
  const maxQueuedFrames = options.maxQueuedFrames ?? 256;

  let open = false;
  let finished = false;
  const queue: string[] = [];

  const offOpen = raw.onOpen(() => {
    if (finished) {
      return;
    }
    open = true;
    const pending = queue.splice(0, queue.length);
    for (const text of pending) {
      raw.send(text);
    }
  });

  const offClose = raw.onClose((info) => {
    if (finished) {
      return;
    }
    finished = true;
    // Anything still queued is undeliverable: the peer is gone.
    queue.length = 0;
    offOpen();
    offClose();
    void info;
  });

  return {
    send(text) {
      if (finished) {
        // Post-close sends are a no-op by contract: the protocol races its own
        // teardown and must not guard every call site.
        return;
      }
      if (open) {
        raw.send(text);
        return;
      }
      if (queue.length >= maxQueuedFrames) {
        // Refuse to grow without bound; closing surfaces as a reconnect.
        this.close(4002, "outbound queue overflowed before the socket opened");
        return;
      }
      queue.push(text);
    },

    close(code, reason) {
      if (finished) {
        return;
      }
      finished = true;
      queue.length = 0;
      offOpen();
      offClose();
      raw.close(code, reason);
    },

    onMessage(listener) {
      return raw.onMessage(listener);
    },

    onClose(listener) {
      return raw.onClose(listener);
    }
  };
}
