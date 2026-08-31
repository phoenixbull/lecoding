import type {
  AgentModel,
  AgentModelInput,
  AgentModelTurn,
  ModelToolResult
} from "@lecoding/run-engine";
import { randomUUID } from "node:crypto";

/** Minimal Messages API request shape owned by the model gateway boundary. */
export interface AnthropicMessagesRequest {
  model: string;
  /** Anthropic requires an explicit output ceiling on every request. */
  max_tokens: number;
  /** System prompt carrying the provider-neutral agent instructions. */
  system: string;
  messages: AnthropicMessage[];
  tools: AnthropicTool[];
  tool_choice: { type: "auto" };
}

/**
 * Wire messages persisted to continue a stateless Messages API call.
 * The initial user task message is rebuilt per turn, so persisted user
 * messages carry only tool-result blocks.
 */
export type AnthropicMessage =
  | { role: "user"; content: string | AnthropicToolResultBlock[] }
  | { role: "assistant"; content: string | AnthropicContentBlock[] };

/** One assistant output block; text or a structured tool invocation. */
export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | AnthropicToolUseBlock;

/** A model-issued tool invocation with structured (non-string) input. */
export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name:
    | "execute_command"
    | "request_user_input"
    | "request_network_egress";
  input: Record<string, unknown>;
}

/** Tool-result block sent back inside a user message after execution. */
export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

/** Tool declaration carrying a JSON Schema instead of OpenAI's flat envelope. */
export interface AnthropicTool {
  name: "execute_command" | "request_user_input" | "request_network_egress";
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

/** Injectable API client seam; the adapter validates its untrusted response. */
export interface AnthropicMessagesClient {
  create(request: AnthropicMessagesRequest): Promise<unknown>;
}

/** Narrow fetch input exposed for deterministic gateway contract tests. */
export interface AnthropicFetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

/** Minimal fetch response surface needed by the Messages client. */
export interface AnthropicFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Injectable HTTP seam; production defaults to the runtime's global fetch. */
export type AnthropicFetch = (
  url: string,
  init: AnthropicFetchInit
) => Promise<AnthropicFetchResponse>;

/** Credentials and endpoint configuration for the Messages HTTP client. */
export interface AnthropicMessagesClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: AnthropicFetch;
}

/** Stable failure categories that never contain provider-controlled text. */
export type AnthropicMalformedJsonFailureCategory =
  | "http_body_invalid_json"
  | "tool_arguments_invalid_json";

class AnthropicMalformedJsonError extends Error {
  constructor(
    readonly category: AnthropicMalformedJsonFailureCategory,
    message: string
  ) {
    super(message);
    this.name = "AnthropicMalformedJsonError";
  }
}

/** Anthropic API version pinned by the deployment, not chosen by the model. */
const ANTHROPIC_VERSION = "2023-06-01";

/** Provider-neutral configuration used by Worker composition and live golden baselines. */
export interface AnthropicModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Environment source accepted by Worker composition and deterministic tests. */
export type AnthropicModelEnvironment = Readonly<Record<string, string | undefined>>;

/** Loads a validated config from an environment snapshot without leaking credentials. */
export function loadAnthropicModelConfig(
  environment: AnthropicModelEnvironment
): AnthropicModelConfig {
  const rawBaseUrl = requireModelSetting(environment, "ANTHROPIC_BASE_URL");
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(rawBaseUrl);
  } catch (cause) {
    throw new Error(`Invalid ANTHROPIC_BASE_URL: ${(cause as Error).message}`);
  }
  return {
    baseUrl,
    apiKey: requireModelSetting(environment, "ANTHROPIC_API_KEY"),
    model: requireModelSetting(environment, "ANTHROPIC_MODEL")
  };
}

function requireModelSetting(
  environment: AnthropicModelEnvironment,
  name: string
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`Missing required model setting: ${name}`);
  }
  return value;
}

/** Composition inputs for the Anthropic Messages API contract. */
export interface AnthropicCompatibleAgentModelOptions {
  config: AnthropicModelConfig;
  timeoutMs?: number;
  fetch?: AnthropicFetch;
  instructions?: string;
  onUsage?: (usage: AnthropicModelUsage) => void | Promise<void>;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  createRequestId?: () => string;
  onRequestStart?: (request: AnthropicModelRequestReservation) => void | Promise<void>;
  onRequestFailure?: (request: AnthropicModelRequestReference) => void | Promise<void>;
  onBeforeModelRetry?: (retry: AnthropicModelRetryRequest) => void | Promise<void>;
  onMalformedJsonRetry?: (event: AnthropicMalformedJsonRetryEvent) => void;
}

