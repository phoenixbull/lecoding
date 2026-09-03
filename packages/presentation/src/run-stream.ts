import type { RunEventV1, RunId } from "@lecoding/contracts";

/**
 * Port through which a caller supplies the durable event history of one Run.
 *
 * Two adapters exist and both must satisfy this contract:
 *   - Web: `@lecoding/client-sdk`'s `subscribeRunEvents` over HTTP/SSE.
 *   - Desktop: a queue fed by the main process' `runs.event` IPC push.
 *
 * Caller obligations for an adapter:
 *   - Emit events in ascending `sequence` order. Duplicates are tolerated
 *     (the follower suppresses them) but out-of-order delivery is not.
 *   - When `lastEventId` is supplied, resume strictly after that sequence so
 *     a reconnect never replays an already-applied event.
 *   - Stop iterating promptly once `signal` aborts; the follower checks the
 *     abort flag between iterations, not between events.
 */
export interface RunEventSource {
  subscribe(
    runId: RunId,
    options: { lastEventId?: string; signal: AbortSignal }
  ): AsyncIterable<RunEventV1>;
}

/** Inputs for following one durable Run event stream across transport failures. */
export interface FollowRunEventStreamOptions {
  source: RunEventSource;
  runId: RunId;
  signal: AbortSignal;
  /** Returning stop transfers terminal-state ownership back to the caller. */
  onEvent(event: RunEventV1): "continue" | "stop" | Promise<"continue" | "stop">;
  onReconnect(
    error?: unknown
  ): void | "continue" | "stop" | Promise<void | "continue" | "stop">;
  /** Injectable delay keeps retry behavior deterministic in tests. */
  waitBeforeReconnect?: (signal: AbortSignal) => Promise<void>;
}

/**
 * Follows a Run event stream until a caller-observed terminal state or
 * cancellation. The last accepted sequence becomes Last-Event-ID, and repeats
 * are suppressed because both the server outbox and the IPC push boundary
 * provide at-least-once delivery.
 */
export async function followRunEventStream(
  options: FollowRunEventStreamOptions
): Promise<void> {
  let lastSequence = 0;
  const waitBeforeReconnect = options.waitBeforeReconnect ?? waitOneSecond;

  while (!options.signal.aborted) {
    let disconnectError: unknown;
    try {
      for await (const event of options.source.subscribe(options.runId, {
        ...(lastSequence > 0 ? { lastEventId: String(lastSequence) } : {}),
        signal: options.signal
      })) {
        if (event.sequence <= lastSequence) {
          continue;
        }
        lastSequence = event.sequence;
        if ((await options.onEvent(event)) === "stop") {
          return;
        }
      }
    } catch (error) {
      disconnectError = error;
    }
    if (options.signal.aborted) {
      return;
    }
    if ((await options.onReconnect(disconnectError)) === "stop") {
      return;
    }
    if (options.signal.aborted) {
      return;
    }
    await waitBeforeReconnect(options.signal);
  }
}

function waitOneSecond(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(finish, 1_000);
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
