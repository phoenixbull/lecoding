import type { RunId } from "@lecoding/contracts";
import { followRunEventStream, isTerminalRunEvent } from "@lecoding/presentation";
import type {
  PushChannel,
  RunEventPush,
  StreamStatePush
} from "../shared/ipc-contract.js";
import type { ClientSdk, ElectronBrowserWindowInstance } from "./host.js";

export interface RunStreamBroker {
  /** Starts (or is a no-op for an already-followed) the stream for one Run. */
  subscribe(runId: RunId): void;
  unsubscribe(runId: RunId): void;
  /** Run ids currently being followed. */
  activeRunIds(): RunId[];
  dispose(): void;
}

export interface RunStreamBrokerOptions {
  /** Resolved lazily: the window may be replaced or closed between calls. */
  getWindow: () => ElectronBrowserWindowInstance | undefined;
  getSdk: () => ClientSdk;
  /** Injectable delay keeps reconnect behaviour deterministic in tests. */
  waitBeforeReconnect?: (signal: AbortSignal) => Promise<void>;
}

/**
 * Owns the main-process side of the durable Run event stream.
 *
 * The Renderer cannot open the SSE connection itself: its CSP forbids outbound
 * traffic and it never holds the device credential. So the broker follows the
 * stream using the shared `followRunEventStream` — which keeps one definition
 * of cursor resumption, de-duplication, and retry — and relays each event over
 * a whitelisted push channel.
 *
 * Only one subscription per Run exists at a time; a second `subscribe` for the
 * same id is a no-op so a re-entering Renderer cannot double the traffic.
 */
export function createRunStreamBroker(
  options: RunStreamBrokerOptions
): RunStreamBroker {
  const { getWindow, getSdk } = options;
  const active = new Map<RunId, AbortController>();

  function push(
    channel: PushChannel,
    payload: RunEventPush | StreamStatePush
  ): void {
    const window = getWindow();
    if (!window) {
      return;
    }
    window.webContents.send(channel, payload);
  }

  function subscribe(runId: RunId): void {
    if (active.has(runId)) {
      return;
    }
    const controller = new AbortController();
    active.set(runId, controller);
    push("runs.streamState", { runId, phase: "connecting" });

    void followRunEventStream({
      source: {
        subscribe: (id, streamOptions) => getSdk().subscribeRunEvents(id, streamOptions)
      },
      runId,
      signal: controller.signal,
      onEvent(event) {
        push("runs.event", { runId, event });
        push("runs.streamState", { runId, phase: "live" });
        // A terminal event means the durable history is complete; releasing
        // the slot here stops the broker from reconnecting forever.
        if (isTerminalRunEvent(event)) {
          push("runs.streamState", { runId, phase: "closed" });
          active.delete(runId);
          return "stop";
        }
        return "continue";
      },
      onReconnect() {
        push("runs.streamState", { runId, phase: "reconnecting" });
        return "continue";
      },
      ...(options.waitBeforeReconnect
        ? { waitBeforeReconnect: options.waitBeforeReconnect }
        : {})
    }).catch(() => {
      // Only report a failure for the subscription that is still current;
      // a superseded one is silently discarded.
      if (active.get(runId) === controller) {
        push("runs.streamState", { runId, phase: "failed" });
      }
    });
  }

  function unsubscribe(runId: RunId): void {
    const controller = active.get(runId);
    if (!controller) {
      return;
    }
    active.delete(runId);
    controller.abort();
  }

  return {
    subscribe,
    unsubscribe,
    activeRunIds() {
      return [...active.keys()];
    },
    dispose() {
      for (const controller of active.values()) {
        controller.abort();
      }
      active.clear();
    }
  };
}
