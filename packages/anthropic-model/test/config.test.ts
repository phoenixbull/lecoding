import { describe, expect, it } from "vitest";
import {
  loadAnthropicModelConfig,
  type AnthropicModelConfig,
  type AnthropicModelEnvironment
} from "../src/index.js";

const BASE_ENV: AnthropicModelEnvironment = {
  ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  ANTHROPIC_API_KEY: "sk-ant-test",
  ANTHROPIC_MODEL: "claude-test"
};

describe("loadAnthropicModelConfig", () => {
  it("returns a normalized config when every required variable is present", () => {
    const config = loadAnthropicModelConfig(BASE_ENV);
    expect(config).toEqual<AnthropicModelConfig>({
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
      model: "claude-test"
    });
  });

  it("strips trailing slashes from a configured base URL", () => {
    const config = loadAnthropicModelConfig({
      ...BASE_ENV,
      ANTHROPIC_BASE_URL: "https://api.anthropic.com///"
    });
    expect(config.baseUrl).toBe("https://api.anthropic.com");
  });

  it("rejects a missing API key", () => {
    expect(() =>
      loadAnthropicModelConfig({ ...BASE_ENV, ANTHROPIC_API_KEY: "" })
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("rejects a missing model id", () => {
    expect(() =>
      loadAnthropicModelConfig({ ...BASE_ENV, ANTHROPIC_MODEL: "  " })
    ).toThrow(/ANTHROPIC_MODEL/);
  });

  it("rejects an unsupported base URL scheme", () => {
    expect(() =>
      loadAnthropicModelConfig({
        ...BASE_ENV,
        ANTHROPIC_BASE_URL: "ftp://api.anthropic.com"
      })
    ).toThrow(/ANTHROPIC_BASE_URL/);
  });
});