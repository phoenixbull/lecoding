import type { LeCodingClient } from "@lecoding/client-sdk";
import type { RunEventSource } from "@lecoding/run-controller";

/**
 * Adapts the client SDK's fetch-based SSE subscription to the shared console's
 * `RunEventSource` port.
 *
 * The SDK owns the SSE framing and the `Last-Event-ID` header; the controller
 * owns the cursor, de-duplication, and retry policy. Keeping that split means
 * the Web page and the Electron Renderer cannot drift on reconnect semantics.
 */
export function createSdkRunEventSource(
  getClient: () => LeCodingClient
): RunEventSource {
  return {
    subscribe(runId, options) {
      return getClient().subscribeRunEvents(runId, {
        ...(options.lastEventId !== undefined
          ? { lastEventId: options.lastEventId }
          : {}),
        signal: options.signal
      });
    }
  };
}
