/**
 * The transport seam for the Runner protocol.
 *
 * Everything above this interface is pure protocol logic; everything below it
 * is a transport detail. There are exactly two adapters, which is what makes
 * the seam real rather than hypothetical:
 *
 * - `apps/worker/src/runner-ws-server.ts` and `apps/desktop/src/main/runner-ws-client.ts`
 *   wrap `ws` (M2.1 edge work).
 * - `createPairedRunnerSockets` here provides an in-memory pair so protocol
 *   behaviour is verified deterministically, without a network or a `ws` import.
 *
 * The interface is intentionally narrow: text frames plus close. Binary frames,
 * backpressure events, and per-frame errors are all deliberately absent —
 * transports must collapse their own error surfaces into `onClose`, because the
 * protocol's only recovery action for a broken transport is to reconnect.
 */

/** Why a socket stopped carrying frames. */
export interface RunnerSocketClose {
  code: number;
  reason: string;
}

/** Unsubscribes the listener it came from; calling it twice is a no-op. */
export type RunnerSocketUnsubscribe = () => void;

export interface RunnerSocket {
  /**
   * Sends one already-encoded text frame.
   *
   * Implementations must make this a no-op after close rather than throwing:
   * the protocol state machine routinely races its own teardown (a heartbeat
   * timer firing as the session closes) and must not have to guard every send.
   */
  send(text: string): void;

  /**
   * Closes the socket and notifies the peer.
   *
   * Idempotent. `code` should be a `RunnerCloseCode` when the close originates
   * from the protocol, but the transport may substitute its own (1006 for an
   * abnormal drop), so receivers must tolerate any number.
   */
  close(code: number, reason?: string): void;

  /**
   * Subscribes to inbound frames.
   *
   * The listener is invoked for frames that arrived after subscription only.
   * Malformed or oversized frames are still delivered — rejecting them is the
   * codec's job, not the transport's.
   */
  onMessage(listener: (text: string) => void): RunnerSocketUnsubscribe;

  /** Subscribes to close, however it was caused. Also fires for a peer-initiated close. */
  onClose(listener: (info: RunnerSocketClose) => void): RunnerSocketUnsubscribe;
}
