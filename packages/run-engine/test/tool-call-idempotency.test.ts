import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createTestHarness, InMemoryRunStore } from "@lecoding/test-harness";
import type { RunEnvironment } from "@lecoding/run-environment";
import {
  createPostgresToolCallLedger,
  type AgentModel,
  type ToolCallLedger
} from "../src/index.js";

describe("RunEngine tool-call idempotency", () => {
  it("fails safely without replaying a tool call whose prior outcome is unknown", async () => {
    let performCount = 0;
    const environment: RunEnvironment = {
      prepare: async (spec) => ({
        id: `handle-${spec.runId}`,
        environmentId: spec.environmentId
      }),
      perform: async () => {
        performCount += 1;
        return { exitCode: 0, stdout: "unexpected", stderr: "" };
      },
      inspect: async () => ({ changedFiles: [] }),
      dispose: async () => {}
    };
    const uncertainLedger: ToolCallLedger = {
      claim: async () => ({ status: "outcome_unknown" }),
      complete: async () => {
        throw new Error("An unknown call cannot be completed by a replacement Worker");
      }
    };
    const harness = await createTestHarness({
      environment,
      toolCalls: uncertainLedger,
      modelTurns: [
        {
          type: "tool_call",
          callId: "call-1",
          tool: "execute_command",
          arguments: { argv: ["pnpm", "test"] }
        }
      ]
    });
    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Do not repeat an uncertain command",
      acceptanceCriteria: ["Command executes at most once"],
      approvalMode: "full_access",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.resume(runId);

    expect(performCount).toBe(0);
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "tool_call_outcome_unknown" }
    });
  });

  it("does not repeat a side effect after completion persistence is interrupted", async () => {
    const database = new PGlite();
    const durableLedger = await createPostgresToolCallLedger(database);
    const sharedStore = new InMemoryRunStore();
    let performCount = 0;
    const environment: RunEnvironment = {
      prepare: async (spec) => ({
        id: `handle-${spec.runId}-${performCount}`,
        environmentId: spec.environmentId
      }),
      perform: async () => {
        performCount += 1;
        return { exitCode: 0, stdout: "side effect happened", stderr: "" };
      },
      inspect: async () => ({ changedFiles: [] }),
      dispose: async () => {}
    };
    const interruptedLedger: ToolCallLedger = {
      claim: (input) => durableLedger.claim(input),
      complete: async () => {
        // Fault injection: the command returned, but its completion write never landed.
        throw new Error("worker lost database connectivity before completion persistence");
      }
    };
    const toolTurn = {
      type: "tool_call" as const,
      callId: "call-crash-window",
      tool: "execute_command" as const,
      arguments: { argv: ["publish", "artifact"] }
    };
    const firstWorker = await createTestHarness({
      store: sharedStore,
      environment,
      toolCalls: interruptedLedger,
      modelTurns: [toolTurn],
      workerId: "worker-A"
    });
    const runId = await firstWorker.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Publish once",
      acceptanceCriteria: ["Side effect is not duplicated"],
      approvalMode: "full_access",
      fileAccessScope: "workspace_only"
    });

    await firstWorker.engine.resume(runId);
    expect(performCount).toBe(1);

    let replacementModelCalls = 0;
    const replacementModel: AgentModel = {
      async next() {
        replacementModelCalls += 1;
        throw new Error("Replacement must recover the persisted tool call");
      }
    };
    // The replacement must recover the exact persisted call, not ask the model for a new ID.
    const replacementWorker = await createTestHarness({
      store: sharedStore,
      environment,
      toolCalls: durableLedger,
      model: replacementModel,
      workerId: "worker-B"
    });
    await replacementWorker.engine.resume(runId);

    expect(performCount).toBe(1);
    expect(replacementModelCalls).toBe(0);
    await expect(replacementWorker.engine.inspect(runId)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "tool_call_outcome_unknown" }
    });
    await database.close();
  });
});
