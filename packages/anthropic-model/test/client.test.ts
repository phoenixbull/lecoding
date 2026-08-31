import { describe, expect, it } from "vitest";
import {
  createAnthropicMessagesClient,
  type AnthropicFetchInit,
  type AnthropicMessagesRequest
} from "../src/index.js";

/** Baseline Messages API request used by every transport contract test. */
function baseRequest(): AnthropicMessagesRequest {
  return {
    model: "claude-test",
    max_tokens: 1_000,
    system: "Use tools",
    messages: [{ role: "user", content: "Fix tests" }],
    tools: [],
    tool_choice: { type: "auto" }
  };
}

describe("createAnthropicMessagesClient", () => {
  it("posts a Messages request with the API key header and pinned protocol version", async () => {
    const observed: { url: string; init: AnthropicFetchInit }[] = [];
    const client = createAnthropicMessagesClient({
      apiKey: "test-secret",
      baseUrl: "https://api.anthropic.com/",
      fetch: async (url, init) => {
        observed.push({ url, init });
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: "msg_1",
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 10, output_tokens: 5 }
            };
          }
        };
      }
    });
    const request = baseRequest();

    await expect(client.create(request)).resolves.toEqual({
      id: "msg_1",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 }
    });
    expect(observed).toEqual([
      {
        url: "https://api.anthropic.com/v1/messages",
        init: expect.objectContaining({
          method: "POST",
          headers: {
            "x-api-key": "test-secret",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
          },
          body: JSON.stringify(request)
        })
      }
    ]);
  });

  it("reports an HTTP failure without echoing provider detail or credentials", async () => {
    const client = createAnthropicMessagesClient({
      apiKey: "test-secret",
      fetch: async () => ({
        ok: false,
        status: 401,
        async json() {
          return { error: { message: "invalid test-secret" } };
        }
      })
    });

    await expect(client.create(baseRequest())).rejects.toThrow(
      "Anthropic Messages API returned HTTP 401"
    );
  });

  it("reports invalid JSON bodies with a stable credential-free message", async () => {
    const client = createAnthropicMessagesClient({
      apiKey: "test-secret",
      fetch: async () => ({
        ok: true,
        status: 200,
        async json() {
          throw new Error("Unexpected HTML proxy page");
        }
      })
    });

    await expect(client.create(baseRequest())).rejects.toThrow(
      "Anthropic Messages API returned invalid JSON (HTTP 200)"
    );
  });

  it("rejects remote plaintext endpoints before any credential is sent", () => {
    expect(() =>
      createAnthropicMessagesClient({
        apiKey: "test-secret",
        baseUrl: "http://api.anthropic.com"
      })
    ).toThrow("Remote Anthropic base URL must use HTTPS");
  });

  it("keeps loopback HTTP available for local development servers", () => {
    expect(() =>
      createAnthropicMessagesClient({
        apiKey: "test-secret",
        baseUrl: "http://127.0.0.1:8082"
      })
    ).not.toThrow();
  });

  it("rejects empty API keys and invalid timeouts", () => {
    expect(() =>
      createAnthropicMessagesClient({ apiKey: "  " })
    ).toThrow("Anthropic API key must not be empty");
    expect(() =>
      createAnthropicMessagesClient({ apiKey: "k", timeoutMs: 0 })
    ).toThrow("Anthropic request timeout must be a positive integer");
    expect(() =>
      createAnthropicMessagesClient({ apiKey: "k", timeoutMs: 1.5 })
    ).toThrow("Anthropic request timeout must be a positive integer");
  });
});
