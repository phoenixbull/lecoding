import type { RunEventV1, RunId } from "@lecoding/contracts";
import type { RunEventDeliveryTarget } from "./dispatcher.js";
import type { RunEventJournal } from "./index.js";
import { encodeRunEventSse, parseRunEventCursor } from "./sse-codec.js";

/** Listener invoked for one live event after durable outbox delivery. */
export type RunEventListener = (event: RunEventV1) => void | Promise<void>;

/** In-process fan-out seam shared by the outbox dispatcher and SSE handlers. */
export interface RunEventLiveBroadcaster extends RunEventDeliveryTarget {
  subscribe(runId: RunId, listener: RunEventListener): () => void;
}

/** Creates a stateless broadcaster; durable replay remains the journal's responsibility. */
export function createRunEventLiveBroadcaster(): RunEventLiveBroadcaster {
  return new InMemoryRunEventLiveBroadcaster();
}

class InMemoryRunEventLiveBroadcaster implements RunEventLiveBroadcaster {
  private readonly listenersByRun = new Map<RunId, Set<RunEventListener>>();

  subscribe(runId: RunId, listener: RunEventListener): () => void {
    const listeners = this.listenersByRun.get(runId) ?? new Set();
    listeners.add(listener);
    this.listenersByRun.set(runId, listeners);

    // Returning cleanup keeps transport lifecycle ownership with the subscriber.
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listenersByRun.delete(runId);
      }
    };
  }

  async deliver(event: RunEventV1): Promise<void> {
    const listeners = this.listenersByRun.get(event.runId) ?? [];
    // Preserve registration order so a single dispatcher yields ordered clients.
    for (const listener of listeners) {
      await listener(event);
    }
  }
}

/** Web-standard handler interface usable by Node HTTP adapters and edge runtimes. */
export interface RunEventSseHandler {
  handle(request: Request, runId: RunId): Promise<Response>;
}

export interface RunEventSseHandlerOptions {
  journal: Pick<RunEventJournal, "resume">;
  broadcaster: RunEventLiveBroadcaster;
}

/** Creates a long-lived SSE handler with backlog/live race protection. */
export function createRunEventSseHandler(
  options: RunEventSseHandlerOptions
): RunEventSseHandler {
  return new DefaultRunEventSseHandler(options);
}

class DefaultRunEventSseHandler implements RunEventSseHandler {
  constructor(private readonly options: RunEventSseHandlerOptions) {}

  async handle(request: Request, runId: RunId): Promise<Response> {
    const lastEventId = request.headers.get("last-event-id") ?? undefined;
    // Validate before constructing a successful streaming response.
    const initialSequence = parseRunEventCursor(lastEventId);
    const encoder = new TextEncoder();
    let unsubscribe: () => void = () => {};
    let removeAbortListener: () => void = () => {};

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let backlogReady = false;
        let lastSentSequence = initialSequence;
        const pendingLive: RunEventV1[] = [];

        const sendLive = (event: RunEventV1): void => {
          // Outbox delivery is at-least-once, so sequence is the deduplication key.
          if (event.sequence <= lastSentSequence) {
            return;
          }
          controller.enqueue(encoder.encode(encodeRunEventSse(event)));
          lastSentSequence = event.sequence;
        };

        /*
         * Subscribe before loading backlog. Events arriving during the database
         * query are buffered, then sorted and deduplicated after backlog replay.
         */
        unsubscribe = this.options.broadcaster.subscribe(runId, (event) => {
          if (!backlogReady) {
            pendingLive.push(event);
            return;
          }
          sendLive(event);
        });

        const abort = (): void => {
          unsubscribe();
          controller.close();
        };
        request.signal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => request.signal.removeEventListener("abort", abort);

        void this.options.journal
          .resume(runId, lastEventId)
          .then((backlog) => {
            if (backlog !== "") {
              controller.enqueue(encoder.encode(backlog));
              lastSentSequence = Math.max(
                lastSentSequence,
                highestSequenceInSse(backlog)
              );
            }
            backlogReady = true;
            pendingLive
              .sort((left, right) => left.sequence - right.sequence)
              .forEach(sendLive);
          })
          .catch((error: unknown) => {
            unsubscribe();
            removeAbortListener();
            controller.error(error);
          });
      },
      cancel: () => {
        unsubscribe();
        removeAbortListener();
      }
    });

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no"
      }
    });
  }
}

/** Extracts the final cursor from already validated frames produced by the journal. */
function highestSequenceInSse(stream: string): number {
  const sequences = [...stream.matchAll(/^id: (\d+)$/gm)].map((match) =>
    Number(match[1])
  );
  return sequences.length === 0 ? 0 : Math.max(...sequences);
}
