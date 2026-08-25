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
