import {
  parseRunEvent,
  type CreateRunInput,
  type CreateRunResult,
  type ControlPlaneConfig,
  type ProjectId,
  type RunEventV1,
  type RunChanges,
  type RunHistoryResult,
  type RunId,
  type RunView
} from "@lecoding/contracts";

/** Shared Web/PC client interface for versioned Run operations. */
export interface LeCodingClient {
  getControlPlaneConfig(): Promise<ControlPlaneConfig>;
  createRun(projectId: ProjectId, input: CreateRunInput): Promise<CreateRunResult>;
  inspectRun(runId: RunId): Promise<RunView>;
  listRuns(projectId: ProjectId, limit?: number): Promise<RunHistoryResult>;
  getRunChanges(runId: RunId): Promise<RunChanges>;
  cancelRun(runId: RunId): Promise<void>;
  approveRun(runId: RunId, approvalId: string): Promise<void>;
  rejectRun(runId: RunId, approvalId: string): Promise<void>;
  answerRun(
    runId: RunId,
    requestId: string,
    value: string,
    commandId?: string
  ): Promise<void>;
  steerRun(runId: RunId, message: string, commandId?: string): Promise<void>;
  openRunEventStream(
    runId: RunId,
    options?: OpenRunEventStreamOptions
  ): Promise<ReadableStream<Uint8Array>>;
  /** Decodes and validates fragmented SSE frames from the resumable event endpoint. */
  subscribeRunEvents(
    runId: RunId,
    options?: OpenRunEventStreamOptions
  ): AsyncIterable<RunEventV1>;
}

/** Cursor and cancellation inputs used when reconnecting an SSE stream. */
export interface OpenRunEventStreamOptions {
  lastEventId?: string;
  signal?: AbortSignal;
}

export interface ClientOptions {
  baseUrl: string;
  /** Optional single-user bearer token; it is sent only in the Authorization header. */
  accessToken?: string;
  fetch?: typeof globalThis.fetch;
}

/** Stable transport failure that lets UI clients distinguish authentication. */
export class LeCodingHttpError extends Error {
  constructor(
    operation: string,
    readonly status: number
  ) {
    super(`${operation}: HTTP ${status}`);
    this.name = "LeCodingHttpError";
  }
}

