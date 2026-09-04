/**
 * Main-process Runner session broker.
 *
 * The desktop Main process owns the Runner session for the same reason it owns
 * the SSE stream: the Renderer is sandboxed with `connect-src 'self'` and never
 * holds the device credential, so it must not hold a socket either.
 *
 * The broker's job is the lifecycle *around* the session:
 *
 * - Reconnect with bounded exponential backoff plus jitter.
 * - **Stop** when the close code says the credential is dead. Retrying a revoked
 *   device forever is the failure this exists to prevent; the user has to
 *   rebind, and no amount of reconnecting changes that.
 * - Report state upward so the Renderer can show "connecting / live /
 *   reconnecting" without ever touching the transport.
 *
 * The `RunnerSession` is created once and re-connected, so its dedupe table and
 * replay window survive a dropped socket. That is what makes resume real.
 */

import type { RunnerCommandOutcome } from "@lecoding/runner-protocol";
import {
  createBackoff,
  createRunnerSession,
  type Backoff,
  type BackoffOptions,
  type RunnerCapabilities,
  type RunnerEnvironmentHandlers,
  type RunnerSession,
  type RunnerSocket,
  type RunnerWelcomeInfo
} from "@lecoding/runner-protocol";

export type RunnerBrokerState =
  /** Not connected; there is no usable device credential. */
  | "idle"
  /** Connected but the server has not yet accepted `hello`. */
  | "connecting"
  /** Authenticated and serving commands. */
  | "live"
  /** Transport lost; waiting to retry. */
  | "reconnecting"
  /** Permanently stopped: either the user quit or the device was revoked. */
  | "stopped";

/**
 * Close codes that must not be retried.
 *
 * 4001 is a revoked or expired device and 4004 means another session for this
 * device took over. Both need a human action, so reconnecting would only spin.
 */
const TERMINAL_CLOSE_CODES = new Set([4001, 4004]);

export interface RunnerBrokerOptions {
  /** Opens one transport. Called again for every reconnect attempt. */
  connect(): RunnerSocket;
  /** Current device access token, or undefined when the client is not bound. */
  credential(): Promise<string | undefined>;
  capabilities: RunnerCapabilities;
  handlers: RunnerEnvironmentHandlers;
  /**
   * Highest command id already accepted, restored from the durable journal so a
   * relaunched client resumes rather than replaying a whole Run.
   */
  lastReceivedCommandId?(): number;
  /**
   * Supplies command outcomes restored from the durable journal, so the
   * session's dedupe table starts knowing what this device already did.
   *
   * Caller obligation: call this once, from recovery, before the first
   * `connect`. Interrupted commands must arrive as `command_interrupted`
   * failures — their effect cannot be known, so re-running them risks
   * repeating a side effect whose result was never observed.
   */
  recoveredCommands?(
    entries: Array<{ id: number; outcome: RunnerCommandOutcome }>
  ): void;
  onStateChange?(state: RunnerBrokerState): void;
  onWelcome?(info: RunnerWelcomeInfo): void;
  backoff?: Backoff;
  backoffOptions?: BackoffOptions;
  /**
   * Schedules a reconnect attempt and returns a cancel function.
   *
   * Injected so tests drive reconnection deterministically instead of sleeping.
   */
  schedule?(delayMs: number, run: () => void): () => void;
  /** Called after each attempt so tests can observe the backoff sequence. */
  onRetryScheduled?(delayMs: number, attempt: number): void;
}

export interface RunnerBroker {
  /** Connects if a credential exists; otherwise reports `idle`. */
  start(): Promise<void>;
  /** Closes the session and cancels any pending retry. */
  stop(): void;
  state(): RunnerBrokerState;
  /** The underlying session, for emitting audit events and diagnostics. */
  session(): RunnerSession | undefined;
}

export function createRunnerBroker(options: RunnerBrokerOptions): RunnerBroker {
  const backoff: Backoff = options.backoff ?? createBackoff(options.backoffOptions);
  const schedule: NonNullable<RunnerBrokerOptions["schedule"]> =
    options.schedule ??
    ((delayMs, run) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    });

  let state: RunnerBrokerState = "idle";
  let session: RunnerSession | undefined;
  let cancelRetry: (() => void) | undefined;
  let attempt = 0;
  let stopped = false;

  function setState(next: RunnerBrokerState): void {
    if (state === next) {
      return;
    }
    state = next;
    options.onStateChange?.(next);
  }

  function openConnection(): void {
    if (stopped || !session) {
      return;
    }
    setState(attempt === 0 ? "connecting" : "reconnecting");
    session.connect(options.connect());
  }

  function scheduleRetry(): void {
    if (stopped) {
      return;
    }
    const delayMs = backoff.delayFor(attempt);
    attempt += 1;
    options.onRetryScheduled?.(delayMs, attempt);
    cancelRetry = schedule(delayMs, () => {
      cancelRetry = undefined;
      openConnection();
    });
  }

  return {
    async start() {
      if (stopped || session) {
        return;
      }
      const token = await options.credential();
      if (stopped) {
        return;
      }
      if (!token) {
        // No bound device: stay idle rather than retrying a credential that
        // does not exist yet.
        setState("idle");
        return;
      }

      session = createRunnerSession({
        deviceAccessToken: token,
        capabilities: options.capabilities,
        handlers: options.handlers,
        ...(options.lastReceivedCommandId
          ? { lastReceivedCommandId: options.lastReceivedCommandId() }
          : {}),
        ...(options.recoveredCommands
          ? { seedCommands: (entries) => options.recoveredCommands!(entries) }
          : {}),
        onWelcome(info) {
          // A successful exchange resets the backoff, so a brief network blip
          // does not leave the client on a 30-second retry schedule.
          attempt = 0;
          setState("live");
          options.onWelcome?.(info);
        },
        onDisconnect(info) {
          if (stopped) {
            return;
          }
          if (TERMINAL_CLOSE_CODES.has(info.code)) {
            setState("stopped");
            return;
          }
          setState("reconnecting");
          scheduleRetry();
        }
      });

      openConnection();
    },

    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      cancelRetry?.();
      cancelRetry = undefined;
      session?.close(4000, "client shutting down");
      session = undefined;
      setState("stopped");
    },

    state() {
      return state;
    },

    session() {
      return session;
    }
  };
}
