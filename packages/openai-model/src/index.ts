import type {
  AgentModel,
  AgentModelInput,
  AgentModelTurn
} from "@lecoding/run-engine";

/** Minimal Responses API request shape owned by the model gateway boundary. */
export interface OpenAiResponsesRequest {
  model: string;
  instructions: string;
  input: string | OpenAiFunctionCallOutput[];
  tools: OpenAiFunctionTool[];
  tool_choice: "auto";
  parallel_tool_calls: false;
  /** Phase 0 persists provider responses so a replacement Worker can continue by id. */
  store: true;
  previous_response_id?: string;
}

/** Tool result input used to continue a Responses API function call. */
export interface OpenAiFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

/** Strict command tool advertised to the model. */
export interface OpenAiFunctionTool {
  type: "function";
  name: "execute_command";
  description: string;
  strict: true;
  parameters: {
    type: "object";
    properties: {
      argv: { type: "array"; items: { type: "string" }; minItems: 1 };
    };
    required: ["argv"];
    additionalProperties: false;
  };
}

/** Injectable API client seam; the adapter validates its untrusted response. */
export interface OpenAiResponsesClient {
  create(request: OpenAiResponsesRequest): Promise<unknown>;
}

/** Narrow fetch input exposed for deterministic gateway contract tests. */
export interface OpenAiFetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

/** Minimal fetch response surface needed by the Responses client. */
export interface OpenAiFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Injectable HTTP seam; production defaults to the runtime's global fetch. */
export type OpenAiFetch = (
  url: string,
  init: OpenAiFetchInit
) => Promise<OpenAiFetchResponse>;

/** Credentials and endpoint configuration for the Responses HTTP client. */
export interface OpenAiResponsesClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: OpenAiFetch;
}

/** Construction inputs for the RunEngine-native Responses API adapter. */
export interface OpenAiResponsesAgentModelOptions {
  model: string;
  client: OpenAiResponsesClient;
  instructions?: string;
}

const EXECUTE_COMMAND_TOOL: OpenAiFunctionTool = {
  type: "function",
  name: "execute_command",
  description: "Execute one command in the isolated repository workspace.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      argv: {
        type: "array",
        items: { type: "string" },
        minItems: 1
      }
    },
    required: ["argv"],
    additionalProperties: false
  }
};

const DEFAULT_INSTRUCTIONS =
  "Act as a coding agent. Use execute_command when repository inspection or modification is required. Finish only when the acceptance criteria are satisfied.";

/** Creates the production HTTP client without exposing its API key to model inputs. */
export function createOpenAiResponsesClient(
  options: OpenAiResponsesClientOptions
): OpenAiResponsesClient {
  if (options.apiKey.trim() === "") {
    throw new Error("OpenAI API key must not be empty");
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("OpenAI request timeout must be a positive integer");
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
  const fetchRequest: OpenAiFetch = options.fetch ?? defaultOpenAiFetch;

  return {
    async create(request) {
      const response = await fetchRequest(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs)
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        // Preserve a stable, credential-free failure when an upstream proxy returns HTML.
        throw new Error(`OpenAI Responses API returned invalid JSON (HTTP ${response.status})`);
      }
      if (!response.ok) {
        throw new Error(`OpenAI Responses API returned HTTP ${response.status}`);
      }
      return body;
    }
  };
}

async function defaultOpenAiFetch(
  url: string,
  init: OpenAiFetchInit
): Promise<OpenAiFetchResponse> {
  return fetch(url, init);
}

function normalizeBaseUrl(value: string): string {
  // URL parsing prevents non-HTTP schemes from reaching the credential-bearing request.
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OpenAI base URL must use HTTP or HTTPS");
  }
  return url.toString().replace(/\/$/u, "");
}

/** Creates an AgentModel that maps strict Responses API function calls into RunEngine turns. */
export function createOpenAiResponsesAgentModel(
  options: OpenAiResponsesAgentModelOptions
): AgentModel {
  if (options.model.trim() === "") {
    throw new Error("OpenAI model must not be empty");
  }
  return {
    async next(input) {
      const response = await options.client.create(
        buildRequest(input, options.model, options.instructions ?? DEFAULT_INSTRUCTIONS)
      );
      return parseResponse(response);
    }
  };
}

function buildRequest(
  input: AgentModelInput,
  model: string,
  instructions: string
): OpenAiResponsesRequest {
  const latestResult = input.toolResults.at(-1);
  // previous_response_id already owns older history; resend only the newest tool output.
  const request: OpenAiResponsesRequest = {
    model,
    instructions,
    input: latestResult
      ? [toFunctionCallOutput(latestResult)]
      : [
          `Task: ${input.run.task}`,
          "",
          "Acceptance criteria:",
          ...input.run.acceptanceCriteria.map((criterion) => `- ${criterion}`)
        ].join("\n"),
    tools: [structuredClone(EXECUTE_COMMAND_TOOL)],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: true
  };
  if (latestResult) {
    if (!latestResult.continuationId) {
      throw new Error("OpenAI tool result is missing its persisted continuation id");
    }
    request.previous_response_id = latestResult.continuationId;
  }
  return request;
}

function toFunctionCallOutput(
  result: AgentModelInput["toolResults"][number]
): OpenAiFunctionCallOutput {
  // Provider continuation metadata is transport state, never part of tool-visible output.
  const output =
    result.status === "executed"
      ? {
          status: result.status,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr
        }
      : { status: result.status, reason: result.reason };
  return {
    type: "function_call_output",
    call_id: result.callId,
    output: JSON.stringify(output)
  };
}

function parseResponse(value: unknown): AgentModelTurn {
  // Treat every provider field as untrusted until its runtime shape is proven.
  if (!isRecord(value) || value.status !== "completed") {
    throw new Error("OpenAI response did not complete");
  }
  if (typeof value.id !== "string" || value.id.trim() === "") {
    throw new Error("OpenAI response is missing id");
  }
  if (!Array.isArray(value.output)) {
    throw new Error("OpenAI response output must be an array");
  }
  const calls = value.output.filter(
    (item): item is Record<string, unknown> =>
      isRecord(item) && item.type === "function_call"
  );
  if (calls.length === 0) {
    if (typeof value.output_text !== "string" || value.output_text.trim() === "") {
      throw new Error("OpenAI completed response is missing output_text");
    }
    return { type: "completed", summary: value.output_text };
  }
  if (calls.length > 1) {
    throw new Error(`OpenAI response returned multiple function calls: ${calls.length}`);
  }
  const call = calls[0]!;
  if (call.name !== "execute_command") {
    throw new Error(`OpenAI response requested unsupported tool: ${String(call.name)}`);
  }
  if (typeof call.call_id !== "string" || call.call_id.trim() === "") {
    throw new Error("OpenAI function call is missing call_id");
  }
  if (typeof call.arguments !== "string") {
    throw new Error("OpenAI function call arguments must be JSON text");
  }
  const args = parseCommandArguments(call.arguments);
  return {
    type: "tool_call",
    callId: call.call_id,
    continuationId: value.id,
    tool: "execute_command",
    arguments: args
  };
}

function parseCommandArguments(value: string): { argv: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("OpenAI execute_command arguments are invalid JSON");
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).some((key) => key !== "argv") ||
    !Array.isArray(parsed.argv) ||
    parsed.argv.length === 0 ||
    !parsed.argv.every((argument) => typeof argument === "string")
  ) {
    throw new Error("OpenAI execute_command arguments must contain only non-empty argv");
  }
  return { argv: parsed.argv };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
