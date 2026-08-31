import { describe, expect, it } from "vitest";
import { createTestHarness } from "@lecoding/test-harness";
import {
  createAnthropicAgentModel,
  type AnthropicMessagesRequest
} from "../src/index.js";

describe("Anthropic Messages AgentModel + RunEngine", () => {
  it("executes a structured command, continues the response, and verifies the run", async () => {
    const requests: AnthropicMessagesRequest[] = [];
    const responses: unknown[] = [
      {
        id: "msg-tool",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "Run the suite" },
          {
            type: "tool_use",
            id: "toolu_pnpm",
            name: "execute_command",
            input: { argv: ["pnpm", "test"] }
          }
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 25, output_tokens: 6 }
      },
      {
        id: "msg-done",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "File written" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 30, output_tokens: 8 }
      }
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
    const harness = await createTestHarness({
      model,
      expectedChangedFile: "src/generated.ts"
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Generate src/generated.ts",
      acceptanceCriteria: ["src/generated.ts exists"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });
    await harness.engine.resume(runId);

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded",
      verification: { outcome: "passed" }
    });
    // Stateless protocol: the continuation always resends full history with the tool_result.
    expect(requests[1]!.messages).toEqual([
      expect.objectContaining({ role: "user" }),
      {
        role: "assistant",
        content: [
          { type: "text", text: "Run the suite" },
          {
            type: "tool_use",
            id: "toolu_pnpm",
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
            tool_use_id: "toolu_pnpm",
            content: expect.stringContaining('"status":"executed"')
          }
        ]
      }
    ]);
  });
});