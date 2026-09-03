import type { RunEventV1 } from "@lecoding/contracts";
import type { RunEventSource } from "@lecoding/run-controller";
import type { LeCodingBridge } from "./bridge.js";

/**
 * Adapts the main process' `runs.event` push channel to the shared console's
 * `RunEventSource` port.
 *
 * The Renderer never opens the SSE connection itself: its CSP forbids outbound
 * traffic and it holds no credential. The main process follows the durable
 * stream and relays every event, so this adapter is a queue the controller
 * drains through the same follower used by the Web page.
 *
 * The iteration ends when main reports `reconnecting`, `closed`, or `failed`.
 * Returning control to the follower is what makes the controller refresh the
 * Run and surface the right stream phase instead of showing a stale "live".
 *
 * Reconnect note: `subscribe` only attaches a listener. Re-subscribing after a
 * disconnect costs no IPC round trip and never disturbs main's subscription,
 * so the controller's retry policy stays harmless across the bridge.
 */
export function createIpcRunEventSource(
  bridge: LeCodingBridge
): RunEventSource {
  return {
    subscribe(runId, options) {
      const queue: RunEventV1[] = [];
      let notify: (() => void) | undefined;
      let ended = false;
      let endedError: Error | undefined;

      const stopEvent = bridge.onRunEvent((push) => {
        if (push.runId !== runId) {
          return;
        }
        queue.push(push.event);
        notify?.();
      });

      // Main owns the network, so its lifecycle reports are authoritative.
      const stopState = bridge.onStreamState((push) => {
        if (push.runId !== runId) {
          return;
        }
        if (
          push.phase === "reconnecting" ||
          push.phase === "closed" ||
          push.phase === "failed"
        ) {
          ended = true;
          endedError =
            push.phase === "failed"
              ? new Error("main process lost the Run event stream")
              : undefined;
          notify?.();
        }
      });

      function finish(): void {
        stopEvent();
        stopState();
      }

      options.signal.addEventListener("abort", () => {
        ended = true;
        notify?.();
      }, { once: true });

      return {
        async *[Symbol.asyncIterator]() {
          try {
            while (!options.signal.aborted) {
              if (queue.length > 0) {
                yield queue.shift()!;
                continue;
              }
              if (ended) {
                if (endedError) {
                  throw endedError;
                }
                return;
              }
              await new Promise<void>((resolve) => {
                notify = resolve;
              });
              notify = undefined;
            }
          } finally {
            finish();
          }
        }
      };
    }
  };
}
