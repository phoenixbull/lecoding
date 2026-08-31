import { describe, expect, it } from "vitest";
import type {
  AgentModel,
  AgentModelInput,
  AgentModelTurn
} from "@lecoding/run-engine";
import { createTestHarness } from "@lecoding/test-harness";

function completedTurn(summary: string): AgentModelTurn {
  return { type: "completed", summary };
}

function createRecordingAgentModel(): {
  model: AgentModel;
  inputs: AgentModelInput[];
} {
  const inputs: AgentModelInput[] = [];
  const model: AgentModel = {
    async next(input) {
      inputs.push(input);
      return completedTurn("Done");
    }
  };
  return { model, inputs };
}

describe("RunEngine + project instructions", () => {
  it("forwards loaded project instructions to the AgentModel on the initial turn", async () => {
    const { model, inputs } = createRecordingAgentModel();
    const harness = await createTestHarness({
      model,
      projectInstructions: {
        async load() {
          return {
            sections: [
              { relativePath: "AGENTS.md", content: "Project policy" },
              { relativePath: "packages/api/AGENTS.md", content: "API rules" }
            ]
          };
        }
      },
      workspaceContext: {
        async projectRoot() {
          return "/repo";
        },
        async cwd() {
          return "/repo/packages/api";
        }
      }
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Add an endpoint",
      acceptanceCriteria: ["Endpoint exists"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });
    await harness.engine.resume(runId);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.projectInstructions).toEqual([
      "Project policy",
      "API rules"
    ]);
  });

  it("does not pass projectInstructions when the resolver dependency is absent", async () => {
    const { model, inputs } = createRecordingAgentModel();
    const harness = await createTestHarness({ model });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "No instructions expected",
      acceptanceCriteria: ["Done"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });
    await harness.engine.resume(runId);

    expect(inputs[0]!.projectInstructions).toBeUndefined();
  });
});