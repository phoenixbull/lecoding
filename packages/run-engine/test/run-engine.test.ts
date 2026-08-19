import { describe, expect, it } from "vitest";
import { createTestHarness } from "@lecoding/test-harness";

describe("RunEngine", () => {
  it("completes a run only after verification passes", async () => {
    const harness = createTestHarness({ verificationOutcome: "passed" });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Add a health endpoint",
      acceptanceCriteria: ["The configured verification checks pass"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      id: runId,
      status: "succeeded",
      verification: {
        outcome: "passed"
      }
    });
  });

  it("executes a model-requested command before verification succeeds", async () => {
    const harness = createTestHarness({
      expectedChangedFile: "src/generated.ts",
      modelTurns: [
        {
          type: "tool_call",
          callId: "call-1",
          tool: "execute_command",
          arguments: { argv: ["pnpm", "test"] }
        },
        { type: "completed", summary: "Implemented and verified the change" }
      ]
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Generate src/generated.ts",
      acceptanceCriteria: ["src/generated.ts exists"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded",
      verification: {
        outcome: "passed",
        checks: [
          {
            name: "required file",
            outcome: "passed",
            detail: "src/generated.ts"
          }
        ]
      }
    });
  });

  it("pauses a manual run for approval and resumes the same tool call", async () => {
    const harness = createTestHarness({
      expectedChangedFile: "src/generated.ts",
      modelTurns: [
        {
          type: "tool_call",
          callId: "call-approval",
          tool: "execute_command",
          arguments: { argv: ["pnpm", "test"] }
        },
        { type: "completed", summary: "Implemented after approval" }
      ]
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Generate src/generated.ts",
      acceptanceCriteria: ["src/generated.ts exists"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "waiting_approval",
      pendingApproval: {
        id: "approval-call-approval",
        callId: "call-approval",
        summary: "Run pnpm test"
      }
    });

    await harness.engine.command(runId, {
      type: "approve",
      approvalId: "approval-call-approval",
      scope: "once"
    });

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded",
      verification: { outcome: "passed" }
    });
  });

  it("rejects a pending tool call without executing it", async () => {
    const harness = createTestHarness({
      expectNoChangedFiles: true,
      modelTurns: [
        {
          type: "tool_call",
          callId: "call-rejected",
          tool: "execute_command",
          arguments: { argv: ["rm", "-rf", "build"] }
        },
        { type: "completed", summary: "Continued without the rejected action" }
      ]
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Inspect the project safely",
      acceptanceCriteria: ["No files are changed"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.command(runId, {
      type: "reject",
      approvalId: "approval-call-rejected",
      scope: "once"
    });

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded",
      verification: {
        outcome: "passed",
        checks: [{ name: "unchanged workspace", outcome: "passed" }]
      }
    });
  });

  it("records a model failure instead of leaving the run active", async () => {
    const harness = createTestHarness({
      verificationOutcome: "passed",
      modelError: "Model provider unavailable"
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Make a change",
      acceptanceCriteria: ["Verification passes"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "failed",
      failure: {
        code: "agent_loop_failed",
        message: "Model provider unavailable"
      }
    });
  });

  it("cancels a run while it is waiting for approval", async () => {
    const harness = createTestHarness({
      modelTurns: [
        {
          type: "tool_call",
          callId: "call-cancelled",
          tool: "execute_command",
          arguments: { argv: ["pnpm", "test"] }
        }
      ]
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.command(runId, { type: "cancel" });

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "cancelled"
    });
  });

  it("publishes ordered status events for clients", async () => {
    const harness = createTestHarness({ verificationOutcome: "passed" });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Add a health endpoint",
      acceptanceCriteria: ["Verification passes"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    const stream = await harness.events.resume(runId);
    // Decode only public SSE data fields; the test never reads RunStore internals.
    const statuses = stream
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)).data.status);

    expect(statuses).toEqual([
      "queued",
      "preparing",
      "running",
      "verifying",
      "succeeded"
    ]);
  });
});