/** Composes the validated Anthropic config into the existing AgentModel seam. */
export function createAnthropicCompatibleAgentModel(
  options: AnthropicCompatibleAgentModelOptions
): AgentModel {
  const client = createAnthropicMessagesClient({
    apiKey: options.config.apiKey,
    baseUrl: options.config.baseUrl,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
  });
  return createAnthropicAgentModel({
    model: options.config.model,
    client,
    ...(options.instructions !== undefined
      ? { instructions: options.instructions }
      : {}),
    ...(options.maxInputTokens !== undefined
      ? { maxInputTokens: options.maxInputTokens }
      : {}),
    ...(options.maxOutputTokens !== undefined
      ? { maxOutputTokens: options.maxOutputTokens }
      : {}),
    ...(options.createRequestId ? { createRequestId: options.createRequestId } : {}),
    ...(options.onRequestStart ? { onRequestStart: options.onRequestStart } : {}),
    ...(options.onRequestFailure
      ? { onRequestFailure: options.onRequestFailure }
      : {}),
    ...(options.onBeforeModelRetry
      ? { onBeforeModelRetry: options.onBeforeModelRetry }
      : {}),
    ...(options.onUsage !== undefined ? { onUsage: options.onUsage } : {}),
    ...(options.onMalformedJsonRetry !== undefined
      ? { onMalformedJsonRetry: options.onMalformedJsonRetry }
      : {})
  });
}

/** Creates the Messages HTTP client without exposing credentials to model inputs. */
export function createAnthropicMessagesClient(
  options: AnthropicMessagesClientOptions
): AnthropicMessagesClient {
  if (options.apiKey.trim() === "") {
    throw new Error("Anthropic API key must not be empty");
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Anthropic request timeout must be a positive integer");
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.anthropic.com");
  const fetchRequest: AnthropicFetch = options.fetch ?? defaultAnthropicFetch;

  return {
    async create(request) {
      const response = await fetchRequest(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": options.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json"
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs)
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        // Preserve a stable, credential-free failure when a proxy returns HTML.
        throw new AnthropicMalformedJsonError(
          "http_body_invalid_json",
          `Anthropic Messages API returned invalid JSON (HTTP ${response.status})`
        );
      }
      if (!response.ok) {
        throw new Error(`Anthropic Messages API returned HTTP ${response.status}`);
      }
      return body;
    }
  };
}

async function defaultAnthropicFetch(
  url: string,
  init: AnthropicFetchInit
): Promise<AnthropicFetchResponse> {
  return fetch(url, init);
}

/** Versioned envelope persisted as the turn continuation across Worker replacement. */
interface PersistedMessagesContinuation {
  version: 1;
  /** Wire history after the initial user message; the batch is replayed from it. */
  messages: AnthropicMessage[];
  activeCallId: string;
  /** Provider batches are queued so policy and side effects stay serial. */
  pendingCalls: AnthropicToolUseBlock[];
}

/** Construction inputs for the RunEngine-native Messages API adapter. */
export interface AnthropicAgentModelOptions {
  model: string;
  client: AnthropicMessagesClient;
  instructions?: string;
  /** Settles validated usage; required with request budget lifecycle hooks. */
  onUsage?: (usage: AnthropicModelUsage) => void | Promise<void>;
  /** Conservative provider-neutral ceiling for serialized request input. */
  maxInputTokens?: number;
  /** Messages API output cap for every attempted request, including retries. */
  maxOutputTokens?: number;
  /** Creates a globally unique identity shared by reservation and settlement. */
  createRequestId?: () => string;
  /** Persists worst-case exposure before the client may contact its provider. */
  onRequestStart?: (request: AnthropicModelRequestReservation) => void | Promise<void>;
  /** Conservatively settles requests whose actual provider usage is unavailable. */
  onRequestFailure?: (request: AnthropicModelRequestReference) => void | Promise<void>;
  /** Must durably authorize the retry before the adapter replays a request. */
  onBeforeModelRetry?: (retry: AnthropicModelRetryRequest) => void | Promise<void>;
  /** Observer errors are ignored so telemetry cannot alter the model turn. */
  onMalformedJsonRetry?: (event: AnthropicMalformedJsonRetryEvent) => void;
}

