import { describe, expect, it } from "vitest";
import {
  createOpenAiResponsesClient,
  type OpenAiFetchInit,
  type OpenAiResponsesRequest
} from "../src/index.js";

describe("createOpenAiResponsesClient", () => {
  it("posts a Responses request with bearer authentication", async () => {
    const observed: { url: string; init: OpenAiFetchInit }[] = [];
    const client = createOpenAiResponsesClient({
      apiKey: "test-secret",
      baseUrl: "https://gateway.example/v1/",
      fetch: async (url, init) => {
        observed.push({ url, init });
        return {
          ok: true,
          status: 200,
          async json() {
            return { id: "resp-1", status: "completed", output: [] };
          }
        };
      }
    });
    const request: OpenAiResponsesRequest = {
      model: "gpt-test",
      instructions: "Use tools",
      input: "Fix tests",
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: true
    };

    await expect(client.create(request)).resolves.toEqual({
      id: "resp-1",
      status: "completed",
      output: []
    });
    expect(observed).toEqual([
      {
        url: "https://gateway.example/v1/responses",
        init: expect.objectContaining({
          method: "POST",
          headers: {
            authorization: "Bearer test-secret",
            "content-type": "application/json"
          },
          body: JSON.stringify(request)
        })
      }
    ]);
  });

  it("reports an HTTP failure without leaking provider details or credentials", async () => {
    const client = createOpenAiResponsesClient({
      apiKey: "test-secret",
      fetch: async () => ({
        ok: false,
        status: 401,
        async json() {
          return { error: { message: "invalid test-secret" } };
        }
      })
    });

    await expect(
      client.create({
        model: "gpt-test",
        instructions: "Use tools",
        input: "Fix tests",
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: true
      })
    ).rejects.toThrow("OpenAI Responses API returned HTTP 401");
  });
});
