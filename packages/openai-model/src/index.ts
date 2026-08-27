import type {
  AgentModel,
  AgentModelInput,
  AgentModelTurn
} from "@lecoding/run-engine";

/** Minimal Responses API request shape owned by the model gateway boundary. */
export interface OpenAiResponsesRequest {
  model: string;
  instructions: string;
  input: string | Array<OpenAiFunctionCallOutput | OpenAiResponsesInputMessage>;
  tools: OpenAiFunctionTool[];
  tool_choice: "auto";
  parallel_tool_calls: false;
  /** Phase 0 persists provider responses so a replacement Worker can continue by id. */
  store: true;
  previous_response_id?: string;
}

/** User-authored continuation content accepted by the Responses API input array. */
export interface OpenAiResponsesInputMessage {
  role: "user";
  content: string;
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
  function: {
    name: "execute_command" | "request_user_input";
    arguments: string;
  };
}

interface PersistedChatContinuation {
  version: 1;
  messages: OpenAiChatMessage[];
  activeCallId: string;
  pendingCalls: OpenAiChatToolCall[];
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
  name: "execute_command" | "request_user_input";
  description: string;
  strict: true;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
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
  /** Receives validated per-request usage for evaluation and billing telemetry. */
  onUsage?: (usage: OpenAiModelUsage) => void;
  /** Receives secret-free lifecycle events for the bounded malformed-JSON replay. */
  onMalformedJsonRetry?: (event: OpenAiMalformedJsonRetryEvent) => void;
}

/** Provider-neutral token counts from one completed model HTTP response. */
export interface OpenAiModelUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Stable failure categories that never contain provider-controlled text. */
export type OpenAiMalformedJsonFailureCategory =
  | "http_body_invalid_json"
  | "tool_arguments_invalid_json";

/** Secret-free telemetry emitted while one malformed-JSON replay is resolved. */
export interface OpenAiMalformedJsonRetryEvent {
  runId: string;
  protocol: OpenAiCompatibleProtocol;
  retryCount: number;
  failureCategory: OpenAiMalformedJsonFailureCategory;
  outcome: "retrying" | "recovered" | "exhausted";
}

/** Construction inputs for the RunEngine-native Responses API adapter. */
export interface OpenAiResponsesAgentModelOptions {
  model: string;
  client: OpenAiResponsesClient;
  instructions?: string;
  onUsage?: (usage: OpenAiModelUsage) => void;
  /** Observer errors are ignored so telemetry cannot alter the model turn. */
  onMalformedJsonRetry?: (event: OpenAiMalformedJsonRetryEvent) => void;
}

/** Construction inputs for the RunEngine-native Chat Completions adapter. */
export interface OpenAiChatCompletionsAgentModelOptions {
  model: string;
  client: OpenAiChatCompletionsClient;
  instructions?: string;
  onUsage?: (usage: OpenAiModelUsage) => void;
  /** Observer errors are ignored so telemetry cannot alter the model turn. */
  onMalformedJsonRetry?: (event: OpenAiMalformedJsonRetryEvent) => void;
}

