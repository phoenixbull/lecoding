import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAgentModelGoldenTaskExecutor,
  loadGoldenTaskCatalog
} from "../src/index.js";

describe("createAgentModelGoldenTaskExecutor", () => {
  it("runs model commands in the isolated environment and independently verifies the task", async () => {
    const workingRoot = await mkdtemp(join(tmpdir(), "lecoding-model-eval-"));
    const performed: string[][] = [];
    let turn = 0;
    let disposed = false;
    try {
      const executor = createAgentModelGoldenTaskExecutor({
        workingRoot,
        modelId: "vendor-coder-v3",
        pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 8 },
        createModel(onUsage) {
          return {
            async next() {
              turn += 1;
              onUsage(
                turn === 1
                  ? { inputTokens: 1_000, outputTokens: 200 }
                  : { inputTokens: 500, outputTokens: 100 }
              );
              return turn === 1
                ? {
                    type: "tool_call" as const,
                    callId: "call-1",
                    continuationId: "continuation-1",
                    tool: "execute_command" as const,
                    arguments: { argv: ["node", "--test"] }
                  }
                : {
                    type: "completed" as const,
                    summary: "Implemented and verified"
                  };
            }
          };
        },
        createEnvironment() {
          return {
            async prepare(spec) {
              return { id: `handle-${spec.runId}`, environmentId: spec.environmentId };
            },
            async perform(_handle, action) {
              if (action.type !== "execute") {
                throw new Error("Expected execute action");
              }
              performed.push(action.command);
              return { exitCode: 0, stdout: "ok", stderr: "" };
            },
            async inspect() {
              return { changedFiles: ["src/subject.js"] };
            },
            async dispose() {
              disposed = true;
            }
          };
        }
      });
      const task = loadGoldenTaskCatalog().find(
        (candidate) => candidate.id === "ts-fix-boundary"
      );

      const result = await executor.execute(task!);

      expect(result).toEqual({
        modelId: "vendor-coder-v3",
        outcome: "passed",
        inputTokens: 1_500,
        outputTokens: 300,
        costUsd: 0.0054
      });
      // The first command is model-driven; the second is independent acceptance evidence.
      expect(performed).toEqual([
        ["node", "--test"],
        ["node", "--test"]
      ]);
      expect(disposed).toBe(true);
    } finally {
      await rm(workingRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when an unattended golden task asks for user input", async () => {
    const workingRoot = await mkdtemp(join(tmpdir(), "lecoding-model-eval-"));
    let performed = false;
    try {
      const executor = createAgentModelGoldenTaskExecutor({
        workingRoot,
        modelId: "vendor-coder-v3",
        pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 8 },
        createModel() {
          return {
            async next() {
              return {
                type: "user_request" as const,
                requestId: "question-1",
                prompt: "Which behavior should I preserve?"
              };
            }
          };
        },
        createEnvironment() {
          return {
            async prepare(spec) {
              return { id: `handle-${spec.runId}`, environmentId: spec.environmentId };
            },
            async perform() {
              performed = true;
              return { exitCode: 0, stdout: "", stderr: "" };
            },
            async inspect() {
              return { changedFiles: [] };
            },
            async dispose() {}
          };
        }
      });
      const task = loadGoldenTaskCatalog().find(
        (candidate) => candidate.id === "ts-fix-boundary"
      );

      const result = await executor.execute(task!);

      expect(result).toMatchObject({
        outcome: "failed",
        failure: "AgentModel requested user input during unattended golden evaluation"
      });
      expect(performed).toBe(false);
    } finally {
      await rm(workingRoot, { recursive: true, force: true });
    }
  });
});