/** Provider-neutral token counts from one completed model HTTP response. */
export interface AnthropicModelUsage {
  runId: string;
  /** Present when request reservation lifecycle hooks are configured. */
  requestId?: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Anthropic reports cache tokens outside input_tokens, so inputTokens folds
   * cache creation and cache reads into one total comparable across providers.
   */
  cachedInputTokens: number;
}

/** Worst-case token envelope reserved before one provider HTTP request. */
export interface AnthropicModelRequestReservation {
  runId: string;
  requestId: string;
  maxInputTokens: number;
  maxOutputTokens: number;
}

/** Stable identity used to settle an unknowable provider request conservatively. */
export interface AnthropicModelRequestReference {
  runId: string;
  requestId: string;
}

/** Secret-free identity for a classified model retry awaiting durable admission. */
export interface AnthropicModelRetryRequest {
  runId: string;
  protocol: "anthropic_messages";
  retryCount: number;
  failureCategory: AnthropicMalformedJsonFailureCategory;
}

/** Secret-free telemetry emitted while one malformed-JSON replay is resolved. */
export interface AnthropicMalformedJsonRetryEvent {
  runId: string;
  protocol: "anthropic_messages";
  retryCount: number;
  failureCategory: AnthropicMalformedJsonFailureCategory;
  outcome: "retrying" | "recovered" | "exhausted";
}

