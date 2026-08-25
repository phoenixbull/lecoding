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

/** Minimal Chat Completions request used by providers without the Responses API. */
export interface OpenAiChatCompletionsRequest {
  model: string;
  messages: OpenAiChatMessage[];
  tools: OpenAiChatFunctionTool[];
  tool_choice: "auto";
  parallel_tool_calls: false;
}

/** Conversation messages persisted to continue a stateless Chat Completions call. */
export type OpenAiChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAiChatToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/** OpenAI-compatible assistant function call carried inside a chat message. */
export interface OpenAiChatToolCall {
  id: string;
  type: "function";
  function: { name: "execute_command"; arguments: string };
}

/** Chat Completions wrapper for the strict command function. */
export interface OpenAiChatFunctionTool {
  type: "function";
  function: Omit<OpenAiFunctionTool, "type">;
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

/** Injectable Chat Completions client seam; responses remain untrusted. */
export interface OpenAiChatCompletionsClient {
  create(request: OpenAiChatCompletionsRequest): Promise<unknown>;
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

/** OpenAI-compatible wire protocols supported by the model gateway. */
export type OpenAiCompatibleProtocol =
  | "openai_responses"
  | "openai_chat_completions";

/** Provider-neutral configuration for a supported OpenAI-compatible endpoint. */
export interface OpenAiCompatibleModelConfig {
  protocol: OpenAiCompatibleProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Environment source accepted by Worker composition and deterministic tests. */
export type ModelEnvironment = Readonly<Record<string, string | undefined>>;

/** Composition inputs for any vendor implementing the OpenAI Responses contract. */
export interface OpenAiCompatibleAgentModelOptions {
  config: OpenAiCompatibleModelConfig;
  timeoutMs?: number;
  fetch?: OpenAiFetch;
  instructions?: string;
}

/** Construction inputs for the RunEngine-native Responses API adapter. */
export interface OpenAiResponsesAgentModelOptions {
  model: string;
  client: OpenAiResponsesClient;
  instructions?: string;
}

/** Construction inputs for the RunEngine-native Chat Completions adapter. */
export interface OpenAiChatCompletionsAgentModelOptions {
  model: string;
  client: OpenAiChatCompletionsClient;
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

/** Loads one OpenAI-compatible provider without assuming vendor names. */
export function loadOpenAiCompatibleModelConfig(
  environment: ModelEnvironment
): OpenAiCompatibleModelConfig {
  const protocol = requireModelSetting(environment, "LECODING_MODEL_PROTOCOL");
  if (
    protocol !== "openai_responses" &&
    protocol !== "openai_chat_completions"
  ) {
    throw new Error(
      `Unsupported LECODING_MODEL_PROTOCOL: ${protocol}; expected openai_responses or openai_chat_completions`
    );
  }
  const baseUrl = normalizeBaseUrl(
    requireModelSetting(environment, "LECODING_MODEL_BASE_URL")
  );
  return {
    protocol,
    baseUrl,
    apiKey: requireModelSetting(environment, "LECODING_MODEL_API_KEY"),
    model: requireModelSetting(environment, "LECODING_MODEL_ID")
  };
}

/** Composes the provider-neutral configuration into the existing AgentModel seam. */
export function createOpenAiCompatibleAgentModel(
  options: OpenAiCompatibleAgentModelOptions
): AgentModel {
  if (options.config.protocol === "openai_chat_completions") {
    const client = createOpenAiChatCompletionsClient({
      apiKey: options.config.apiKey,
      baseUrl: options.config.baseUrl,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
    });
    return createOpenAiChatCompletionsAgentModel({
      model: options.config.model,
      client,
      ...(options.instructions !== undefined
        ? { instructions: options.instructions }
        : {})
    });
  }
  const client = createOpenAiResponsesClient({
    apiKey: options.config.apiKey,
    baseUrl: options.config.baseUrl,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
  });
  return createOpenAiResponsesAgentModel({
    model: options.config.model,
    client,
    ...(options.instructions !== undefined
      ? { instructions: options.instructions }
      : {})
  });
}

function requireModelSetting(
  environment: ModelEnvironment,
  name: string
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`Missing required model setting: ${name}`);
  }
  return value;
}

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

/** Creates an HTTP client for the widely implemented Chat Completions endpoint. */
export function createOpenAiChatCompletionsClient(
  options: OpenAiResponsesClientOptions
): OpenAiChatCompletionsClient {
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
      const response = await fetchRequest(`${baseUrl}/chat/completions`, {
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
        throw new Error(
          `OpenAI Chat Completions API returned invalid JSON (HTTP ${response.status})`
        );
      }
      if (!response.ok) {
        throw new Error(`OpenAI Chat Completions API returned HTTP ${response.status}`);
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
  // Remote plaintext endpoints would expose the bearer credential in transit.
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Model base URL must use HTTP or HTTPS");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol === "http:" && !loopbackHosts.has(url.hostname)) {
    throw new Error("Remote model base URL must use HTTPS");
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

/** Creates an AgentModel over the stateless Chat Completions function-call protocol. */
export function createOpenAiChatCompletionsAgentModel(
  options: OpenAiChatCompletionsAgentModelOptions
): AgentModel {
  if (options.model.trim() === "") {
    throw new Error("OpenAI model must not be empty");
  }
  return {
    async next(input) {
      const initialMessages = buildInitialChatMessages(
        input,
        options.instructions ?? DEFAULT_INSTRUCTIONS
      );
      const latestResult = input.toolResults.at(-1);
      const persistedMessages = latestResult
        ? parsePersistedChatMessages(latestResult.continuationId, latestResult.callId)
        : [];
      const continuationMessages: OpenAiChatMessage[] = latestResult
        ? [
            ...persistedMessages,
            {
              role: "tool",
              tool_call_id: latestResult.callId,
              content: toFunctionCallOutput(latestResult).output
            }
          ]
        : [];
      const response = await options.client.create({
        model: options.model,
        messages: [...initialMessages, ...continuationMessages],
        tools: [
          {
            type: "function",
            function: {
              name: EXECUTE_COMMAND_TOOL.name,
              description: EXECUTE_COMMAND_TOOL.description,
              strict: EXECUTE_COMMAND_TOOL.strict,
              parameters: structuredClone(EXECUTE_COMMAND_TOOL.parameters)
            }
          }
        ],
        tool_choice: "auto",
        parallel_tool_calls: false
      });
      return parseChatCompletion(response, continuationMessages);
    }
  };
}

function buildInitialChatMessages(
  input: AgentModelInput,
  instructions: string
): OpenAiChatMessage[] {
  return [
    { role: "system", content: instructions },
    {
      role: "user",
      content: [
        `Task: ${input.run.task}`,
        "",
        "Acceptance criteria:",
        ...input.run.acceptanceCriteria.map((criterion) => `- ${criterion}`)
      ].join("\n")
    }
  ];
}

function parseChatCompletion(
  value: unknown,
  continuationMessages: OpenAiChatMessage[]
): AgentModelTurn {
  // Chat providers are untrusted even when they advertise OpenAI compatibility.
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length !== 1) {
    throw new Error("OpenAI chat completion must contain exactly one choice");
  }
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new Error("OpenAI chat completion is missing its assistant message");
  }
  const message = choice.message;
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (calls.length === 0) {
    if (typeof message.content !== "string" || message.content.trim() === "") {
      throw new Error("OpenAI chat completion is missing assistant content");
    }
    return { type: "completed", summary: message.content };
  }
  if (calls.length > 1) {
    throw new Error(`OpenAI chat completion returned multiple function calls: ${calls.length}`);
  }
  const rawCall = calls[0];
  if (!isRecord(rawCall) || rawCall.type !== "function" || !isRecord(rawCall.function)) {
    throw new Error("OpenAI chat completion returned a malformed function call");
  }
  if (rawCall.function.name !== "execute_command") {
    throw new Error(
      `OpenAI response requested unsupported tool: ${String(rawCall.function.name)}`
    );
  }
  if (typeof rawCall.id !== "string" || rawCall.id.trim() === "") {
    throw new Error("OpenAI function call is missing call id");
  }
  if (typeof rawCall.function.arguments !== "string") {
    throw new Error("OpenAI function call arguments must be JSON text");
  }
  const toolCall: OpenAiChatToolCall = {
    id: rawCall.id,
    type: "function",
    function: {
      name: "execute_command",
      arguments: rawCall.function.arguments
    }
  };
  return {
    type: "tool_call",
    callId: toolCall.id,
    // The stateless protocol must persist the assistant call for the next request.
    continuationId: JSON.stringify([
      ...continuationMessages,
      { role: "assistant", content: null, tool_calls: [toolCall] }
    ]),
    tool: "execute_command",
    arguments: parseCommandArguments(toolCall.function.arguments)
  };
}

function parsePersistedChatMessages(
  continuationId: string | undefined,
  expectedCallId: string
): OpenAiChatMessage[] {
  if (!continuationId) {
    throw new Error("OpenAI tool result is missing its persisted continuation id");
  }
  let value: unknown;
  try {
    value = JSON.parse(continuationId);
  } catch {
    throw new Error("OpenAI chat continuation is invalid JSON");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("OpenAI chat continuation must contain message history");
  }
  const messages: OpenAiChatMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      throw new Error("OpenAI chat continuation contains a malformed message");
    }
    if (item.role === "tool") {
      if (typeof item.tool_call_id !== "string" || typeof item.content !== "string") {
        throw new Error("OpenAI chat continuation contains a malformed tool result");
      }
      messages.push({
        role: "tool",
        tool_call_id: item.tool_call_id,
        content: item.content
      });
      continue;
    }
    if (item.role !== "assistant" || !Array.isArray(item.tool_calls)) {
      throw new Error("OpenAI chat continuation contains an unsupported message");
    }
    if (item.tool_calls.length !== 1) {
      throw new Error("OpenAI chat continuation must contain one function call per turn");
    }
    const rawCall = item.tool_calls[0];
    if (
      !isRecord(rawCall) ||
      rawCall.type !== "function" ||
      typeof rawCall.id !== "string" ||
      !isRecord(rawCall.function) ||
      rawCall.function.name !== "execute_command" ||
      typeof rawCall.function.arguments !== "string"
    ) {
      throw new Error("OpenAI chat continuation contains a malformed function call");
    }
    messages.push({
      role: "assistant",
      content: typeof item.content === "string" ? item.content : null,
      tool_calls: [
        {
          id: rawCall.id,
          type: "function",
          function: {
            name: "execute_command",
            arguments: rawCall.function.arguments
          }
        }
      ]
    });
  }
  const last = messages.at(-1);
  if (
    last?.role !== "assistant" ||
    last.tool_calls?.[0]?.id !== expectedCallId
  ) {
    throw new Error("OpenAI chat continuation does not match the tool result call id");
  }
  return messages;
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
