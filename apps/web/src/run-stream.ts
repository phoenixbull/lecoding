import type { LeCodingClient } from "@lecoding/client-sdk";
import type { RunEventV1, RunId } from "@lecoding/contracts";

/** Inputs for following one durable Run event stream across transport failures. */
export interface FollowRunEventStreamOptions {
  client: LeCodingClient;
  runId: RunId;
  signal: AbortSignal;
  /** Returning stop transfers terminal-state ownership back to the page. */
  onEvent(event: RunEventV1): "continue" | "stop" | Promise<"continue" | "stop">;
  onReconnect(
    error?: unknown
  ): void | "continue" | "stop" | Promise<void | "continue" | "stop">;
  /** Injectable delay keeps retry behavior deterministic in tests. */
  waitBeforeReconnect?: (signal: AbortSignal) => Promise<void>;
}

/**
 * Follows SSE until a caller-observed terminal state or cancellation.
 * The last accepted sequence becomes Last-Event-ID, and repeats are suppressed
 * because the server's outbox and reconnect boundary both provide at-least-once delivery.
 */
export async function followRunEventStream(
  options: FollowRunEventStreamOptions
): Promise<void> {
  let lastSequence = 0;
  const waitBeforeReconnect = options.waitBeforeReconnect ?? waitOneSecond;

  while (!options.signal.aborted) {
    let disconnectError: unknown;
    try {
      for await (const event of options.client.subscribeRunEvents(options.runId, {
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