const EXECUTE_COMMAND_TOOL: AnthropicTool = {
  name: "execute_command",
  description:
    "Execute exactly one process in the isolated /workspace repository. argv[0] is the executable and later items are only its arguments.",
  input_schema: {
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

const REQUEST_USER_INPUT_TOOL: AnthropicTool = {
  name: "request_user_input",
  description: "Pause the Run and ask the user one necessary clarifying question.",
  input_schema: {
    type: "object",
    properties: { question: { type: "string", minLength: 1 } },
    required: ["question"],
    additionalProperties: false
  }
};

const REQUEST_NETWORK_EGRESS_TOOL: AnthropicTool = {
  name: "request_network_egress",
  description:
    "Request approval for one exact HTTPS domain and port before attempting a task that needs external network access. This grants only the endpoint capability; it does not expose credentials.",
  input_schema: {
    type: "object",
    properties: {
      scheme: { type: "string", enum: ["https"] },
      domain: { type: "string", minLength: 1, maxLength: 253 },
      port: { type: "integer", minimum: 1, maximum: 65535 },
      purpose: { type: "string", minLength: 1, maxLength: 500 }
    },
    required: ["scheme", "domain", "port", "purpose"],
    additionalProperties: false
  }
};

// Kept identical to the OpenAI adapter so golden baselines compare agent behavior
// and not instruction drift between providers.
const DEFAULT_INSTRUCTIONS = [
  "Act as a coding agent in an isolated repository workspace.",
  "Use execute_command when repository inspection or modification is required.",
  "Each call runs exactly one process: argv[0] is exactly one executable and remaining argv items are arguments to that executable; never concatenate separate commands into one argv.",
  "The working directory is already /workspace. Git metadata is intentionally unavailable inside the container, so do not run git commands; host-side services report changes and verification evidence.",
  "In manual approval mode, minimize exploratory commands and read only files necessary for the requested change.",
  "After finishing the requested edits, do not execute acceptance verification commands such as pnpm test or pnpm typecheck; return completed and the host Verifier will run administrator-reviewed checks in a separate dependency-prepared image.",
  "Use request_user_input only when a necessary ambiguity cannot be resolved from repository files.",
  "Use request_network_egress before any operation that requires external network access; request one exact HTTPS domain and port with a concrete purpose.",
  "Finish the editing turn only when the requested change is ready for host verification."
].join(" ");

// A single replay improves provider tolerance without turning malformed output
// into an unbounded loop or allowing any command to escape validation.
const MALFORMED_JSON_RETRY_LIMIT = 1;

/** Creates an AgentModel that maps strict Messages API tool_use blocks into RunEngine turns. */
export function createAnthropicAgentModel(
  options: AnthropicAgentModelOptions
): AgentModel {
  if (options.model.trim() === "") {
    throw new Error("Anthropic model must not be empty");
  }
  const maxInputTokens = requirePositiveTokenLimit(
    options.maxInputTokens ?? 240_000,
    "Anthropic input token limit"
  );
  const maxOutputTokens = requirePositiveTokenLimit(
    options.maxOutputTokens ?? 16_000,
    "Anthropic output token limit"
  );
  validateRequestBudgetLifecycle(options);
  return {
    async next(input) {
      const latestResult = input.toolResults.at(-1);
      let continuationMessages: AnthropicMessage[] = [];
      if (latestResult) {
        const state = parsePersistedContinuation(
          latestResult.continuationId,
          latestResult.callId
        );
        continuationMessages = appendToolResult(state.messages, latestResult);
        const [nextCall, ...remainingCalls] = state.pendingCalls;
        if (nextCall) {
          // Provider batches are exposed one at a time so policy and side
          // effects stay serial; no provider I/O happens for queued calls.
          return toToolTurn(nextCall, {
            version: 1,
            messages: continuationMessages,
            activeCallId: nextCall.id,
            pendingCalls: remainingCalls
          });
        }
      }
      const request: AnthropicMessagesRequest = {
        model: options.model,
        max_tokens: maxOutputTokens,
        system: options.instructions ?? DEFAULT_INSTRUCTIONS,
        // The initial user content is rebuilt every turn so steering and project
        // instructions flow through alongside the task, and the continuation
        // messages append the stateless conversation tail in order.
        messages: [
          { role: "user", content: buildInitialUserContent(input) },
          ...continuationMessages
        ],
        tools: [
          structuredClone(EXECUTE_COMMAND_TOOL),
          structuredClone(REQUEST_USER_INPUT_TOOL),
          structuredClone(REQUEST_NETWORK_EGRESS_TOOL)
        ],
        tool_choice: { type: "auto" }
      };
      assertRequestInputWithinLimit(request, maxInputTokens);
      return requestValidatedTurn(
        () => options.client.create(request),
        (response) => parseMessagesResponse(response),
        options.onUsage,
        input.runId,
        options.onBeforeModelRetry,
        options.onMalformedJsonRetry,
        {
          maxInputTokens,
          maxOutputTokens,
          createRequestId: options.createRequestId ?? randomUUID,
          ...(options.onRequestStart
            ? { onRequestStart: options.onRequestStart }
            : {}),
          ...(options.onRequestFailure
            ? { onRequestFailure: options.onRequestFailure }
            : {})
        }
      );
    }
  };
}

async function requestValidatedTurn(
  create: () => Promise<unknown>,
  parse: (response: unknown) => AgentModelTurn,
  onUsage:
    | ((usage: AnthropicModelUsage) => void | Promise<void>)
    | undefined,
  runId: string,
  onBeforeModelRetry:
    | ((retry: AnthropicModelRetryRequest) => void | Promise<void>)
    | undefined,
  onMalformedJsonRetry:
    | ((event: AnthropicMalformedJsonRetryEvent) => void)
    | undefined,
  requestBudget: {
    maxInputTokens: number;
    maxOutputTokens: number;
    createRequestId: () => string;
    onRequestStart?: (
      request: AnthropicModelRequestReservation
    ) => void | Promise<void>;
    onRequestFailure?: (
      request: AnthropicModelRequestReference
    ) => void | Promise<void>;
  }
): Promise<AgentModelTurn> {
  let retryCount = 0;
  let initialFailureCategory: AnthropicMalformedJsonFailureCategory | undefined;
  for (;;) {
    const requestId = requestBudget.onRequestStart
      ? requestBudget.createRequestId()
      : undefined;
    let reservationStarted = false;
    let usageSettled = false;
    try {
      if (requestBudget.onRequestStart && requestId) {
        await requestBudget.onRequestStart({
          runId,
          requestId,
          maxInputTokens: requestBudget.maxInputTokens,
          maxOutputTokens: requestBudget.maxOutputTokens
        });
        reservationStarted = true;
      }
      const response = await create();
      // Bill every syntactically valid provider response, including one whose
      // tool arguments force a retry, so resilience cannot hide token spend.
      if (onUsage) {
        await onUsage({
          runId,
          ...(requestId ? { requestId } : {}),
          ...parseModelUsage(response)
        });
        usageSettled = true;
      }
      const turn = parse(response);
      if (initialFailureCategory) {
        emitMalformedJsonRetry(onMalformedJsonRetry, {
          runId,
          protocol: "anthropic_messages",
          retryCount,
          failureCategory: initialFailureCategory,
          outcome: "recovered"
        });
      }
      return turn;
    } catch (error) {
      if (
        requestId &&
        reservationStarted &&
        requestBudget.onRequestFailure &&
        !usageSettled
      ) {
        await requestBudget.onRequestFailure({ runId, requestId });
      }
      if (initialFailureCategory) {
        emitMalformedJsonRetry(onMalformedJsonRetry, {
          runId,
          protocol: "anthropic_messages",
          retryCount,
          failureCategory: initialFailureCategory,
          outcome: "exhausted"
        });
        throw error;
      }
      if (!(error instanceof AnthropicMalformedJsonError)) {
        throw error;
      }
      if (retryCount >= MALFORMED_JSON_RETRY_LIMIT) {
        throw error;
      }
      retryCount += 1;
      initialFailureCategory = error.category;
      // This awaited gate is authoritative across turns, processes, and retries;
      // telemetry below remains deliberately unable to authorize provider I/O.
      await onBeforeModelRetry?.({
        runId,
        protocol: "anthropic_messages",
        retryCount,
        failureCategory: initialFailureCategory
      });
      emitMalformedJsonRetry(onMalformedJsonRetry, {
        runId,
        protocol: "anthropic_messages",
        retryCount,
        failureCategory: initialFailureCategory,
        outcome: "retrying"
      });
      // No AgentModelTurn has escaped yet, so replaying the identical request
      // cannot approve or execute a provider-suggested command from the bad try.
    }
  }
}

function emitMalformedJsonRetry(
  observer: ((event: AnthropicMalformedJsonRetryEvent) => void) | undefined,
  event: AnthropicMalformedJsonRetryEvent
): void {
  try {
    observer?.(event);
  } catch {
    // Observability is best-effort and must never suppress or manufacture a turn.
  }
}

function parseModelUsage(value: unknown): Omit<AnthropicModelUsage, "runId"> {
  if (!isRecord(value) || !isRecord(value.usage)) {
    throw new Error("Anthropic response is missing token usage");
  }
  const input = value.usage.input_tokens;
  const output = value.usage.output_tokens;
  const cacheRead = value.usage.cache_read_input_tokens ?? 0;
  const cacheCreation = value.usage.cache_creation_input_tokens ?? 0;
  if (
    !Number.isSafeInteger(input) ||
    Number(input) < 0 ||
    !Number.isSafeInteger(output) ||
    Number(output) < 0 ||
    !Number.isSafeInteger(cacheRead) ||
    Number(cacheRead) < 0 ||
    !Number.isSafeInteger(cacheCreation) ||
    Number(cacheCreation) < 0
  ) {
    throw new Error("Anthropic response contains invalid token usage");
  }
  const totalInput = Number(input) + Number(cacheRead) + Number(cacheCreation);
  if (Number(cacheRead) > totalInput) {
    throw new Error("Anthropic response contains invalid token usage");
  }
  return {
    inputTokens: totalInput,
    outputTokens: Number(output),
    cachedInputTokens: Number(cacheRead)
  };
}

function buildInitialUserContent(input: AgentModelInput): string {
  // Project instructions are adapter-neutral content from AGENTS.md / CLAUDE.md,
  // so they belong in the user turn (not the system prompt) and must precede the task.
  return [
    ...formatProjectInstructions(input.projectInstructions),
    `Task: ${input.run.task}`,
    "",
    "Acceptance criteria:",
    ...input.run.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    ...formatSteeringSection(input.steeringMessages)
  ].join("\n");
}

function formatProjectInstructions(
  sections: string[] | undefined
): string[] {
  if (!sections || sections.length === 0) {
    return [];
  }
  return [
    "Project instructions:",
    ...sections.map((section) => section),
    ""
  ];
}

function formatSteeringSection(messages: string[] | undefined): string[] {
  const content = formatSteeringMessage(messages);
  return content ? ["", content] : [];
}

/**
 * Surfaces steering messages onto the Anthropic Messages payload when the
 * initial user message has already been replaced by a stateless resumption
 * (tool_result tool_use_id, continuation envelope). Anthropic's protocol has
 * no system override channel, so we append the steering as a follow-up user
 * turn so the model can still see the user's narrow constraints.
 */
function appendSteeringAsUserMessage(
  messages: AnthropicMessage[],
  steeringMessages: string[] | undefined
): AnthropicMessage[] {
  // The initial user content already includes steering in `buildInitialUserContent`,
  // so this helper is kept as a seam for future protocol-specific overrides
  // (for example, an OpenAI-style instructions channel) and is a no-op today.
  void messages;
  void steeringMessages;
  return messages;
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

/** Appends one tool result to the accumulating batch result user message. */
function appendToolResult(
  messages: AnthropicMessage[],
  result: ModelToolResult
): AnthropicMessage[] {
  const block: AnthropicToolResultBlock = {
    type: "tool_result",
    tool_use_id: result.callId,
    content: JSON.stringify(toolResultPayload(result))
  };
  const last = messages.at(-1);
  if (last && last.role === "user" && Array.isArray(last.content)) {
    return [
      ...messages.slice(0, -1),
      { role: "user", content: [...last.content, block] }
    ];
  }
  return [...messages, { role: "user", content: [block] }];
}

function toolResultPayload(
  result: ModelToolResult
): Record<string, unknown> {
  // Provider continuation metadata is transport state, never tool-visible output.
  if (result.status === "executed") {
    return {
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
  if (result.status === "authorized") {
    return {
      status: result.status,
      capabilityType: result.capabilityType,
      target: result.target
    };
  }
  if (result.status === "denied") {
    return { status: result.status, reason: result.reason };
  }
  return { status: result.status, value: result.value };
}

function toToolTurn(
  toolUse: AnthropicToolUseBlock,
  continuation: PersistedMessagesContinuation
): AgentModelTurn {
  if (toolUse.name === "request_user_input") {
    return {
      type: "user_request",
      requestId: toolUse.id,
      continuationId: JSON.stringify(continuation),
      prompt: parseUserQuestion(toolUse.input)
    };
  }
  if (toolUse.name === "request_network_egress") {
    return {
      type: "tool_call",
      callId: toolUse.id,
      continuationId: JSON.stringify(continuation),
      tool: "request_network_egress",
      arguments: parseNetworkEgressArguments(toolUse.input)
    };
  }
  return {
    type: "tool_call",
    callId: toolUse.id,
    // The versioned envelope survives Worker replacement and queues batches.
    continuationId: JSON.stringify(continuation),
    tool: "execute_command",
    arguments: parseCommandArguments(toolUse.input)
  };
}

function parsePersistedContinuation(
  continuationId: string | undefined,
  expectedCallId: string
): PersistedMessagesContinuation {
  if (!continuationId) {
    throw new Error("Anthropic tool result is missing its persisted continuation id");
  }
  let value: unknown;
  try {
    value = JSON.parse(continuationId);
  } catch {
    throw new Error("Anthropic continuation is invalid JSON");
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.messages) ||
    typeof value.activeCallId !== "string" ||
    !Array.isArray(value.pendingCalls)
  ) {
    throw new Error("Anthropic continuation must contain message history");
  }
  if (value.activeCallId !== expectedCallId) {
    throw new Error("Anthropic continuation does not match the tool result call id");
  }
  const messages = parsePersistedMessages(value.messages);
  const pendingCalls = value.pendingCalls.map((call) => parseToolUseBlock(call));
  validatePersistedQueue(messages, value.activeCallId, pendingCalls);
  return {
    version: 1,
    messages,
    activeCallId: value.activeCallId,
    pendingCalls
  };
}

function parsePersistedMessages(value: unknown[]): AnthropicMessage[] {
  if (value.length === 0) {
    throw new Error("Anthropic continuation must contain message history");
  }
  const messages: AnthropicMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      throw new Error("Anthropic continuation contains a malformed message");
    }
    if (item.role === "assistant") {
      if (!Array.isArray(item.content)) {
        throw new Error("Anthropic continuation contains a malformed message");
      }
      const blocks = item.content.map((block) => parseContentBlock(block));
      messages.push({ role: "assistant", content: blocks });
      continue;
    }
    if (item.role !== "user" || !Array.isArray(item.content)) {
      throw new Error("Anthropic continuation contains an unsupported message");
    }
    if (item.content.length === 0) {
      throw new Error("Anthropic continuation has an empty tool-result message");
    }
    const blocks = item.content.map((block) => parseToolResultBlock(block));
    messages.push({ role: "user", content: blocks });
  }
  return messages;
}

/** The completed results, active call, and pending queue must partition one batch. */
function validatePersistedQueue(
  messages: AnthropicMessage[],
  activeCallId: string,
  pendingCalls: AnthropicToolUseBlock[]
): void {
  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      assistantIndex = index;
      break;
    }
  }
  const assistant = messages[assistantIndex];
  // Assistant content is a string|blocks union; only block arrays carry a tool batch.
  const batch =
    assistant?.role === "assistant" && Array.isArray(assistant.content)
      ? assistant.content.filter(isToolUseBlock)
      : [];
  const batchIds = batch.map((call) => call.id);
  const activeIndex = batchIds.indexOf(activeCallId);
  const completedIds = messages
    .slice(assistantIndex + 1)
    .map((message) =>
      message.role === "user" && Array.isArray(message.content)
        ? message.content.map((block) => block.tool_use_id)
        : undefined
    )
    .flat();
  const expectedCompletedIds = batchIds.slice(0, activeIndex);
  const expectedPending = batch.slice(activeIndex + 1);
  const queueMatches =
    assistantIndex >= 0 &&
    new Set(batchIds).size === batchIds.length &&
    activeIndex >= 0 &&
    completedIds.every((id): id is string => id !== undefined) &&
    completedIds.length === expectedCompletedIds.length &&
    completedIds.every((id, index) => id === expectedCompletedIds[index]) &&
    pendingCalls.length === expectedPending.length &&
    pendingCalls.every(
      (call, index) => JSON.stringify(call) === JSON.stringify(expectedPending[index])
    );
  if (!queueMatches) {
    throw new Error("Anthropic continuation queue does not match its assistant batch");
  }
}

