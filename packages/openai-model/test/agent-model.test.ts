import { describe, expect, it } from "vitest";
import {
  createOpenAiResponsesAgentModel,
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
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          name: "execute_command",
          strict: true,
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["argv"]
          }
        }
      ]
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
