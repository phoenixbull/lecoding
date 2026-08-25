import { describe, expect, it } from "vitest";
import {
  createOpenAiCompatibleAgentModel,
  loadOpenAiCompatibleModelConfig,
  type OpenAiFetchInit
} from "../src/index.js";

describe("loadOpenAiCompatibleModelConfig", () => {
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
    expect(JSON.parse(observed[0]!.init.body)).toMatchObject({
      model: "vendor-coder-v3",
      messages: [
        { role: "system" },
        { role: "user", content: expect.stringContaining("Task: Fix tests") }
      ],
      tools: [
        {
          type: "function",
          function: { name: "execute_command" }
        }
      ]
    });
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