function parseMessagesResponse(value: unknown): AgentModelTurn {
  // Treat every provider field as untrusted until its runtime shape is proven.
  if (!isRecord(value) || !Array.isArray(value.content)) {
    throw new Error("Anthropic response content must be an array");
  }
  if (value.content.length === 0) {
    throw new Error("Anthropic response content must not be empty");
  }
  const stopReason = typeof value.stop_reason === "string" ? value.stop_reason : "";
  const blocks = value.content.map((block) => parseContentBlock(block));
  const toolUses = blocks.filter(isToolUseBlock);
  if (toolUses.length === 0) {
    if (stopReason !== "end_turn") {
      // max_tokens, refusal, and pause turns cannot prove the Run is complete.
      throw new Error(`Anthropic response stopped unexpectedly: ${stopReason}`);
    }
    const summary = blocks
      .filter(isTextBlock)
      .map((block) => block.text)
      .join("\n\n");
    if (summary.trim() === "") {
      throw new Error("Anthropic completed response is missing text");
    }
    return { type: "completed", summary };
  }
  if (stopReason !== "tool_use") {
    // A truncated batch would lose queued calls, so fail closed instead.
    throw new Error(`Anthropic tool response stopped unexpectedly: ${stopReason}`);
  }
  if (new Set(toolUses.map((call) => call.id)).size !== toolUses.length) {
    throw new Error("Anthropic response returned duplicate tool_use ids");
  }
  const [toolUse, ...pendingCalls] = toolUses;
  if (!toolUse) {
    throw new Error("Anthropic response is missing its tool_use block");
  }
  return toToolTurn(toolUse, {
    version: 1,
    messages: [{ role: "assistant", content: blocks }],
    activeCallId: toolUse.id,
    pendingCalls
  });
}

