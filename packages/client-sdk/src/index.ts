import type { RunId, RunView } from "@lecoding/contracts";

/** Shared Web/PC client interface for versioned Run operations. */
export interface LeCodingClient {
  inspectRun(runId: RunId): Promise<RunView>;
  openRunEventStream(
    runId: RunId,
    options?: OpenRunEventStreamOptions
  ): Promise<ReadableStream<Uint8Array>>;
}

/** Cursor and cancellation inputs used when reconnecting an SSE stream. */
export interface OpenRunEventStreamOptions {
  lastEventId?: string;
  signal?: AbortSignal;
}

export interface ClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

/** Creates one transport adapter shared by browser, Electron, and Local Runner clients. */
export function createClient(options: ClientOptions): LeCodingClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  return {
    async inspectRun(runId: RunId): Promise<RunView> {
      const response = await fetchImplementation(
        `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}`,
        {
          method: "GET",
          headers: { accept: "application/json" }
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to inspect Run: HTTP ${response.status}`);
      }

      return (await response.json()) as RunView;
    },

    async openRunEventStream(
      runId: RunId,
      streamOptions: OpenRunEventStreamOptions = {}
    ): Promise<ReadableStream<Uint8Array>> {
      const headers = new Headers({ accept: "text/event-stream" });
      if (streamOptions.lastEventId !== undefined) {
        // Fetch-based SSE supports the resume header that browser EventSource cannot set.
        headers.set("last-event-id", streamOptions.lastEventId);
      }

      const response = await fetchImplementation(
        `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/events`,
        {
          method: "GET",
          headers,
          ...(streamOptions.signal ? { signal: streamOptions.signal } : {})
        }
      );
      if (!response.ok) {
        throw new Error(`Failed to open Run event stream: HTTP ${response.status}`);
      }
      if (!response.body) {
        throw new Error("Run event stream response has no body");
      }
      return response.body;
    }
  };
}