const EXECUTE_COMMAND_TOOL: OpenAiFunctionTool = {
  type: "function",
  name: "execute_command",
  description:
    "Execute exactly one process in the isolated /workspace repository. argv[0] is the executable and later items are only its arguments.",
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

const REQUEST_USER_INPUT_TOOL: OpenAiFunctionTool = {
  type: "function",
  name: "request_user_input",
  description: "Pause the Run and ask the user one necessary clarifying question.",
  strict: true,
  parameters: {
    type: "object",
    properties: { question: { type: "string", minLength: 1 } },
    required: ["question"],
    additionalProperties: false
  }
};

const DEFAULT_INSTRUCTIONS = [
  "Act as a coding agent in an isolated repository workspace.",
  "Use execute_command when repository inspection or modification is required.",
  "Each call runs exactly one process: argv[0] is exactly one executable and remaining argv items are arguments to that executable; never concatenate separate commands into one argv.",
  "The working directory is already /workspace. Git metadata is intentionally unavailable inside the container, so do not run git commands; host-side services report changes and verification evidence.",
  "In manual approval mode, minimize exploratory commands and read only files necessary for the requested change.",
  "After finishing the requested edits, do not execute acceptance verification commands such as pnpm test or pnpm typecheck; return completed and the host Verifier will run administrator-reviewed checks in a separate dependency-prepared image.",
  "Use request_user_input only when a necessary ambiguity cannot be resolved from repository files.",
  "Finish the editing turn only when the requested change is ready for host verification."
].join(" ");

// A single replay improves compatible-provider tolerance without turning malformed
// output into an unbounded loop or allowing any command to escape validation.
const MALFORMED_JSON_RETRY_LIMIT = 1;

class OpenAiMalformedJsonError extends Error {
  constructor(
    readonly category: OpenAiMalformedJsonFailureCategory,
    message: string
  ) {
    super(message);
    this.name = "OpenAiMalformedJsonError";
  }
}

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
        : {}),
      ...(options.onUsage !== undefined ? { onUsage: options.onUsage } : {}),
      ...(options.onMalformedJsonRetry !== undefined
        ? { onMalformedJsonRetry: options.onMalformedJsonRetry }
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
      : {}),
    ...(options.onUsage !== undefined ? { onUsage: options.onUsage } : {}),
    ...(options.onMalformedJsonRetry !== undefined
      ? { onMalformedJsonRetry: options.onMalformedJsonRetry }
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
        throw new OpenAiMalformedJsonError(
          "http_body_invalid_json",
          `OpenAI Responses API returned invalid JSON (HTTP ${response.status})`
        );
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
        throw new OpenAiMalformedJsonError(
          "http_body_invalid_json",
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
      const request = buildRequest(
        input,
        options.model,
        options.instructions ?? DEFAULT_INSTRUCTIONS
      );
      return requestValidatedTurn(
        () => options.client.create(request),
        (response) => parseResponse(response),
        "openai_responses",
        options.onUsage,
        input.runId,
        options.onMalformedJsonRetry
      );
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
      let continuationMessages: OpenAiChatMessage[] = [];
      if (latestResult) {
        const state = parsePersistedChatContinuation(
          latestResult.continuationId,
          latestResult.callId
        );
        continuationMessages = [
          ...state.messages,
          {
            role: "tool",
            tool_call_id: latestResult.callId,
            content: toFunctionCallOutput(latestResult).output
          }
        ];
        const [nextCall, ...remainingCalls] = state.pendingCalls;
        if (nextCall) {
          // Provider batches are exposed one at a time so policy and side effects stay serial.
          return toChatToolTurn(nextCall, {
            version: 1,
            messages: continuationMessages,
            activeCallId: nextCall.id,
            pendingCalls: remainingCalls
          });
        }
      }
      const request: OpenAiChatCompletionsRequest = {
        model: options.model,
        messages: [...initialMessages, ...continuationMessages],
        tools: [EXECUTE_COMMAND_TOOL, REQUEST_USER_INPUT_TOOL].map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              strict: tool.strict,
              parameters: structuredClone(tool.parameters)
            }
        })),
        tool_choice: "auto",
        parallel_tool_calls: false
      };
      return requestValidatedTurn(
        () => options.client.create(request),
        (response) => parseChatCompletion(response, continuationMessages),
        "openai_chat_completions",
        options.onUsage,
        input.runId,
        options.onMalformedJsonRetry
      );
    }
  };
}

async function requestValidatedTurn(
  create: () => Promise<unknown>,
  parse: (response: unknown) => AgentModelTurn,
  protocol: OpenAiCompatibleProtocol,
  onUsage: ((usage: OpenAiModelUsage) => void) | undefined,
  runId: string,
  onMalformedJsonRetry:
    | ((event: OpenAiMalformedJsonRetryEvent) => void)
    | undefined
): Promise<AgentModelTurn> {
  let retryCount = 0;
  let initialFailureCategory: OpenAiMalformedJsonFailureCategory | undefined;
  for (;;) {
    try {
      const response = await create();
      // Bill every syntactically valid provider response, including one whose tool
      // arguments force a retry, so resilience does not hide token consumption.
      if (onUsage) {
        onUsage(parseModelUsage(response, protocol));
      }
      const turn = parse(response);
      if (initialFailureCategory) {
        emitMalformedJsonRetry(onMalformedJsonRetry, {
          runId,
          protocol,
          retryCount,
          failureCategory: initialFailureCategory,
          outcome: "recovered"
        });
      }
      return turn;
    } catch (error) {
      if (initialFailureCategory) {
        emitMalformedJsonRetry(onMalformedJsonRetry, {
          runId,
          protocol,
          retryCount,
          failureCategory: initialFailureCategory,
          outcome: "exhausted"
        });
        throw error;
      }
      if (!(error instanceof OpenAiMalformedJsonError)) {
        throw error;
      }
      if (retryCount >= MALFORMED_JSON_RETRY_LIMIT) {
        throw error;
      }
      retryCount += 1;
      initialFailureCategory = error.category;
      emitMalformedJsonRetry(onMalformedJsonRetry, {
        runId,
        protocol,
        retryCount,
        failureCategory: initialFailureCategory,
        outcome: "retrying"
      });
      // No AgentModelTurn has escaped yet, so replaying the identical request cannot
      // approve or execute a provider-suggested command from the malformed attempt.
    }
  }
}

