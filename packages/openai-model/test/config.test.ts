import { describe, expect, it } from "vitest";
import {
  createOpenAiCompatibleAgentModel,
  loadOpenAiCompatibleModelConfig,
  type OpenAiFetchInit
} from "../src/index.js";

describe("loadOpenAiCompatibleModelConfig", () => {
  it("preserves request budgeting hooks through provider-neutral composition", async () => {
    const lifecycle: string[] = [];
    const model = createOpenAiCompatibleAgentModel({
      config: {
        protocol: "openai_responses",
        baseUrl: "https://model.vendor.example/v1",
        apiKey: "vendor-secret",
        model: "vendor-coder-v2"
      },
      maxInputTokens: 240_000,
      maxOutputTokens: 4_000,
      createRequestId: () => "compatible-request-1",
      onRequestStart: async ({ requestId }) => {
        lifecycle.push(`reserve:${requestId}`);
      },
      onUsage: async ({ requestId }) => {
        lifecycle.push(`settle:${requestId}`);
      },
      onRequestFailure: async ({ requestId }) => {
        lifecycle.push(`forfeit:${requestId}`);
      },
      fetch: async (_url, init) => {
        lifecycle.push(`send:${JSON.parse(init.body).max_output_tokens}`);
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: "response-1",
              status: "completed",
              output: [],
              output_text: "Done",
              usage: { input_tokens: 10, output_tokens: 2 }
            };
          }
        };
      }
    });

    await model.next(baseCompatibleInput());
    expect(lifecycle).toEqual([
      "reserve:compatible-request-1",
      "send:4000",
      "settle:compatible-request-1"
    ]);
  });

  it("uses separate reservations when malformed HTTP JSON triggers a retry", async () => {
    const lifecycle: string[] = [];
    const requestIds = ["request-invalid", "request-retry"];
    let providerCalls = 0;
    const model = createOpenAiCompatibleAgentModel({
      config: {
        protocol: "openai_responses",
        baseUrl: "https://model.vendor.example/v1",
        apiKey: "vendor-secret",
        model: "vendor-coder-v2"
      },
      createRequestId: () => requestIds.shift()!,
      onRequestStart: async ({ requestId }) => {
        lifecycle.push(`reserve:${requestId}`);
      },
      onUsage: async ({ requestId }) => {
        lifecycle.push(`settle:${requestId}`);
      },
      onRequestFailure: async ({ requestId }) => {
        lifecycle.push(`forfeit:${requestId}`);
      },
      fetch: async () => {
        providerCalls += 1;
        lifecycle.push(`send:${providerCalls}`);
        return {
          ok: true,
          status: 200,
          async json() {
            if (providerCalls === 1) {
              throw new SyntaxError("truncated response");
            }
            return {
              id: "response-retry",
              status: "completed",
              output: [],
              output_text: "Recovered",
              usage: { input_tokens: 10, output_tokens: 2 }
            };
          }
        };
      }
    });

    await model.next(baseCompatibleInput());
    expect(lifecycle).toEqual([
      "reserve:request-invalid",
      "send:1",
      "forfeit:request-invalid",
      "reserve:request-retry",
      "send:2",
      "settle:request-retry"
    ]);
  });

  it("loads a non-OpenAI Responses-compatible provider from neutral environment variables", () => {
    const config = loadOpenAiCompatibleModelConfig({
      LECODING_MODEL_PROTOCOL: "openai_responses",
      LECODING_MODEL_BASE_URL: "https://model.vendor.example/v1",
      LECODING_MODEL_API_KEY: "vendor-secret",
      LECODING_MODEL_ID: "vendor-coder-v2"
    });

    expect(config).toEqual({
      protocol: "openai_responses",
      baseUrl: "https://model.vendor.example/v1",
      apiKey: "vendor-secret",
      model: "vendor-coder-v2"
    });
  });

  it("loads an OpenAI Chat Completions-compatible provider", () => {
    const config = loadOpenAiCompatibleModelConfig({
      LECODING_MODEL_PROTOCOL: "openai_chat_completions",
      LECODING_MODEL_BASE_URL: "https://model.vendor.example/v2",
      LECODING_MODEL_API_KEY: "vendor-secret",
      LECODING_MODEL_ID: "vendor-coder-v3"
    });

    expect(config).toEqual({
      protocol: "openai_chat_completions",
      baseUrl: "https://model.vendor.example/v2",
      apiKey: "vendor-secret",
      model: "vendor-coder-v3"
    });
  });

  it("routes AgentModel requests to the configured compatible provider and model", async () => {
    const observed: { url: string; init: OpenAiFetchInit }[] = [];
    const model = createOpenAiCompatibleAgentModel({
      config: {
        protocol: "openai_responses",
        baseUrl: "https://model.vendor.example/v1",
        apiKey: "vendor-secret",
        model: "vendor-coder-v2"
      },
      fetch: async (url, init) => {
        observed.push({ url, init });
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: "vendor-response-1",
              status: "completed",
              output: [],
              output_text: "Completed by compatible provider"
            };
          }
        };
      }
    });

    await expect(
      model.next({
        runId: "run-1",
        run: {
          projectId: "project-1",
          environmentId: "environment-1",
          task: "Fix tests",
          acceptanceCriteria: ["Tests pass"],
          approvalMode: "auto_review",
          fileAccessScope: "workspace_only"
        },
        toolResults: []
      })
    ).resolves.toEqual({
      type: "completed",
      summary: "Completed by compatible provider"
    });
    expect(observed[0]?.url).toBe(
      "https://model.vendor.example/v1/responses"
    );
    expect(JSON.parse(observed[0]!.init.body)).toMatchObject({
      model: "vendor-coder-v2"
    });
  });

  it("routes a Chat Completions provider through its function-calling contract", async () => {
    const observed: { url: string; init: OpenAiFetchInit }[] = [];
    const model = createOpenAiCompatibleAgentModel({
      config: {
        protocol: "openai_chat_completions",
        baseUrl: "https://model.vendor.example/v2",
        apiKey: "vendor-secret",
        model: "vendor-coder-v3"
      },
      fetch: async (url, init) => {
        observed.push({ url, init });
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: "chatcmpl-1",
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call-1",
                        type: "function",
                        function: {
                          name: "execute_command",
                          arguments: '{"argv":["pnpm","test"]}'
                        }
                      }
                    ]
                  }
                }
              ]
            };
          }
        };
      }
    });

    await expect(
      model.next({
        runId: "run-1",
        run: {
          projectId: "project-1",
          environmentId: "environment-1",
          task: "Fix tests",
          acceptanceCriteria: ["Tests pass"],
          approvalMode: "auto_review",
          fileAccessScope: "workspace_only"
        },
        toolResults: []
      })
    ).resolves.toMatchObject({
      type: "tool_call",
      callId: "call-1",
      tool: "execute_command",
      arguments: { argv: ["pnpm", "test"] }
    });
    expect(observed[0]?.url).toBe(
      "https://model.vendor.example/v2/chat/completions"
    );
    const requestBody = JSON.parse(observed[0]!.init.body);
    expect(requestBody).toMatchObject({
      model: "vendor-coder-v3",
      messages: [
        { role: "system" },
        { role: "user", content: expect.stringContaining("Task: Fix tests") }
      ]
    });
    expect(requestBody.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({ name: "execute_command" })
        }),
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({ name: "request_user_input" })
        })
      ])
    );
  });

  it("retries one invalid Chat Completions HTTP JSON body through compatible composition", async () => {
    let requestCount = 0;
    const retryEvents: unknown[] = [];
    const retryAdmissions: unknown[] = [];
    const model = createOpenAiCompatibleAgentModel({
      config: {
        protocol: "openai_chat_completions",
        baseUrl: "https://model.vendor.example/v2",
        apiKey: "vendor-secret",
        model: "vendor-coder-v3"
      },
      onBeforeModelRetry: async (retry) => {
        retryAdmissions.push(retry);
      },
      onMalformedJsonRetry: (event) => retryEvents.push(event),
      fetch: async () => {
        requestCount += 1;
        return {
          ok: true,
          status: 200,
          async json() {
            if (requestCount === 1) {
              throw new SyntaxError("truncated body");
            }
            return {
              choices: [
                {
                  finish_reason: "stop",
                  message: { role: "assistant", content: "Recovered" }
                }
              ]
            };
          }
        };
      }
    });

    await expect(
      model.next({
        runId: "run-retry",
        run: {
          projectId: "project-1",
          environmentId: "environment-1",
          task: "Recover the provider response",
          acceptanceCriteria: ["Return a valid turn"],
          approvalMode: "auto_review",
          fileAccessScope: "workspace_only"
        },
        toolResults: []
      })
    ).resolves.toEqual({
      type: "completed",
      summary: "Recovered"
    });
    expect(requestCount).toBe(2);
    expect(retryAdmissions).toEqual([
      {
        runId: "run-retry",
        protocol: "openai_chat_completions",
        retryCount: 1,
        failureCategory: "http_body_invalid_json"
      }
    ]);
    expect(retryEvents).toEqual([
      expect.objectContaining({
        runId: "run-retry",
        protocol: "openai_chat_completions",
        retryCount: 1,
        failureCategory: "http_body_invalid_json",
        outcome: "retrying"
      }),
      expect.objectContaining({ outcome: "recovered" })
    ]);
  });

  it("observes validated Chat Completions token usage without changing the model turn", async () => {
    const observedUsage: Array<{
      runId: string;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
    }> = [];
    const model = createOpenAiCompatibleAgentModel({
      config: {
        protocol: "openai_chat_completions",
        baseUrl: "https://model.vendor.example/v2",
        apiKey: "vendor-secret",
        model: "vendor-coder-v3"
      },
      onUsage: (usage) => {
        observedUsage.push(usage);
      },
      fetch: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            id: "chatcmpl-usage",
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: "Done" }
              }
            ],
            usage: {
              prompt_tokens: 123,
              completion_tokens: 45,
              prompt_tokens_details: { cached_tokens: 100 }
            }
          };
        }
      })
    });

    await expect(
      model.next({
        runId: "run-usage",
        run: {
          projectId: "project-1",
          environmentId: "environment-1",
          task: "Finish",
          acceptanceCriteria: ["Done"],
          approvalMode: "auto_review",
          fileAccessScope: "workspace_only"
        },
        toolResults: []
      })
    ).resolves.toEqual({ type: "completed", summary: "Done" });
    expect(observedUsage).toEqual([
      {
        runId: "run-usage",
        inputTokens: 123,
        outputTokens: 45,
        cachedInputTokens: 100
      }
    ]);
  });

  it("continues a stateless Chat Completions tool call from persisted history", async () => {
    const bodies: unknown[] = [];
    let requestCount = 0;
    const model = createOpenAiCompatibleAgentModel({
      config: {
        protocol: "openai_chat_completions",
        baseUrl: "https://model.vendor.example/v2",
        apiKey: "vendor-secret",
        model: "vendor-coder-v3"
      },
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        requestCount += 1;
        return {
          ok: true,
          status: 200,
          async json() {
            return requestCount === 1
              ? {
                  id: "chatcmpl-1",
                  choices: [
                    {
                      finish_reason: "tool_calls",
                      message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            id: "call-1",
                            type: "function",
                            function: {
                              name: "execute_command",
                              arguments: '{"argv":["pnpm","test"]}'
                            }
                          }
                        ]
                      }
                    }
                  ]
                }
              : {
                  id: "chatcmpl-2",
                  choices: [
                    {
                      finish_reason: "stop",
                      message: {
                        role: "assistant",
                        content: "Implemented and verified"
                      }
                    }
                  ]
                };
          }
        };
      }
    });
    const run = {
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Fix tests",
      acceptanceCriteria: ["Tests pass"],
      approvalMode: "auto_review" as const,
      fileAccessScope: "workspace_only" as const
    };

    const first = await model.next({ runId: "run-1", run, toolResults: [] });
    expect(first.type).toBe("tool_call");
    if (first.type !== "tool_call") {
      throw new Error("Expected a tool call");
    }
    if (!first.continuationId) {
      throw new Error("Expected persisted chat continuation history");
    }
    await expect(
      model.next({
        runId: "run-1",
        run,
        toolResults: [
          {
            callId: first.callId,
            continuationId: first.continuationId,
            status: "executed",
            exitCode: 0,
            stdout: "ok",
            stderr: ""
          }
        ]
      })
    ).resolves.toEqual({ type: "completed", summary: "Implemented and verified" });
    expect(bodies[1]).toMatchObject({
      messages: [
        { role: "system" },
        { role: "user" },
        {
          role: "assistant",
          tool_calls: [{ id: "call-1", type: "function" }]
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          content:
            '{"status":"executed","exitCode":0,"stdout":"ok","stderr":""}'
        }
      ]
    });
  });

  it("serializes multiple provider tool calls without contacting the provider between results", async () => {
    const bodies: unknown[] = [];
    const model = createOpenAiCompatibleAgentModel({
      config: {
        protocol: "openai_chat_completions",
        baseUrl: "https://model.vendor.example/v2",
        apiKey: "vendor-secret",
        model: "vendor-coder-v3"
      },
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          async json() {
            return bodies.length === 1
              ? {
                  choices: [
                    {
                      message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            id: "call-read",
                            type: "function",
                            function: {
                              name: "execute_command",
                              arguments: '{"argv":["cat","src/subject.js"]}'
                            }
                          },
                          {
                            id: "call-test",
                            type: "function",
                            function: {
                              name: "execute_command",
                              arguments: '{"argv":["node","--test"]}'
                            }
                          }
                        ]
                      }
                    }
                  ]
                }
              : {
                  choices: [
                    {
                      message: { role: "assistant", content: "Done" }
                    }
                  ]
                };
          }
        };
      }
    });
    const run = {
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Fix tests",
      acceptanceCriteria: ["Tests pass"],
      approvalMode: "auto_review" as const,
      fileAccessScope: "workspace_only" as const
    };

    const first = await model.next({ runId: "run-1", run, toolResults: [] });
    expect(first).toMatchObject({
      type: "tool_call",
      callId: "call-read",
      arguments: { argv: ["cat", "src/subject.js"] }
    });
    if (first.type !== "tool_call" || !first.continuationId) {
      throw new Error("Expected first queued tool call");
    }
    const second = await model.next({
      runId: "run-1",
      run,
      toolResults: [
        {
          callId: first.callId,
          continuationId: first.continuationId,
          status: "executed",
          exitCode: 0,
          stdout: "source",
          stderr: ""
        }
      ]
    });
    expect(second).toMatchObject({
      type: "tool_call",
      callId: "call-test",
      arguments: { argv: ["node", "--test"] }
    });
    expect(bodies).toHaveLength(1);
    if (second.type !== "tool_call" || !second.continuationId) {
      throw new Error("Expected second queued tool call");
    }
    await expect(
      model.next({
        runId: "run-1",
        run,
        toolResults: [
          {
            callId: first.callId,
            continuationId: first.continuationId,
            status: "executed",
            exitCode: 0,
            stdout: "source",
            stderr: ""
          },
          {
            callId: second.callId,
            continuationId: second.continuationId,
            status: "executed",
            exitCode: 0,
            stdout: "ok",
            stderr: ""
          }
        ]
      })
    ).resolves.toEqual({ type: "completed", summary: "Done" });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({
      messages: [
        { role: "system" },
        { role: "user" },
        {
          role: "assistant",
          tool_calls: [{ id: "call-read" }, { id: "call-test" }]
        },
        { role: "tool", tool_call_id: "call-read" },
        { role: "tool", tool_call_id: "call-test" }
      ]
    });
  });

  it("rejects corrupted Chat Completions continuation before contacting the provider", async () => {
    let contactedProvider = false;
    const model = createOpenAiCompatibleAgentModel({
      config: {
        protocol: "openai_chat_completions",
        baseUrl: "https://model.vendor.example/v2",
        apiKey: "vendor-secret",
        model: "vendor-coder-v3"
      },
      fetch: async () => {
        contactedProvider = true;
        throw new Error("Provider must not be contacted");
      }
    });

    await expect(
      model.next({
        runId: "run-1",
        run: {
          projectId: "project-1",
          environmentId: "environment-1",
          task: "Fix tests",
          acceptanceCriteria: ["Tests pass"],
          approvalMode: "auto_review",
          fileAccessScope: "workspace_only"
        },
        toolResults: [
          {
            callId: "call-1",
            continuationId: "not-json",
            status: "denied",
            reason: "Not approved"
          }
        ]
      })
    ).rejects.toThrow("OpenAI chat continuation is invalid JSON");
    expect(contactedProvider).toBe(false);
  });

  it("rejects a pending call injected into persisted Chat Completions state", async () => {
    let contactedProvider = false;
    const model = createOpenAiCompatibleAgentModel({
      config: {
        protocol: "openai_chat_completions",
        baseUrl: "https://model.vendor.example/v2",
        apiKey: "vendor-secret",
        model: "vendor-coder-v3"
      },
      fetch: async () => {
        contactedProvider = true;
        throw new Error("Provider must not be contacted");
      }
    });
    const continuationId = JSON.stringify({
      version: 1,
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-safe",
              type: "function",
              function: {
                name: "execute_command",
                arguments: '{"argv":["node","--test"]}'
              }
            }
          ]
        }
      ],
      activeCallId: "call-safe",
      pendingCalls: [
        {
          id: "call-injected",
          type: "function",
          function: {
            name: "execute_command",
            arguments: '{"argv":["node","-e","malicious"]}'
          }
        }
      ]
    });

    await expect(
      model.next({
        runId: "run-1",
        run: {
          projectId: "project-1",
          environmentId: "environment-1",
          task: "Fix tests",
          acceptanceCriteria: ["Tests pass"],
          approvalMode: "auto_review",
          fileAccessScope: "workspace_only"
        },
        toolResults: [
          {
            callId: "call-safe",
            continuationId,
            status: "executed",
            exitCode: 0,
            stdout: "ok",
            stderr: ""
          }
        ]
      })
    ).rejects.toThrow("OpenAI chat continuation queue does not match its assistant batch");
    expect(contactedProvider).toBe(false);
  });

  it("rejects a remote plaintext endpoint before sending provider credentials", () => {
    expect(() =>
      loadOpenAiCompatibleModelConfig({
        LECODING_MODEL_PROTOCOL: "openai_responses",
        LECODING_MODEL_BASE_URL: "http://model.vendor.example/v1",
        LECODING_MODEL_API_KEY: "vendor-secret",
        LECODING_MODEL_ID: "vendor-coder-v2"
      })
    ).toThrow("Remote model base URL must use HTTPS");
  });
});

function baseCompatibleInput() {
  return {
    runId: "run-compatible",
    run: {
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Fix tests",
      acceptanceCriteria: ["Tests pass"],
      approvalMode: "auto_review" as const,
      fileAccessScope: "workspace_only" as const
    },
    toolResults: []
  };
}