/** Creates one transport adapter shared by browser, Electron, and Local Runner clients. */
export function createClient(options: ClientOptions): LeCodingClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const authenticatedFetch: typeof globalThis.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (options.accessToken) {
      headers.set("authorization", `Bearer ${options.accessToken}`);
    }
    return fetchImplementation(input, { ...init, headers });
  };

  const openRunEventStream = async (
    runId: RunId,
    streamOptions: OpenRunEventStreamOptions = {}
  ): Promise<ReadableStream<Uint8Array>> => {
    const headers = new Headers({ accept: "text/event-stream" });
    if (streamOptions.lastEventId !== undefined) {
      // Fetch-based SSE supports the resume header that browser EventSource cannot set.
      headers.set("last-event-id", streamOptions.lastEventId);
    }

    const response = await authenticatedFetch(
      `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/events`,
      {
        method: "GET",
        headers,
        ...(streamOptions.signal ? { signal: streamOptions.signal } : {})
      }
    );
    if (!response.ok) {
      throw new LeCodingHttpError("Failed to open Run event stream", response.status);
    }
    if (!response.body) {
      throw new Error("Run event stream response has no body");
    }
    return response.body;
  };

  const sendRunCommand = async (runId: RunId, command: object): Promise<void> => {
    const response = await authenticatedFetch(
      `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/commands`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify(command)
      }
    );
    if (!response.ok) {
      throw new LeCodingHttpError("Failed to command Run", response.status);
    }
  };

  return {
    async getControlPlaneConfig(): Promise<ControlPlaneConfig> {
      const response = await authenticatedFetch(`${baseUrl}/api/v1/config`, {
        method: "GET",
        headers: { accept: "application/json" }
      });
      if (!response.ok) {
        throw new LeCodingHttpError("Failed to load control plane", response.status);
      }
      return (await response.json()) as ControlPlaneConfig;
    },

    async createRun(
      projectId: ProjectId,
      input: CreateRunInput
    ): Promise<CreateRunResult> {
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/runs`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json"
          },
          body: JSON.stringify(input)
        }
      );
      if (!response.ok) {
        throw new LeCodingHttpError("Failed to create Run", response.status);
      }
      return (await response.json()) as CreateRunResult;
    },

    async inspectRun(runId: RunId): Promise<RunView> {
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}`,
        {
          method: "GET",
          headers: { accept: "application/json" }
        }
      );

      if (!response.ok) {
        throw new LeCodingHttpError("Failed to inspect Run", response.status);
      }

      return (await response.json()) as RunView;
    },

    async listRuns(projectId: ProjectId, limit = 20): Promise<RunHistoryResult> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new Error("Run history limit must be an integer from 1 to 50");
      }
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/runs?limit=${limit}`,
        { method: "GET", headers: { accept: "application/json" } }
      );
      if (!response.ok) {
        throw new LeCodingHttpError("Failed to list Runs", response.status);
      }
      return (await response.json()) as RunHistoryResult;
    },

    async getRunChanges(runId: RunId): Promise<RunChanges> {
      const response = await authenticatedFetch(
        `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/changes`,
        { method: "GET", headers: { accept: "application/json" } }
      );
      if (!response.ok) {
        throw new LeCodingHttpError("Failed to load Run changes", response.status);
      }
      return (await response.json()) as RunChanges;
    },

    async cancelRun(runId: RunId): Promise<void> {
      await sendRunCommand(runId, { type: "cancel" });
    },

    async approveRun(runId: RunId, approvalId: string): Promise<void> {
      // The minimum UI deliberately grants only the displayed call, never the whole Run.
      await sendRunCommand(runId, { type: "approve", approvalId, scope: "once" });
    },

    async rejectRun(runId: RunId, approvalId: string): Promise<void> {
      await sendRunCommand(runId, { type: "reject", approvalId, scope: "once" });
    },

    async answerRun(
      runId: RunId,
      requestId: string,
      value: string,
      commandId?: string
    ): Promise<void> {
      await sendRunCommand(runId, {
        type: "answer",
        commandId: commandId ?? globalThis.crypto.randomUUID(),
        requestId,
        value
      });
    },

    async steerRun(runId: RunId, message: string, commandId?: string): Promise<void> {
      await sendRunCommand(runId, {
        type: "steer",
        commandId: commandId ?? globalThis.crypto.randomUUID(),
        message
      });
    },

    openRunEventStream,

    async *subscribeRunEvents(runId, streamOptions = {}) {
      const stream = await openRunEventStream(runId, streamOptions);
      for await (const event of decodeRunEventStream(stream, runId)) {
        yield event;
      }
    }
  };
}

/** Parses strict server-produced SSE frames across arbitrary transport chunks. */
async function* decodeRunEventStream(
  stream: ReadableStream<Uint8Array>,
  expectedRunId: RunId
): AsyncGenerator<RunEventV1> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame !== "" && !frame.startsWith(":")) {
          yield parseRunEventFrame(frame, expectedRunId);
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (done) {
        if (buffer.trim() !== "") {
          throw new Error("Run event stream ended with an incomplete SSE frame");
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseRunEventFrame(frame: string, expectedRunId: RunId): RunEventV1 {
  const fields = new Map<string, string>();
  for (const line of frame.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) {
      throw new Error("Invalid Run event SSE frame");
    }
    fields.set(line.slice(0, separator), line.slice(separator + 1).trimStart());
  }
  const data = fields.get("data");
  if (!data) {
    throw new Error("Run event SSE frame has no data");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(data);
  } catch {
    throw new Error("Run event SSE frame contains invalid JSON");
  }
  const event = parseRunEvent(decoded);
  if (
    event.runId !== expectedRunId ||
    fields.get("id") !== String(event.sequence) ||
    fields.get("event") !== event.type
  ) {
    throw new Error("Run event SSE metadata does not match its envelope");
  }
  return event;
}