function parseContentBlock(value: unknown): AnthropicContentBlock {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Anthropic response contains a malformed content block");
  }
  if (value.type === "text") {
    if (typeof value.text !== "string") {
      throw new Error("Anthropic text block is missing its text");
    }
    return { type: "text", text: value.text };
  }
  if (value.type !== "tool_use") {
    throw new Error(`Anthropic response contains an unsupported block: ${value.type}`);
  }
  return parseToolUseBlock(value);
}

function parseToolUseBlock(value: unknown): AnthropicToolUseBlock {
  if (!isRecord(value) || value.type !== "tool_use") {
    throw new Error("Anthropic response contains a malformed tool_use block");
  }
  if (
    value.name !== "execute_command" &&
    value.name !== "request_user_input" &&
    value.name !== "request_network_egress"
  ) {
    throw new Error(`Anthropic response requested unsupported tool: ${String(value.name)}`);
  }
  if (typeof value.id !== "string" || value.id.trim() === "") {
    throw new Error("Anthropic tool_use block is missing its id");
  }
  // A compatible gateway may stringify JSON arguments; only that wire-level
  // malformation is replayable, while field-shape errors fail closed.
  if (typeof value.input === "string") {
    try {
      const parsed: unknown = JSON.parse(value.input);
      if (isRecord(parsed)) {
        return {
          type: "tool_use",
          id: value.id,
          name: value.name,
          input: parsed
        };
      }
    } catch {
      // fall through to the malformed-argument failure below
    }
    throw new AnthropicMalformedJsonError(
      "tool_arguments_invalid_json",
      "Anthropic tool_use input is not a JSON object"
    );
  }
  if (!isRecord(value.input)) {
    throw new AnthropicMalformedJsonError(
      "tool_arguments_invalid_json",
      "Anthropic tool_use input is not a JSON object"
    );
  }
  return {
    type: "tool_use",
    id: value.id,
    name: value.name,
    input: value.input
  };
}