function emitMalformedJsonRetry(
  observer: ((event: OpenAiMalformedJsonRetryEvent) => void) | undefined,
  event: OpenAiMalformedJsonRetryEvent
): void {
  try {
    observer?.(event);
  } catch {
    // Observability is best-effort and must never suppress or manufacture a model turn.
  }
}

function parseModelUsage(
  value: unknown,
  protocol: OpenAiCompatibleProtocol
): OpenAiModelUsage {
  if (!isRecord(value) || !isRecord(value.usage)) {
    throw new Error("OpenAI response is missing token usage");
  }
  const input =
    protocol === "openai_responses"
      ? value.usage.input_tokens
      : value.usage.prompt_tokens;
  const output =
    protocol === "openai_responses"
      ? value.usage.output_tokens
      : value.usage.completion_tokens;
  if (
    !Number.isSafeInteger(input) ||
    Number(input) < 0 ||
    !Number.isSafeInteger(output) ||
    Number(output) < 0
  ) {
    throw new Error("OpenAI response contains invalid token usage");
  }
  return { inputTokens: Number(input), outputTokens: Number(output) };
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
        ...input.run.acceptanceCriteria.map((criterion) => `- ${criterion}`),
        ...formatSteeringSection(input.steeringMessages)
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
  const toolCalls = calls.map((rawCall) => parseChatToolCall(rawCall));
  if (new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length) {
    throw new Error("OpenAI chat completion returned duplicate function call ids");
  }
  const [toolCall, ...pendingCalls] = toolCalls;
  if (!toolCall) {
    throw new Error("OpenAI chat completion is missing its function call");
  }
  const assistantMessage: OpenAiChatMessage = {
    role: "assistant",
    content: typeof message.content === "string" ? message.content : null,
    tool_calls: toolCalls
  };
  return toChatToolTurn(toolCall, {
    version: 1,
    messages: [...continuationMessages, assistantMessage],
    activeCallId: toolCall.id,
    pendingCalls
  });
}

function parseChatToolCall(rawCall: unknown): OpenAiChatToolCall {
  if (!isRecord(rawCall) || rawCall.type !== "function" || !isRecord(rawCall.function)) {
    throw new Error("OpenAI chat completion returned a malformed function call");
  }
  if (
    rawCall.function.name !== "execute_command" &&
    rawCall.function.name !== "request_user_input"
  ) {
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
  return {
    id: rawCall.id,
    type: "function",
    function: {
      name: rawCall.function.name,
      arguments: rawCall.function.arguments
    }
  };
}

function toChatToolTurn(
  toolCall: OpenAiChatToolCall,
  continuation: PersistedChatContinuation
): AgentModelTurn {
  if (toolCall.function.name === "request_user_input") {
    return {
      type: "user_request",
      requestId: toolCall.id,
      continuationId: JSON.stringify(continuation),
      prompt: parseUserQuestion(toolCall.function.arguments)
    };
  }
  return {
    type: "tool_call",
    callId: toolCall.id,
    // The versioned envelope survives Worker replacement and queues provider batches.
    continuationId: JSON.stringify(continuation),
    tool: "execute_command",
    arguments: parseCommandArguments(toolCall.function.arguments)
  };
}

function parsePersistedChatContinuation(
  continuationId: string | undefined,
  expectedCallId: string
): PersistedChatContinuation {
  if (!continuationId) {
    throw new Error("OpenAI tool result is missing its persisted continuation id");
  }
  let value: unknown;
  try {
    value = JSON.parse(continuationId);
  } catch {
    throw new Error("OpenAI chat continuation is invalid JSON");
  }
  if (Array.isArray(value)) {
    // Accept continuations written before the versioned queue envelope shipped.
    const messages = parsePersistedChatMessages(value);
    const last = messages.at(-1);
    if (
      last?.role !== "assistant" ||
      last.tool_calls?.[0]?.id !== expectedCallId
    ) {
      throw new Error("OpenAI chat continuation does not match the tool result call id");
    }
    return {
      version: 1,
      messages,
      activeCallId: expectedCallId,
      pendingCalls: []
    };
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.messages) ||
    typeof value.activeCallId !== "string" ||
    !Array.isArray(value.pendingCalls)
  ) {
    throw new Error("OpenAI chat continuation must contain message history");
  }
  if (value.activeCallId !== expectedCallId) {
    throw new Error("OpenAI chat continuation does not match the tool result call id");
  }
  const messages = parsePersistedChatMessages(value.messages);
  const pendingCalls = value.pendingCalls.map((call) => parseChatToolCall(call));
  validatePersistedChatQueue(messages, value.activeCallId, pendingCalls);
  return {
    version: 1,
    messages,
    activeCallId: value.activeCallId,
    pendingCalls
  };
}

