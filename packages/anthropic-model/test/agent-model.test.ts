import { describe, expect, it } from "vitest";
import type { AgentModelInput, ModelToolResult } from "@lecoding/run-engine";
import {
  createAnthropicAgentModel,
  type AnthropicMessagesClient,
  type AnthropicMessagesRequest,
  type AnthropicModelUsage
} from "../src/index.js";

/** Minimal Run input shared by every AgentModel turn-mapping test. */
function baseInput(toolResults: ModelToolResult[] = []): AgentModelInput {
  return {
    runId: "run-1",
    run: {
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Fix the API",
      acceptanceCriteria: ["Tests pass"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    },
    toolResults
  };
}

/** A successful text-only Messages response in the end_turn shape. */
function textResponse(text: string): unknown {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 20 }
  };
}

/** A tool_use response carrying exactly one command invocation. */
function toolUseResponse(
  id: string,
  input: Record<string, unknown>
): unknown {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "Running the suite" },
      { type: "tool_use", id, name: "execute_command", input }
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 110, output_tokens: 30 }
  };
}

describe("createAnthropicAgentModel", () => {
  it("emits a completed turn from a text-only response and settles usage", async () => {
    const requests: AnthropicMessagesRequest[] = [];
    const usage: AnthropicModelUsage[] = [];
    const model = createAnthropicAgentModel({
      model: "claude-test",
      client: {
        async create(request) {
          requests.push(request);
          return textResponse("Implemented and verified");
        }
      },
      onUsage: async (observation) => {
        usage.push(observation);
      }
    });

    const turn = await model.next({
      ...baseInput(),
      steeringMessages: ["Keep response error codes unchanged"]
    });

    expect(turn).toEqual({ type: "completed", summary: "Implemented and verified" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "claude-test",
      max_tokens: 16_000,
      tool_choice: { type: "auto" }
    });
    // The initial user message always carries task, criteria, and full steering.
    expect(requests[0]!.messages).toEqual([
      {
        role: "user",
        content: [
          "Task: Fix the API",
          "",
          "Acceptance criteria:",
          "- Tests pass",
          "",
          "Additional user instructions:",
          "- Keep response error codes unchanged"
        ].join("\n")
      }
    ]);
    expect(requests[0]!.tools.map((tool) => tool.name)).toEqual([
      "execute_command",
      "request_user_input",
      "request_network_egress"
    ]);
    expect(usage).toEqual([
      {
        runId: "run-1",
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 0
      }
    ]);
  });

  it("maps an execute_command tool_use into a serial tool_call with a persisted envelope", async () => {
    const model = createAnthropicAgentModel({
      model: "claude-test",
      client: {
        async create() {
          return toolUseResponse("toolu_1", { argv: ["pnpm", "test"] });
        }
      }
    });

    const turn = await model.next(baseInput());

    expect(turn).toMatchObject({
      type: "tool_call",
      callId: "toolu_1",
      tool: "execute_command",
      arguments: { argv: ["pnpm", "test"] }
    });
    if (turn.type !== "tool_call" || !turn.continuationId) {
      throw new Error("Expected a persisted continuation envelope");
    }
    // The envelope survives Worker replacement and keeps the assistant batch.
    expect(JSON.parse(turn.continuationId)).toEqual({
      version: 1,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Running the suite" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "execute_command",
              input: { argv: ["pnpm", "test"] }
            }
          ]
        }
      ],
      activeCallId: "toolu_1",
      pendingCalls: []
    });
  });

  it("maps a request_user_input tool_use into a user_request turn with the persisted envelope", async () => {
    const model = createAnthropicAgentModel({
      model: "claude-test",
      client: {
        async create() {
          return {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [
              { type: "text", text: "Need clarification" },
              {
                type: "tool_use",
                id: "toolu_2",
                name: "request_user_input",
                input: { question: "Which API version?" }
              }
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 90, output_tokens: 12 }
          };
        }
      }
    });

    const turn = await model.next(baseInput());

    expect(turn).toMatchObject({
      type: "user_request",
      requestId: "toolu_2",
      prompt: "Which API version?"
    });
    if (turn.type !== "user_request" || !turn.continuationId) {
      throw new Error("Expected a persisted continuation envelope");
    }
    expect(JSON.parse(turn.continuationId)).toMatchObject({
      version: 1,
      activeCallId: "toolu_2",
      pendingCalls: [],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Need clarification" },
            {
              type: "tool_use",
              id: "toolu_2",
              name: "request_user_input",
              input: { question: "Which API version?" }
            }
          ]
        }
      ]
    });
  });

  it("resumes after a user answer by reposting the user prompt and full history", async () => {
    const requests: AnthropicMessagesRequest[] = [];
    const responses: unknown[] = [
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "Need clarification" },
          {
            type: "tool_use",
            id: "toolu_2",
            name: "request_user_input",
            input: { question: "Which API version?" }
          }
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 90, output_tokens: 12 }
      },
      textResponse("Implemented and verified")
    ];
    const model = createAnthropicAgentModel({
      model: "claude-test",
      client: {
        async create(request) {
          requests.push(request);
          const response = responses.shift();
          if (!response) throw new Error("Unexpected model call");
          return response;
        }
      }
    });

    const first = await model.next(baseInput());
    if (first.type !== "user_request" || !first.continuationId) {
      throw new Error("Expected the first user request turn");
    }
    const second = await model.next(
      baseInput([
        {
          callId: "toolu_2",
          continuationId: first.continuationId,
          status: "answered",
          value: "Keep v1"
        }
      ])
    );

    expect(second).toEqual({
      type: "completed",
      summary: "Implemented and verified"
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages).toEqual([
      {
        role: "user",
        content: [
          "Task: Fix the API",
          "",
          "Acceptance criteria:",
          "- Tests pass"
        ].join("\n")
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Need clarification" },
          {
            type: "tool_use",
            id: "toolu_2",
            name: "request_user_input",
            input: { question: "Which API version?" }
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: '{"status":"answered","value":"Keep v1"}'
          }
        ]
      }
    ]);
  });

  it("maps a request_network_egress tool_use into a tool_call with validated shape", async () => {
    const model = createAnthropicAgentModel({
      model: "claude-test",
      client: {
        async create() {
          return {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [
              { type: "text", text: "Need to fetch dependency" },
              {
                type: "tool_use",
                id: "toolu_3",
                name: "request_network_egress",
                input: {
                  scheme: "https",
                  domain: "Registry.NPMJS.org",
                  port: 443,
                  purpose: " Resolve reviewed dependencies "
                }
              }
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 95, output_tokens: 18 }
          };
        }
      }
    });

    const turn = await model.next(baseInput());

    expect(turn).toMatchObject({
      type: "tool_call",
      callId: "toolu_3",
      tool: "request_network_egress"
    });
    if (turn.type !== "tool_call" || !turn.continuationId) {
      throw new Error("Expected a persisted continuation envelope");
    }
    expect(turn.arguments).toEqual({
      scheme: "https",
      domain: "registry.npmjs.org",
      port: 443,
      purpose: "Resolve reviewed dependencies"
    });
    expect(JSON.parse(turn.continuationId)).toMatchObject({
      version: 1,
      activeCallId: "toolu_3",
      pendingCalls: [],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Need to fetch dependency" },
            {
              type: "tool_use",
              id: "toolu_3",
              name: "request_network_egress",
              input: {
                scheme: "https",
                domain: "Registry.NPMJS.org",
                port: 443,
                purpose: " Resolve reviewed dependencies "
              }
            }
          ]
        }
      ]
    });
  });

  it("continues a tool result through the envelope and resends the full history", async () => {
    const requests: AnthropicMessagesRequest[] = [];
    const responses: unknown[] = [
      toolUseResponse("toolu_1", { argv: ["pnpm", "test"] }),
      textResponse("Implemented and verified")
    ];
    const model = createAnthropicAgentModel({
      model: "claude-test",
      client: {
        async create(request) {
          requests.push(request);
          const response = responses.shift();
          if (!response) throw new Error("Unexpected model call");
          return response;
        }
      }
    });

    const first = await model.next(baseInput());
    if (first.type !== "tool_call" || !first.continuationId) {
      throw new Error("Expected the first tool call turn");
    }
    const second = await model.next(
      baseInput([
        {
          callId: "toolu_1",
          continuationId: first.continuationId,
          status: "executed",
          exitCode: 0,
          stdout: "ok",
          stderr: ""
        }
      ])
    );

    expect(second).toEqual({ type: "completed", summary: "Implemented and verified" });
    expect(requests).toHaveLength(2);
    // Stateless protocol: every request resends system, initial task, and history.
    expect(requests[1]!.messages).toEqual([
      {
        role: "user",
        content: [
          "Task: Fix the API",
          "",
          "Acceptance criteria:",
          "- Tests pass"
        ].join("\n")
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running the suite" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "execute_command",
            input: { argv: ["pnpm", "test"] }
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: '{"status":"executed","exitCode":0,"stdout":"ok","stderr":""}'
          }
        ]
      }
    ]);
  });

  it("rejects an unsupported tool name without producing a turn", async () => {
    const model = createAnthropicAgentModel({
      model: "claude-test",
      client: {
        async create() {
          return {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_unknown",
                name: "execute_arbitrary_shell",
                input: { argv: ["rm", "-rf", "/"] }
              }
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 5, output_tokens: 5 }
          };
        }
      }
    });

    await expect(model.next(baseInput())).rejects.toThrow(/unsupported tool/);
  });

  it("rejects a malformed execute_command payload without producing a turn", async () => {
    const model = createAnthropicAgentModel({
      model: "claude-test",
      client: {
        async create() {
          return {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_bad",
                name: "execute_command",
                input: { argv: "pnpm test" }
              }
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 5, output_tokens: 5 }
          };
        }
      }
    });

    await expect(model.next(baseInput())).rejects.toThrow(
      /execute_command arguments must contain only non-empty argv/
    );
  });

  it("rejects a request_network_egress with a non-https scheme", async () => {
    const model = createAnthropicAgentModel({
      model: "claude-test",
      client: {
        async create() {
          return {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_http",
                name: "request_network_egress",
                input: {
                  scheme: "http",
                  domain: "example.com",
                  port: 80,
                  purpose: "Fetch docs"
                }
              }
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 5, output_tokens: 5 }
          };
        }
      }
    });

    await expect(model.next(baseInput())).rejects.toThrow(
      /request_network_egress arguments are invalid/
    );
  });

  it("rejects duplicate tool_use ids in the same batch", async () => {
    const model = createAnthropicAgentModel({
      model: "claude-test",
      client: {
        async create() {
          return {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_dup",
                name: "execute_command",
                input: { argv: ["pnpm", "test"] }
              },
              {
                type: "tool_use",
                id: "toolu_dup",
                name: "execute_command",
                input: { argv: ["pnpm", "lint"] }
              }
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 5, output_tokens: 5 }
          };
        }
      }
    });

    await expect(model.next(baseInput())).rejects.toThrow(/duplicate tool_use ids/);
  });

  it("rejects a text-only response when stop_reason is not end_turn", async () => {
    const model = createAnthropicAgentModel({
      model: "claude-test",
      client: {
        async create() {
          return {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Truncated" }],
            stop_reason: "max_tokens",
            usage: { input_tokens: 5, output_tokens: 5 }
          };
        }
      }
    });

    await expect(model.next(baseInput())).rejects.toThrow(
      /response stopped unexpectedly/
    );
  });

  it("rejects a response missing token usage when usage is observed", async () => {
    const model = createAnthropicAgentModel({
      model: "claude-test",
      onUsage: () => {
        // usage observation forces validation so spend cannot be hidden.
      },
      client: {
        async create() {
          return {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
            stop_reason: "end_turn"
          };
        }
      }
    });

    await expect(model.next(baseInput())).rejects.toThrow(/missing token usage/);
  });

  it("rejects partial budget lifecycle hook configuration", () => {
    expect(() =>
      createAnthropicAgentModel({
        model: "claude-test",
        client: {
          async create() {
            return textResponse("done");
          }
        },
        onUsage: () => {
          // observation alone is not a complete budget lifecycle contract.
        },
        onRequestStart: () => {
          // partial configuration must fail closed instead of silently billing.
        }
      })
    ).toThrow(/start, usage, and failure lifecycle hooks/);
  });

  it("reserves and releases the budget across a successful provider round trip", async () => {
    const reservations: Array<{
      runId: string;
      requestId: string;
      maxInputTokens: number;
      maxOutputTokens: number;
    }> = [];
    const failures: Array<{ runId: string; requestId: string }> = [];
    let count = 0;
    const model = createAnthropicAgentModel({
      model: "claude-test",
      onUsage: () => {
        // budget lifecycle forces usage observation too.
      },
      onRequestStart: async (reservation) => {
        reservations.push(reservation);
      },
      onRequestFailure: async (reference) => {
        failures.push(reference);
      },
      client: {
        async create() {
          count += 1;
          return count === 1
            ? toolUseResponse("toolu_1", { argv: ["pnpm", "test"] })
            : textResponse("Implemented and verified");
        }
      }
    });

    const first = await model.next(baseInput());
    if (first.type !== "tool_call" || !first.continuationId) {
      throw new Error("Expected the first tool call turn with a continuation envelope");
    }
    await model.next(
      baseInput([
        {
          callId: "toolu_1",
          continuationId: first.continuationId,
          status: "executed",
          exitCode: 0,
          stdout: "ok",
          stderr: ""
        }
      ])
    );

    expect(reservations).toHaveLength(2);
    expect(reservations[0]).toMatchObject({
      runId: "run-1",
      maxInputTokens: 240_000,
      maxOutputTokens: 16_000
    });
    expect(new Set(reservations.map((r) => r.requestId)).size).toBe(2);
    expect(failures).toEqual([]);
  });

  it("releases the budget when the provider call throws before any usage is billed", async () => {
    const reservations: Array<{ requestId: string }> = [];
    const failures: Array<{ runId: string; requestId: string }> = [];
    const model = createAnthropicAgentModel({
      model: "claude-test",
      onUsage: () => {
        // intentionally unused
      },
      onRequestStart: async (reservation) => {
        reservations.push({ requestId: reservation.requestId });
      },
      onRequestFailure: async (reference) => {
        failures.push(reference);
      },
      client: {
        async create() {
          throw new Error("upstream failure");
        }
      }
    });

    await expect(model.next(baseInput())).rejects.toThrow(/upstream failure/);
    expect(reservations).toHaveLength(1);
    expect(failures).toEqual([
      { runId: "run-1", requestId: reservations[0]!.requestId }
    ]);
  });

  it("retries a stringified tool_use input once, settles usage for both responses, and awaits onBeforeModelRetry", async () => {
    let requestCount = 0;
    const observedUsage: AnthropicModelUsage[] = [];
    const retryEvents: unknown[] = [];
    const beforeRetryCalls: unknown[] = [];
    const model = createAnthropicAgentModel({
      model: "claude-test",
      onUsage: async (usage) => {
        observedUsage.push(usage);
      },
      onBeforeModelRetry: async (retry) => {
        beforeRetryCalls.push(retry);
      },
      onMalformedJsonRetry: (event) => retryEvents.push(event),
      client: {
        async create() {
          requestCount += 1;
          return {
            id: `msg_${requestCount}`,
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: `toolu_${requestCount}`,
                name: "execute_command",
                input:
                  requestCount === 1
                    ? '{"argv":["pnpm","test"]'
                    : '{"argv":["pnpm","test"]}'
              }
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 10 * requestCount, output_tokens: requestCount }
          };
        }
      }
    });

    const turn = await model.next(baseInput());

    expect(turn).toMatchObject({
      type: "tool_call",
      callId: "toolu_2",
      tool: "execute_command",
      arguments: { argv: ["pnpm", "test"] }
    });
    expect(requestCount).toBe(2);
    expect(observedUsage).toHaveLength(2);
    expect(observedUsage[0]).toEqual({
      runId: "run-1",
      inputTokens: 10,
      outputTokens: 1,
      cachedInputTokens: 0
    });
    expect(observedUsage[1]).toEqual({
      runId: "run-1",
      inputTokens: 20,
      outputTokens: 2,
      cachedInputTokens: 0
    });
    expect(beforeRetryCalls).toEqual([
      {
        runId: "run-1",
        protocol: "anthropic_messages",
        retryCount: 1,
        failureCategory: "tool_arguments_invalid_json"
      }
    ]);
    expect(retryEvents).toEqual([
      {
        runId: "run-1",
        protocol: "anthropic_messages",
        retryCount: 1,
        failureCategory: "tool_arguments_invalid_json",
        outcome: "retrying"
      },
      {
        runId: "run-1",
        protocol: "anthropic_messages",
        retryCount: 1,
        failureCategory: "tool_arguments_invalid_json",
        outcome: "recovered"
      }
    ]);
  });

  it("emits exhausted retry telemetry and throws after the malformed-JSON retry is consumed", async () => {
    let requestCount = 0;
    const retryEvents: unknown[] = [];
    const beforeRetryCalls: unknown[] = [];
    const model = createAnthropicAgentModel({
      model: "claude-test",
      onUsage: () => {
        // no usage observation needed for retry-exhaustion telemetry
      },
      onBeforeModelRetry: async (retry) => {
        beforeRetryCalls.push(retry);
      },
      onMalformedJsonRetry: (event) => retryEvents.push(event),
      client: {
        async create() {
          requestCount += 1;
          return {
            id: `msg_${requestCount}`,
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: `toolu_${requestCount}`,
                name: "execute_command",
                input: '{"argv":["pnpm","test"]'
              }
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 1 }
          };
        }
      }
    });

    await expect(model.next(baseInput())).rejects.toThrow(
      /tool_use input is not a JSON object/
    );
    expect(requestCount).toBe(2);
    expect(beforeRetryCalls).toEqual([
      {
        runId: "run-1",
        protocol: "anthropic_messages",
        retryCount: 1,
        failureCategory: "tool_arguments_invalid_json"
      }
    ]);
    expect(retryEvents).toEqual([
      {
        runId: "run-1",
        protocol: "anthropic_messages",
        retryCount: 1,
        failureCategory: "tool_arguments_invalid_json",
        outcome: "retrying"
      },
      {
        runId: "run-1",
        protocol: "anthropic_messages",
        retryCount: 1,
        failureCategory: "tool_arguments_invalid_json",
        outcome: "exhausted"
      }
    ]);
  });

