import { describe, expect, it } from "vitest";
import { createTestHarness } from "@lecoding/test-harness";
import {
  createOpenAiResponsesAgentModel,
  type OpenAiResponsesRequest
} from "../src/index.js";

describe("OpenAI Responses AgentModel + RunEngine", () => {
  it("executes a structured command, continues the response, and verifies the run", async () => {
    const requests: OpenAiResponsesRequest[] = [];
    const responses: unknown[] = [
      {
        id: "resp-tool",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "call-tool",
            name: "execute_command",
            arguments: '{"argv":["pnpm","test"]}'
          }
        ]
      },
      {
        id: "resp-complete",
        status: "completed",
        output: [],
        output_text: "Implemented and verified"
      }
    ];
    const model = createOpenAiResponsesAgentModel({
      model: "gpt-test",
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
    expect(requests[1]).toMatchObject({
      previous_response_id: "resp-tool",
      input: [
        {
          type: "function_call_output",
          call_id: "call-tool"
        }
      ]
    });
  });
});