function validatePersistedChatQueue(
  messages: OpenAiChatMessage[],
  activeCallId: string,
  pendingCalls: OpenAiChatToolCall[]
): void {
  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      assistantIndex = index;
      break;
    }
  }
  const assistant = messages[assistantIndex];
  const batch = assistant?.role === "assistant" ? assistant.tool_calls ?? [] : [];
  const batchIds = batch.map((call) => call.id);
  const activeIndex = batchIds.indexOf(activeCallId);
  const completedIds = messages
    .slice(assistantIndex + 1)
    .map((message) => (message.role === "tool" ? message.tool_call_id : undefined));
  const expectedCompletedIds = batchIds.slice(0, activeIndex);
  const expectedPending = batch.slice(activeIndex + 1);
  const queueMatches =
    activeIndex >= 0 &&
    new Set(batchIds).size === batchIds.length &&
    completedIds.every((id): id is string => id !== undefined) &&
    completedIds.length === expectedCompletedIds.length &&
    completedIds.every((id, index) => id === expectedCompletedIds[index]) &&
    pendingCalls.length === expectedPending.length &&
    pendingCalls.every(
      (call, index) => JSON.stringify(call) === JSON.stringify(expectedPending[index])
    );
  if (!queueMatches) {
    throw new Error(
      "OpenAI chat continuation queue does not match its assistant batch"
    );
  }
}

function parsePersistedChatMessages(value: unknown[]): OpenAiChatMessage[] {
  if (value.length === 0) {
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
    if (item.tool_calls.length === 0) {
      throw new Error("OpenAI chat continuation has an empty function-call batch");
    }
    const toolCalls = item.tool_calls.map((call) => parseChatToolCall(call));
    messages.push({
      role: "assistant",
      content: typeof item.content === "string" ? item.content : null,
      tool_calls: toolCalls
    });
  }
  return messages;
}

function buildRequest(
  input: AgentModelInput,
  model: string,
  instructions: string
): OpenAiResponsesRequest {
  const latestResult = input.toolResults.at(-1);
  const steering = formatSteeringMessage(input.steeringMessages);
  // previous_response_id already owns older history; resend only the newest tool output.
  const request: OpenAiResponsesRequest = {
    model,
    instructions,
    input: latestResult
      ? [
          toFunctionCallOutput(latestResult),
          ...(steering ? [{ role: "user" as const, content: steering }] : [])
        ]
      : [
          `Task: ${input.run.task}`,
          "",
          "Acceptance criteria:",
          ...input.run.acceptanceCriteria.map((criterion) => `- ${criterion}`),
          ...formatSteeringSection(input.steeringMessages)
        ].join("\n"),
    tools: [
      structuredClone(EXECUTE_COMMAND_TOOL),
      structuredClone(REQUEST_USER_INPUT_TOOL)
    ],
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

function formatSteeringSection(messages: string[] | undefined): string[] {
  const content = formatSteeringMessage(messages);
  return content ? ["", content] : [];
}

function formatSteeringMessage(messages: string[] | undefined): string {
  if (!messages?.length) {
    return "";
  }
  // The heading distinguishes later operator constraints from the original task.
  return [
    "Additional user instructions:",
    ...messages.map((message) => `- ${message}`)
  ].join("\n");
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
      : result.status === "denied"
        ? { status: result.status, reason: result.reason }
        : { status: result.status, value: result.value };
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
  if (call.name !== "execute_command" && call.name !== "request_user_input") {
    throw new Error(`OpenAI response requested unsupported tool: ${String(call.name)}`);
  }
  if (typeof call.call_id !== "string" || call.call_id.trim() === "") {
    throw new Error("OpenAI function call is missing call_id");
  }
  if (typeof call.arguments !== "string") {
    throw new Error("OpenAI function call arguments must be JSON text");
  }
  if (call.name === "request_user_input") {
    return {
      type: "user_request",
      requestId: call.call_id,
      continuationId: value.id,
      prompt: parseUserQuestion(call.arguments)
    };
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

function parseUserQuestion(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new OpenAiMalformedJsonError(
      "tool_arguments_invalid_json",
      "OpenAI request_user_input arguments are invalid JSON"
    );
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).some((key) => key !== "question") ||
    typeof parsed.question !== "string" ||
    parsed.question.trim() === ""
  ) {
    throw new Error("OpenAI request_user_input arguments must contain one question");
  }
  return parsed.question;
}

function parseCommandArguments(value: string): { argv: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new OpenAiMalformedJsonError(
      "tool_arguments_invalid_json",
      "OpenAI execute_command arguments are invalid JSON"
    );
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
