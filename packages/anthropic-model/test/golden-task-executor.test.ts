import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentModelGoldenTaskExecutor,
  type GoldenTask
} from "@lecoding/golden-evals";
import type { AgentModel } from "@lecoding/run-engine";
import type {
  EnvironmentAction,
  EnvironmentHandle,
  EnvironmentReport,
  EnvironmentResult,
  EnvironmentSpec
} from "@lecoding/contracts";
import type { RunEnvironment } from "@lecoding/run-environment";
import {
  createAnthropicAgentModel,
  type AnthropicMessagesClient
} from "../src/index.js";

class StubRunEnvironment implements RunEnvironment {
  /** Records every command run, including the executor's verification commands. */
  readonly commands: string[][] = [];

  async prepare(spec: EnvironmentSpec): Promise<EnvironmentHandle> {
    return { id: `stub-${spec.runId}`, environmentId: spec.environmentId };
  }

  async perform(
    _handle: EnvironmentHandle,
    action: EnvironmentAction
  ): Promise<EnvironmentResult> {
    if (action.type === "execute") {
      this.commands.push(action.command);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async inspect(_handle: EnvironmentHandle): Promise<EnvironmentReport> {
    return { changedFiles: [] };
  }

  async dispose(): Promise<void> {}
}

const NO_OP_TASK: GoldenTask = {
  id: "noop-completion",
  title: "No-op completion path",
  category: "docs",
  task: "Report that no edits were required.",
  repository: { seedFiles: [{ path: "README.md", content: "# Stub\n" }] },
  acceptanceCriteria: ["No code changes are required."],
  verificationCommands: [["node", "-e", "process.exit(0)"]]
};

describe("createAnthropicAgentModel + createAgentModelGoldenTaskExecutor", () => {
  let workingRoot: string;

  beforeEach(async () => {
    workingRoot = await mkdtemp(join(tmpdir(), "anthropic-golden-"));
  });

  afterEach(async () => {
    await rm(workingRoot, { recursive: true, force: true });
  });

  it("executes a deterministic no-op task via the executor", async () => {
    let observedUsage = 0;
    const client: AnthropicMessagesClient = {
      async create() {
        return {
          id: "msg_done",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "All done" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 12, output_tokens: 4 }
        };
      }
    };

    const environment = new StubRunEnvironment();
    const executor = createAgentModelGoldenTaskExecutor({
      workingRoot,
      modelId: "claude-test",
      pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      createModel(onUsage) {
        const model = createAnthropicAgentModel({
          model: "claude-test",
          client,
          onUsage: (usage) => {
            observedUsage += usage.inputTokens + usage.outputTokens;
            onUsage({
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens
            });
          }
        });
        return model;
      },
      createEnvironment() {
        return environment;
      }
    });

    const result = await executor.execute(NO_OP_TASK);

    expect(result).toEqual({
      modelId: "claude-test",
      outcome: "passed",
      inputTokens: 12,
      outputTokens: 4,
      costUsd: 0
    });
    // The executor must run every verification command independently of model turns.
    expect(environment.commands).toEqual([
      ["node", "-e", "process.exit(0)"]
    ]);
    expect(observedUsage).toBe(16);
  });

  it("exercises a one-tool-call task and replays history through the continuation envelope", async () => {
    let requestCount = 0;
    const client: AnthropicMessagesClient = {
      async create() {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            id: "msg_tool",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_one",
                name: "execute_command",
                input: { argv: ["node", "-e", "process.exit(0)"] }
              }
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 8, output_tokens: 3 }
          };
        }
        return {
          id: "msg_done",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Verified" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 9, output_tokens: 2 }
        };
      }
    };

    const environment = new StubRunEnvironment();
    const executor = createAgentModelGoldenTaskExecutor({
      workingRoot,
      modelId: "claude-test",
      pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      createModel(onUsage): AgentModel {
        return createAnthropicAgentModel({
          model: "claude-test",
          client,
          onUsage: (usage) => {
            onUsage({
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens
            });
          }
        });
      },
      createEnvironment() {
        return environment;
      }
    });

    const result = await executor.execute({
      ...NO_OP_TASK,
      id: "single-tool",
      task: "Run the smoke command and verify."
    });

    expect(result.outcome).toBe("passed");
    expect(result.inputTokens).toBe(17);
    expect(result.outputTokens).toBe(5);
    // The model issued one tool call and the executor then ran its own verification command.
    expect(environment.commands).toEqual([
      ["node", "-e", "process.exit(0)"],
      ["node", "-e", "process.exit(0)"]
    ]);
  });
});