it("prepends project instructions to the initial user message before the task", async () => {
    const requests: AnthropicMessagesRequest[] = [];
    const model = createAnthropicAgentModel({
      model: "claude-test",
      client: {
        async create(request) {
          requests.push(request);
          return textResponse("Acknowledged project rules");
        }
      }
    });

    await model.next({
      ...baseInput(),
      projectInstructions: [
        "Project policy",
        "API rules"
      ]
    });

    expect(requests[0]!.messages[0]).toEqual({
      role: "user",
      content: [
        "Project instructions:",
        "Project policy",
        "API rules",
        "",
        "Task: Fix the API",
        "",
        "Acceptance criteria:",
        "- Tests pass"
      ].join("\n")
    });
  });

it("settles usage with cache tokens folded into inputTokens and cachedInputTokens carried over", async () => {
    const observed: AnthropicModelUsage[] = [];
    const model = createAnthropicAgentModel({
      model: "claude-test",
      onUsage: async (usage) => {
        observed.push(usage);
      },
      client: {
        async create() {
          return {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 80,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 5,
              output_tokens: 20
            }
          };
        }
      }
    });

    await model.next(baseInput());
    expect(observed).toEqual([
      {
        runId: "run-1",
        inputTokens: 115,
        outputTokens: 20,
        cachedInputTokens: 30
      }
    ]);
  });
});
