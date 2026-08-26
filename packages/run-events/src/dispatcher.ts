import type { RunEventV1 } from "@lecoding/contracts";
import type { RunEventOutbox } from "./postgres.js";

/** Delivery target implemented by a live SSE broadcaster or another transport. */
export interface RunEventDeliveryTarget {
  deliver(event: RunEventV1): Promise<void>;
}

/** Observable result used by worker scheduling and operational metrics. */
export interface RunEventDispatchReport {
  delivered: number;
}

/** Small worker interface that can be driven by pg-boss or a process loop. */
export interface RunEventDispatcher {
  dispatchOnce(): Promise<RunEventDispatchReport>;
}

/** Idempotent lifecycle for continuously draining the durable event outbox. */
export interface RunEventDispatchWorker {
  start(): void;
  stop(): Promise<void>;
}

/** Inputs for the single-process Phase 1 outbox polling loop. */
export interface IntervalRunEventDispatchWorkerOptions {
  dispatcher: RunEventDispatcher;
  intervalMs: number;
  onError?: (error: unknown) => void;
}

/**
 * Polls immediately and then at a fixed interval without overlapping claims.
 * pg-boss can replace this lifecycle later without changing dispatcher semantics.
 */
export function createIntervalRunEventDispatchWorker(
  options: IntervalRunEventDispatchWorkerOptions
): RunEventDispatchWorker {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
    throw new Error("Event dispatch interval must be a positive integer");
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = true;

  const dispatch = (): void => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = options.dispatcher
      .dispatchOnce()
      .then(() => undefined)
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        inFlight = undefined;
      });
  };

  return {
    start() {
      if (!stopped) {
        return;
      }
      stopped = false;
      dispatch();
      timer = setInterval(dispatch, options.intervalMs);
    },
    async stop() {
      if (stopped) {
        await inFlight;
        return;
      }
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      await inFlight;
    }
  };
}

export interface RunEventDispatcherOptions {
  outbox: RunEventOutbox;
  target: RunEventDeliveryTarget;
  workerId: string;
  batchSize: number;
  leaseMilliseconds: number;
  /** Injected clock keeps lease and acknowledgement timestamps deterministic. */
  now(): string;
}

/** Creates an at-least-once dispatcher over the durable outbox seam. */
export function createRunEventDispatcher(
  options: RunEventDispatcherOptions
): RunEventDispatcher {
  if (
    !Number.isSafeInteger(options.leaseMilliseconds) ||
    options.leaseMilliseconds < 1
  ) {
    throw new Error("Dispatcher leaseMilliseconds must be a positive integer");
  }
  return new DefaultRunEventDispatcher(options);
}

class DefaultRunEventDispatcher implements RunEventDispatcher {
  constructor(private readonly options: RunEventDispatcherOptions) {}

  async dispatchOnce(): Promise<RunEventDispatchReport> {
    const now = this.options.now();
    const nowMilliseconds = Date.parse(now);
    if (
      !Number.isFinite(nowMilliseconds) ||
      new Date(nowMilliseconds).toISOString() !== now
    ) {
      throw new Error("Dispatcher clock must return a canonical UTC timestamp");
    }
    const leaseUntil = new Date(
      nowMilliseconds + this.options.leaseMilliseconds
    ).toISOString();
    const claims = await this.options.outbox.claim({
      workerId: this.options.workerId,
      limit: this.options.batchSize,
      now,
      leaseUntil
    });

    /*
     * ACK is intentionally deferred until the complete batch is delivered.
     * A partial failure may redeliver earlier events, which is the documented
     * at-least-once tradeoff; downstream live broadcasters must deduplicate by
     * the stable (runId, sequence) event identity.
     */
    for (const claim of claims) {
      await this.options.target.deliver(claim.event);
    }
    await this.options.outbox.ack({
      workerId: this.options.workerId,
      claimIds: claims.map((claim) => claim.id),
      deliveredAt: now
    });
    return { delivered: claims.length };
  }
}