function parseToolResultBlock(value: unknown): AnthropicToolResultBlock {
  if (
    !isRecord(value) ||
    value.type !== "tool_result" ||
    typeof value.tool_use_id !== "string" ||
    value.tool_use_id.trim() === "" ||
    typeof value.content !== "string"
  ) {
    throw new Error("Anthropic continuation contains a malformed tool result");
  }
  return {
    type: "tool_result",
    tool_use_id: value.tool_use_id,
    content: value.content
  };
}

function isToolUseBlock(value: AnthropicContentBlock): value is AnthropicToolUseBlock {
  return value.type === "tool_use";
}

function isTextBlock(
  value: AnthropicContentBlock
): value is { type: "text"; text: string } {
  return value.type === "text";
}

function parseUserQuestion(input: Record<string, unknown>): string {
  if (
    Object.keys(input).some((key) => key !== "question") ||
    typeof input.question !== "string" ||
    input.question.trim() === ""
  ) {
    throw new Error("Anthropic request_user_input arguments must contain one question");
  }
  return input.question;
}

function parseCommandArguments(input: Record<string, unknown>): { argv: string[] } {
  if (
    Object.keys(input).some((key) => key !== "argv") ||
    !Array.isArray(input.argv) ||
    input.argv.length === 0 ||
    !input.argv.every((argument) => typeof argument === "string")
  ) {
    throw new Error("Anthropic execute_command arguments must contain only non-empty argv");
  }
  return { argv: input.argv };
}

