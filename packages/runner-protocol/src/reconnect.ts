/**
 * Reconnection policy and liveness tracking.
 *
 * Both are pure and clock-injected so recovery behaviour is proven with a
 * virtual clock instead of real time — a test that sleeps for 30 seconds is a
 * test nobody runs.
 *
 * Jitter is not optional decoration. Without it, every Runner that loses a
 * connection at the same instant retries in lockstep and re-DDoSes a server
 * that just came back; that thundering herd is the failure this prevents.
 */

export interface BackoffOptions {
  /** Delay before the first retry. Default 500 ms. */
  baseDelayMs?: number;
  /** Upper bound on any delay. Default 30 s. */
  maxDelayMs?: number;
  /** Growth factor per attempt. Default 2. */
  factor?: number;
  /**
   * Fraction of the computed delay used as the jitter band, applied
   * symmetrically (delay x [1 - jitter, 1 + jitter]). Set 0 for determinism.
   * Default 0.2.
   */
  jitter?: number;
  /** Injectable source in [0, 1); defaults to `Math.random`. */
  random?: () => number;
}

export interface Backoff {
  /**
   * Milliseconds to wait before retry `attempt`, where 0 is the first retry.
   *
   * Negative attempts are clamped to 0 so a caller that miscounts cannot
   * produce a delay shorter than the base.
   */
  delayFor(attempt: number): number;
}

/**
 * Guards against `Math.pow` overflowing to Infinity at absurd attempt counts,
 * which would make every subsequent delay NaN. 2^64 milliseconds is already
 * longer than any process will run.
 */
const MAX_BACKOFF_EXPONENT = 64;

export function createBackoff(options: BackoffOptions = {}): Backoff {
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? 0.2;
  const random = options.random ?? Math.random;

  return {
    delayFor(attempt) {
      const safeAttempt = Math.max(0, Math.floor(attempt));
      const exponent = Math.min(safeAttempt, MAX_BACKOFF_EXPONENT);
      const raw = Math.min(maxDelayMs, baseDelayMs * factor ** exponent);
      const spread = raw * jitter;
      const jittered = raw + spread * (random() * 2 - 1);
      // Cap after jitter too, so the band can never escape maxDelayMs.
      const clamped = Math.min(maxDelayMs, Math.max(0, jittered));
      return Math.round(clamped);
    }
  };
}

export interface HeartbeatMonitorOptions {
  /** How often the session should send a heartbeat. Default 15 s. */
  heartbeatIntervalMs?: number;
  /**
   * Multiples of the interval after which silence means the peer is gone.
   * 2 tolerates exactly one missed heartbeat. Default 2.
   */
  timeoutFactor?: number;
  /** Injectable clock in milliseconds; defaults to `Date.now`. */
  now?: () => number;
}

export interface HeartbeatMonitor {
  /**
   * Records liveness. Call for **every** inbound frame, not just heartbeats:
   * a peer streaming results is demonstrably alive, and requiring heartbeat
   * frames specifically would add traffic that carries no extra signal.
   */
  noteActivity(): void;

  /** Milliseconds since the last inbound frame. */
  idleMs(): number;

  /** True when the peer has been silent past the timeout window. */
  isTimedOut(): boolean;

  /** Milliseconds until the session should send its next heartbeat; 0 when due. */
  msUntilNextHeartbeat(): number;

  /** Call immediately after sending a heartbeat. */
  noteHeartbeatSent(): void;
}

export function createHeartbeatMonitor(
  options: HeartbeatMonitorOptions = {}
): HeartbeatMonitor {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const timeoutFactor = options.timeoutFactor ?? 2;
  const now = options.now ?? Date.now;

  const startedAt = now();
  let lastActivityAt = startedAt;
  let lastHeartbeatSentAt = startedAt;

  return {
    noteActivity() {
      lastActivityAt = now();
    },

    idleMs() {
      return Math.max(0, now() - lastActivityAt);
    },

    isTimedOut() {
      return now() - lastActivityAt > heartbeatIntervalMs * timeoutFactor;
    },

    msUntilNextHeartbeat() {
      return Math.max(0, lastHeartbeatSentAt + heartbeatIntervalMs - now());
    },

    noteHeartbeatSent() {
      lastHeartbeatSentAt = now();
    }
  };
}
