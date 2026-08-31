import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDockerRunEnvironment } from "@lecoding/run-environment";
import {
  createAgentModelGoldenTaskExecutor,
  loadGoldenTaskCatalog,
  runGoldenBaseline,
  selectAcceptanceGoldenTasks,
  selectRepresentativeGoldenTasks
} from "@lecoding/golden-evals";
import {
  createAnthropicCompatibleAgentModel,
  loadAnthropicModelConfig
} from "../src/index.js";

const runLiveBaseline = process.env.RUN_LIVE_GOLDEN === "1";

describe("live Anthropic Messages golden baseline", () => {
  it.skipIf(!runLiveBaseline)(
    "runs the selected suite through the Docker-isolated AgentModel gateway",
    async () => {
      const config = loadAnthropicModelConfig(process.env);
      const pricing = {
        inputUsdPerMillion: readPrice("LECODING_MODEL_INPUT_USD_PER_MILLION"),
        outputUsdPerMillion: readPrice("LECODING_MODEL_OUTPUT_USD_PER_MILLION")
      };
      const workingRoot = await mkdtemp(join(tmpdir(), "lecoding-anthropic-golden-"));
      const executor = createAgentModelGoldenTaskExecutor({
        workingRoot,
        modelId: config.model,
        pricing,
        createModel: (onUsage) =>
          createAnthropicCompatibleAgentModel({ config, onUsage }),
        createEnvironment: (workspacePath) =>
          createDockerRunEnvironment({
            image: process.env.LECODING_GOLDEN_IMAGE ?? "lecoding-sandbox:phase0",
            worktreeRoot: workingRoot,
            workspacePath,
            memory: "1g",
            cpus: 1,
            pidsLimit: 128,
            network: "none"
          })
      });

      const suite = readSuite();
      const tasks =
        suite === "acceptance"
          ? selectAcceptanceGoldenTasks(loadGoldenTaskCatalog())
          : selectRepresentativeGoldenTasks(loadGoldenTaskCatalog());
      const report = await runGoldenBaseline({
        tasks,
        executor,
        createdAt: new Date().toISOString(),
        nowMs: Date.now
      });
      const outputPath = resolve(
        process.env.LECODING_GOLDEN_REPORT ??
          ".artifacts/golden-evals/anthropic-latest-report.json"
      );
      await mkdir(dirname(outputPath), { recursive: true });
      // The report contains metrics and bounded failures, never credentials or raw prompts.
      await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

      expect(report.summary.taskCount).toBe(suite === "acceptance" ? 12 : 5);
      expect(report.summary.inputTokens + report.summary.outputTokens).toBeGreaterThan(0);
    },
    15 * 60_000
  );
});

function readSuite(): "representative" | "acceptance" {
  const suite = process.env.LECODING_GOLDEN_SUITE?.trim() || "representative";
  if (suite !== "representative" && suite !== "acceptance") {
    throw new Error("LECODING_GOLDEN_SUITE must be representative or acceptance");
  }
  return suite;
}

function readPrice(name: string): number {
  const raw = process.env[name]?.trim();
  const value = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative USD-per-million-token rate`);
  }
  return value;
}