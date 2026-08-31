import { describe, expect, it } from "vitest";
import { createTestHarness } from "@lecoding/test-harness";
import {
  createAnthropicAgentModel,
  type AnthropicMessagesClient
} from "../src/index.js";

/**
 * Phase 3 acceptance guard for "steer 与输入请求":
 * while a Run is waiting for a user answer, a subsequent steer command must
 * stage onto the next provider turn without consuming the pending question.
 *
 * The previous behaviour routed `steer` and `answer` through the same
 * `waiting_user` branch, which silently treated any steer message as an
 * implicit answer and resumed the run with the user's narrow constraint
 * bundled as a `tool_result` reply.
 */
describe("steer must not consume a pending user_request", () => {
  it("preserves the pending question after a steer is delivered in waiting_user", async () => {
    let turn = 0;
    const harness = await createTestHarness({
      model: createAnthropicAgentModel({
        model: "claude-test",
        client: {
          async create(): Promise<unknown> {
            turn += 1;
            if (turn === 1) {
              return {
                id: "msg-question",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "toolu_q",
                    name: "request_user_input",
                    input: { question: "Document v1 or v2?" }
                  }
                ],
                stop_reason: "tool_use",
                usage: { input_tokens: 5, output_tokens: 2 }
              };
            }
            return {
              id: "msg-completed",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "Documented v1 only" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 7, output_tokens: 3 }
            };
          }
        }
      })
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Document the public API",
      acceptanceCriteria: ["Documented"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });
    await harness.engine.resume(runId);
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "waiting_user",
      pendingUserRequest: { id: "toolu_q" }
    });

    await harness.engine.command(runId, {
      type: "steer",
      commandId: "steer-v1-only",
      message: "Focus on v1 only; v2 is out of scope"
    });
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "waiting_user",
      pendingUserRequest: { id: "toolu_q" }
    });

    await harness.engine.command(runId, {
      type: "answer",
      commandId: "answer-1",
      requestId: "toolu_q",
      value: "v1 only"
    });
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
  });

  it("carries the steer message into the provider turn that consumes the user answer", async () => {
    let turn = 0;
    const observedSteering: string[] = [];
    const observedToolResultValues: string[] = [];
    const client: AnthropicMessagesClient = {
      async create(): Promise<unknown> {
        turn += 1;
        if (turn === 1) {
          return {
            id: "msg-question",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_q",
                name: "request_user_input",
                input: { question: "Document v1 or v2?" }
              }
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 5, output_tokens: 2 }
          };
        }
        return {
          id: "msg-completed",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Documented v1 only" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 7, output_tokens: 3 }
        };
      }
    };
    const harness = await createTestHarness({
      model: createAnthropicAgentModel({
        model: "claude-test",
        client: {
          async create(request): Promise<unknown> {
            for (const message of request.messages) {
              if (
                message.role === "user" &&
                typeof message.content === "string" &&
                message.content.includes("Additional user instructions:")
              ) {
                observedSteering.push(message.content);
              }
              if (message.role === "user" && Array.isArray(message.content)) {
                for (const block of message.content) {
                  if (
                    typeof block === "object" &&
                    block !== null &&
                    (block as { type?: string }).type === "tool_result"
                  ) {
                    const content = (block as { content?: string }).content;
                    if (typeof content === "string") {
                      observedToolResultValues.push(content);
                    }
                  }
                }
              }
            }
            return client.create(request);
          }
        }
      })
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Document the public API",
      acceptanceCriteria: ["Documented"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });
    await harness.engine.resume(runId);

    await harness.engine.command(runId, {
      type: "steer",
      commandId: "steer-v1-only",
      message: "Focus on v1 only; v2 is out of scope"
    });
    await harness.engine.command(runId, {
      type: "answer",
      commandId: "answer-1",
      requestId: "toolu_q",
      value: "v1 only"
    });
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });

    // The mailbox-enqueued steer must be staged by the next drive() before the
            // tool_result-bearing provider call. If the answer consumed the steer, the
            // observable assertion below documents the regression.
            expect(observedToolResultValues).toEqual([
              JSON.stringify({ status: "answered", value: "v1 only" })
            ]);
            expect(observedSteering).toHaveLength(1);
            expect(observedSteering[0]).toContain("Additional user instructions:");
            expect(observedSteering[0]).toContain("Focus on v1 only; v2 is out of scope");
            expect(observedSteering[0]).toContain("Task: Document the public API");
  });
});