function parseNetworkEgressArguments(input: Record<string, unknown>): {
  scheme: "https";
  domain: string;
  port: number;
  purpose: string;
} {
  if (
    Object.keys(input).some(
      (key) => !["scheme", "domain", "port", "purpose"].includes(key)
    ) ||
    input.scheme !== "https" ||
    typeof input.domain !== "string" ||
    input.domain.trim() === "" ||
    input.domain.length > 253 ||
    !Number.isSafeInteger(input.port) ||
    (input.port as number) < 1 ||
    (input.port as number) > 65_535 ||
    typeof input.purpose !== "string" ||
    input.purpose.trim() === "" ||
    input.purpose.length > 500
  ) {
    throw new Error("Anthropic request_network_egress arguments are invalid");
  }
  return {
    scheme: "https",
    domain: input.domain.trim().toLowerCase(),
    port: input.port as number,
    purpose: input.purpose.trim()
  };
}

function requirePositiveTokenLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function validateRequestBudgetLifecycle(options: {
  onUsage?: (usage: AnthropicModelUsage) => void | Promise<void>;
  onRequestStart?: (request: AnthropicModelRequestReservation) => void | Promise<void>;
  onRequestFailure?: (request: AnthropicModelRequestReference) => void | Promise<void>;
}): void {
  const configured = [
    options.onRequestStart,
    options.onRequestFailure
  ].filter(Boolean).length;
  if (configured !== 0 && (configured !== 2 || !options.onUsage)) {
    throw new Error(
      "Anthropic request budgeting requires start, usage, and failure lifecycle hooks"
    );
  }
}

function assertRequestInputWithinLimit(
  request: AnthropicMessagesRequest,
  maxInputTokens: number
): void {
  /* Every compatible tokenizer token must consume input bytes, while exact
   * tokenizers differ by vendor. UTF-8 bytes therefore provide a provider-neutral
   * safe ceiling. */
  const inputBytes = new TextEncoder().encode(
    JSON.stringify({
      system: request.system,
      messages: request.messages,
      tools: request.tools
    })
  ).byteLength;
  if (inputBytes > maxInputTokens) {
    throw new Error("Anthropic request input exceeds the configured token limit");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string): string {
  // Remote plaintext endpoints would expose the API key in transit.
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Anthropic base URL must use HTTP or HTTPS");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol === "http:" && !loopbackHosts.has(url.hostname)) {
    throw new Error("Remote Anthropic base URL must use HTTPS");
  }
  return url.toString().replace(/\/+$/u, "");
}
