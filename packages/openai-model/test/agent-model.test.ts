import { describe, expect, it } from "vitest";
import type { AgentModelInput, ModelToolResult } from "@lecoding/run-engine";
import {
  createOpenAiChatCompletionsAgentModel,
  createOpenAiResponsesAgentModel,
  type OpenAiChatCompletionsRequest,
  type OpenAiResponsesRequest
} from "../src/index.js";

describe("createOpenAiResponsesAgentModel", () => {
  it("turns one strict execute_command function call into an AgentModel turn", async () => {
    const requests: OpenAiResponsesRequest[] = [];
    const model = createOpenAiResponsesAgentModel({
      model: "gpt-test",
      client: {
        async create(request) {
          requests.push(request);
          return {
            id: "resp-1",
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: "call-1",
                name: "execute_command",
                arguments: '{"argv":["pnpm","test"]}'
              }
            ]
          };
        }
      }
    });

    await expect(
      model.next({
        runId: "run-1",
        run: {
          projectId: "project-1",
          environmentId: "environment-1",
          task: "Fix the failing tests",
          acceptanceCriteria: ["pnpm test passes"],
          approvalMode: "auto_review",
          fileAccessScope: "workspace_only"
        },
        toolResults: []
      })
    ).resolves.toEqual({
      type: "tool_call",
      callId: "call-1",
      continuationId: "resp-1",
      tool: "execute_command",
      arguments: { argv: ["pnpm", "test"] }
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "gpt-test",
      parallel_tool_calls: false,
      store: true,
      tool_choice: "auto"
    });
    expect(requests[0]?.instructions).toContain(
      "argv[0] is exactly one executable"
    );
    expect(requests[0]?.instructions).toContain(
      "Git metadata is intentionally unavailable"
    );
    expect(requests[0]?.instructions).toContain(
      "minimize exploratory commands"
    );
    expect(requests[0]?.instructions).toContain(
      "do not execute acceptance verification commands"
    );
    expect(requests[0]?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          name: "execute_command",
          strict: true,
          parameters: expect.objectContaining({
            type: "object",
            additionalProperties: false,
            required: ["argv"]
          })
        }),
        expect.objectContaining({ name: "request_user_input" })
      ])
    );
  });

  it("retries malformed Responses tool JSON once and accounts for both responses", async () => {
    let requestCount = 0;
    const observedUsage: Array<{ inputTokens: number; outputTokens: number }> = [];
    const model = createOpenAiResponsesAgentModel({
      model: "gpt-test",
      onUsage: (usage) => observedUsage.push(usage),
      client: {
        async create() {
          requestCount += 1;
          return {
            id: `resp-${requestCount}`,
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: `call-${requestCount}`,
                name: "execute_command",
                arguments:
                  requestCount === 1
                    ? '{"argv":["node","--test"]'
                    : '{"argv":["node","--test"]}'
              }
            ],
            usage: { input_tokens: 10 * requestCount, output_tokens: requestCount }
          };
        }
      }
    });

    await expect(model.next(baseInput([]))).resolves.toMatchObject({
      type: "tool_call",
      callId: "call-2",
      continuationId: "resp-2",
      arguments: { argv: ["node", "--test"] }
    });
    expect(observedUsage).toEqual([
      { inputTokens: 10, outputTokens: 1 },
      { inputTokens: 20, outputTokens: 2 }
    ]);
  });

  it("maps a strict user-input request and its answer continuation", async () => {
    const requests: OpenAiResponsesRequest[] = [];
    const model = createOpenAiResponsesAgentModel({
      model: "gpt-test",
      client: {
        async create(request) {
          requests.push(request);
          return requests.length === 1
            ? {
                id: "resp-question",
                status: "completed",
                output: [
                  {
                    type: "function_call",
                    call_id: "question-1",
                    name: "request_user_input",
                    arguments: '{"question":"Which API version?"}'
                  }
                ]
              }
            : {
                id: "resp-done",
                status: "completed",
                output: [],
                output_text: "Done"
              };
        }
      }
    });

    await expect(model.next(baseInput([]))).resolves.toEqual({
      type: "user_request",
      requestId: "question-1",
      continuationId: "resp-question",
      prompt: "Which API version?"
    });
    await model.next(
      baseInput([
        {
          callId: "question-1",
          continuationId: "resp-question",
          status: "answered",
          value: "Keep v1"
        }
      ])
    );
    expect(requests[1]).toMatchObject({
      previous_response_id: "resp-question",
      input: [
        {
          type: "function_call_output",
          call_id: "question-1",
          output: '{"status":"answered","value":"Keep v1"}'
        }
      ]
    });
  });

  it("maps Chat Completions request_user_input calls", async () => {
    const model = createOpenAiChatCompletionsAgentModel({
      model: "chat-test",
      client: {
        async create() {
          return {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "question-chat",
                      type: "function",
                      function: {
                        name: "request_user_input",
                        arguments: '{"question":"Which target?"}'
                      }
                    }
                  ]
                }
              }
            ]
          };
        }
      }
    });

    await expect(model.next(baseInput([]))).resolves.toMatchObject({
      type: "user_request",
      requestId: "question-chat",
      prompt: "Which target?"
    });
  });

  it("retries malformed Chat Completions tool JSON once before exposing an action", async () => {
    let requestCount = 0;
    const model = createOpenAiChatCompletionsAgentModel({
      model: "chat-test",
      client: {
        async create() {
          requestCount += 1;
          return {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: `call-${requestCount}`,
                      type: "function",
                      function: {
                        name: "execute_command",
                        arguments:
                          requestCount === 1
                            ? '{"argv":["pnpm","test"]'
                            : '{"argv":["pnpm","test"]}'
                      }
                    }
                  ]
                }
              }
            ]
          };
        }
      }
    });

    await expect(model.next(baseInput([]))).resolves.toMatchObject({
      type: "tool_call",
      callId: "call-2",
      arguments: { argv: ["pnpm", "test"] }
    });
    expect(requestCount).toBe(2);
  });

  it("fails closed after the single malformed tool JSON retry is exhausted", async () => {
    let requestCount = 0;
    const model = createOpenAiChatCompletionsAgentModel({
      model: "chat-test",
      client: {
        async create() {
          requestCount += 1;
          return {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: `call-${requestCount}`,
                      type: "function",
                      function: {
                        name: "execute_command",
                        arguments: '{"argv":["pnpm","test"]'
                      }
                    }
                  ]
                }
              }
            ]
          };
        }
      }
    });

    await expect(model.next(baseInput([]))).rejects.toThrow(
      "OpenAI execute_command arguments are invalid JSON"
    );
    expect(requestCount).toBe(2);
  });

  it("does not retry syntactically valid tool JSON that violates the command schema", async () => {
    let requestCount = 0;
    const model = createOpenAiChatCompletionsAgentModel({
      model: "chat-test",
      client: {
        async create() {
          requestCount += 1;
          return {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call-invalid-schema",
                      type: "function",
                      function: {
                        name: "execute_command",
                        arguments: '{"argv":"pnpm test"}'
                      }
                    }
                  ]
                }
              }
            ]
          };
        }
      }
    });

    await expect(model.next(baseInput([]))).rejects.toThrow(
      "OpenAI execute_command arguments must contain only non-empty argv"
    );
    expect(requestCount).toBe(1);
  });

  it("forwards staged steering to Responses continuation input", async () => {
    const requests: OpenAiResponsesRequest[] = [];
    const model = createOpenAiResponsesAgentModel({
      model: "gpt-test",
      client: {
        async create(request) {
          requests.push(request);
          return {
            id: "resp-after-steer",
            status: "completed",
            output: [],
            output_text: "Done"
          };
        }
      }
    });

    await model.next({
      ...baseInput([
        {
          callId: "call-1",
          continuationId: "resp-before-steer",
          status: "executed",
          exitCode: 0,
          stdout: "ok",
          stderr: ""
        }
      ]),
      steeringMessages: ["Keep the legacy error payload"]
    });

    expect(requests[0]).toMatchObject({
      previous_response_id: "resp-before-steer",
      input: [
        expect.objectContaining({ type: "function_call_output", call_id: "call-1" }),
        {
          role: "user",
          content: "Additional user instructions:\n- Keep the legacy error payload"
        }
      ]
    });
  });

  it("appends staged steering to the Chat Completions user message", async () => {
    const requests: OpenAiChatCompletionsRequest[] = [];
    const model = createOpenAiChatCompletionsAgentModel({
      model: "chat-test",
      client: {
        async create(request) {
          requests.push(request);
          return {
            choices: [{ message: { content: "Done" } }]
          };
        }
      }
    });

    await model.next({
      ...baseInput([]),
      steeringMessages: ["Preserve response error codes"]
    });

    expect(requests[0]?.messages).toContainEqual({
      role: "user",
      content: expect.stringContaining(
        "Additional user instructions:\n- Preserve response error codes"
      )
    });
  });

  it("continues from the persisted response id and returns a completed turn", async () => {
    const requests: OpenAiResponsesRequest[] = [];
    const model = createOpenAiResponsesAgentModel({
      model: "gpt-test",
      client: {
        async create(request) {
          requests.push(request);
          return {
            id: "resp-2",
            status: "completed",
            output: [],
            output_text: "Implemented and verified the change"
          };
        }
      }
    });

    await expect(
      model.next({
        runId: "run-1",
        run: {
          projectId: "project-1",
          environmentId: "environment-1",
          task: "Fix the failing tests",
          acceptanceCriteria: ["pnpm test passes"],
          approvalMode: "auto_review",
          fileAccessScope: "workspace_only"
        },
        toolResults: [
          {
            callId: "call-1",
            continuationId: "resp-1",
            status: "executed",
            exitCode: 0,
            stdout: "ok",
            stderr: ""
          }
        ]
      })
    ).resolves.toEqual({
      type: "completed",
      summary: "Implemented and verified the change"
    });
    expect(requests[0]).toMatchObject({
      previous_response_id: "resp-1",
      input: [
        {
          type: "function_call_output",
          call_id: "call-1",
          output:
            '{"status":"executed","exitCode":0,"stdout":"ok","stderr":""}'
        }
      ]
    });
  });

  it("rejects malformed command arguments at the provider trust boundary", async () => {
    const model = createOpenAiResponsesAgentModel({
      model: "gpt-test",
      client: {
        async create() {
          return {
            id: "resp-invalid",
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: "call-invalid",
                name: "execute_command",
                arguments: '{"argv":"pnpm test"}'
              }
            ]
          };
        }
      }
    });

    await expect(
      model.next({
        runId: "run-1",
        run: {
          projectId: "project-1",
          environmentId: "environment-1",
          task: "Fix the failing tests",
          acceptanceCriteria: ["pnpm test passes"],
          approvalMode: "auto_review",
          fileAccessScope: "workspace_only"
        },
        toolResults: []
      })
    ).rejects.toThrow(
      "OpenAI execute_command arguments must contain only non-empty argv"
    );
  });
});

function baseInput(toolResults: ModelToolResult[]): AgentModelInput {
  return {
    runId: "run-1",
    run: {
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Fix the API",
      acceptanceCriteria: ["Tests pass"],
      approvalMode: "manual" as const,
      fileAccessScope: "workspace_only" as const
    },
    toolResults
  };
}
