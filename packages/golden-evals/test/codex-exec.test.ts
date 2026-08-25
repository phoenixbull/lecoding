import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCodexExecGoldenTaskExecutor,
  loadGoldenTaskCatalog,
  type GoldenCommandInvocation
} from "../src/index.js";

describe("createCodexExecGoldenTaskExecutor", () => {
  it("materializes an isolated task, invokes Codex safely, and verifies the result", async () => {
    const workingRoot = await mkdtemp(join(tmpdir(), "lecoding-codex-eval-"));
    const invocations: GoldenCommandInvocation[] = [];
    try {
      const executor = createCodexExecGoldenTaskExecutor({
        workingRoot,
        modelId: "gpt-test",
        pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 8 },
        runCommand: async (invocation) => {
          invocations.push(invocation);
          if (invocation.file === "codex") {
            return {
              exitCode: 0,
              stdout:
                '{"type":"thread.started","thread_id":"thread-1"}\n' +
                '{"type":"turn.completed","usage":{"input_tokens":1200,"output_tokens":300}}\n',
              stderr: ""
            };
          }
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }
      });

      const task = loadGoldenTaskCatalog().find(
        (candidate) => candidate.id === "python-add-validation"
      );
      expect(task).toBeDefined();
      const result = await executor.execute(task!);

      expect(result).toEqual({
        modelId: "gpt-test",
        outcome: "passed",
        inputTokens: 1200,
        outputTokens: 300,
        costUsd: 0.0048
      });
      expect(invocations[0]).toMatchObject({
        file: "codex",
        cwd: join(workingRoot, "python-add-validation")
      });
      expect(invocations[0]?.args).toContain("workspace-write");
      expect(invocations[0]?.args).toContain("never");
      expect(invocations[1]).toMatchObject({
        file: "python3",
        args: ["-m", "unittest", "-v"]
      });
    } finally {
      await rm(workingRoot, { recursive: true, force: true });
    }
  });

  it("reports a CLI failure without treating unverifiable output as success", async () => {
    const workingRoot = await mkdtemp(join(tmpdir(), "lecoding-codex-eval-"));
    try {
      const executor = createCodexExecGoldenTaskExecutor({
        workingRoot,
        modelId: "gpt-test",
        pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 8 },
        runCommand: async () => ({
          exitCode: 137,
          stdout: "",
          stderr: "terminated"
        })
      });

      const result = await executor.execute(loadGoldenTaskCatalog()[0]!);

      expect(result).toEqual({
        modelId: "gpt-test",
        outcome: "failed",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        failure: "Codex CLI exited with code 137: terminated"
      });
    } finally {
      await rm(workingRoot, { recursive: true, force: true });
    }
  });
});
