import { describe, expect, it, vi } from "vitest";
import type {
  EnvironmentHandle,
  EnvironmentReport,
  EnvironmentResult,
  EnvironmentSpec
} from "@lecoding/contracts";
import type { AgentModel, AgentModelTurn, ModelToolResult } from "@lecoding/run-engine";
import {
  createInMemoryApprovalLedger,
  createInMemoryRunLease,
  InMemoryRunCancelBus
} from "@lecoding/run-engine";
import type { RunEnvironment } from "@lecoding/run-environment";
import { FakeDockerRunEnvironment } from "@lecoding/run-environment";
import { createTestHarness, InMemoryRunStore } from "@lecoding/test-harness";

function networkTurn(
  callId: string,
  domain: string
): Extract<AgentModelTurn, { tool: "request_network_egress" }> {
  return {
    type: "tool_call",
    callId,
    tool: "request_network_egress",
    arguments: {
      scheme: "https",
      domain,
      port: 443,
      purpose: "Resolve reviewed dependencies"
    }
  };
}

describe("RunEngine", () => {
  it("completes a run only after verification passes", async () => {
    const harness = await createTestHarness({ verificationOutcome: "passed" });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Add a health endpoint",
      acceptanceCriteria: ["The configured verification checks pass"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.resume(runId);

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      id: runId,
      status: "succeeded",
      verification: {
        outcome: "passed"
      }
    });

  });

  it("removes the runtime container while retaining terminal worktree evidence", async () => {
    const environment = new RecordingRunEnvironment();
    const harness = await createTestHarness({
      environment,
      verificationOutcome: "passed"
    });
    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Complete without tools",
      acceptanceCriteria: ["Verification passes"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.resume(runId);

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
    expect(environment.disposeCount).toBe(1);
    expect(environment.lastDisposeOutcome).toBe("keep");
  });

  it("executes a model-requested command before verification succeeds", async () => {
    const harness = await createTestHarness({
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

    await harness.engine.resume(runId);

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

    const lifecycle = parseSseEvents(await harness.events.resume(runId)).filter(
      (event) =>
        event.type === "tool_started" ||
        event.type === "tool_completed" ||
        event.type === "verification_completed" ||
        (event.type === "status_changed" &&
          (event.data.status === "verifying" ||
            event.data.status === "succeeded"))
    );
    expect(lifecycle).toEqual([
      expect.objectContaining({
        type: "tool_started",
        data: { callId: "call-1", command: "pnpm", argumentCount: 2 }
      }),
      expect.objectContaining({
        type: "tool_completed",
        data: {
          callId: "call-1",
          outcome: "executed",
          exitCode: 0,
          recovered: false
        }
      }),
      expect.objectContaining({
        type: "status_changed",
        data: { status: "verifying" }
      }),
      expect.objectContaining({
        type: "verification_completed",
        data: { outcome: "passed", checkCount: 1 }
      }),
      expect.objectContaining({
        type: "status_changed",
        data: { status: "succeeded" }
      })
    ]);
  });

  it("persists the model continuation with a tool result for the next turn", async () => {
    const observedResults: ModelToolResult[][] = [];
    let turn = 0;
    const model: AgentModel = {
      async next(input) {
        observedResults.push(structuredClone(input.toolResults));
        turn += 1;
        return turn === 1
          ? {
              type: "tool_call",
              callId: "call-continuation",
              continuationId: "response-1",
              tool: "execute_command",
              arguments: { argv: ["pnpm", "test"] }
            }
          : { type: "completed", summary: "Continued after the tool result" };
      }
    };
    const harness = await createTestHarness({ model });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Continue a provider response after executing its command",
      acceptanceCriteria: ["The second model turn receives the continuation"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });
    await harness.engine.resume(runId);

    expect(observedResults[1]).toEqual([
      {
        callId: "call-continuation",
        continuationId: "response-1",
        status: "executed",
        exitCode: 0,
        stdout: "",
        stderr: ""
      }
    ]);
  });

  it("pauses a manual run for approval and resumes the same tool call", async () => {
    const approvals = createInMemoryApprovalLedger({
      now: () => "2026-08-28T03:30:00.000Z"
    });
    const harness = await createTestHarness({
      approvals,
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

    await harness.engine.resume(runId);

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "waiting_approval",
      pendingApproval: {
        id: "approval-call-approval",
        callId: "call-approval",
        summary: "Run pnpm test"
      }
    });

    expect(parseSseEvents(await harness.events.resume(runId))).toContainEqual(
      expect.objectContaining({
        type: "approval_requested",
        data: {
          approvalId: "approval-call-approval",
          callId: "call-approval",
          summary: "Run pnpm test"
        }
      })
    );

    await harness.engine.command(runId, {
      type: "approve",
      approvalId: "approval-call-approval",
      scope: "once"
    }, { actorId: "github_42" });

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded",
      verification: { outcome: "passed" }
    });
    await expect(approvals.get("approval-call-approval")).resolves.toMatchObject({
      status: "decided",
      decision: "allow",
      scope: "once",
      decidedBy: "github_42",
      capabilityType: "command_exec"
    });
  });

  it("reuses a run-scoped approval only for the same normalized capability", async () => {
    const harness = await createTestHarness({
      expectedChangedFile: "src/generated.ts",
      modelTurns: [
        {
          type: "tool_call",
          callId: "call-approved-first",
          tool: "execute_command",
          arguments: { argv: ["pnpm", "test"] }
        },
        {
          type: "tool_call",
          callId: "call-approved-second",
          tool: "execute_command",
          arguments: { argv: ["pnpm", "test"] }
        },
        { type: "completed", summary: "Repeated the approved capability" }
      ]
    });
    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run the same protected command twice",
      acceptanceCriteria: ["src/generated.ts exists"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.resume(runId);
    await harness.engine.command(runId, {
      type: "approve",
      approvalId: "approval-call-approved-first",
      scope: "run"
    });

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
    const approvalEvents = parseSseEvents(await harness.events.resume(runId)).filter(
      (event) => event.type === "approval_requested"
    );
    expect(approvalEvents).toHaveLength(1);
  });

  it("persists an admin project approval and reuses it for the current Run", async () => {
    const projectRules = {
      set: vi.fn(async () => "rule-1")
    };
    const harness = await createTestHarness({
      expectedChangedFile: "src/generated.ts",
      projectRules,
      modelTurns: [
        {
          type: "tool_call",
          callId: "project-rule-first",
          tool: "execute_command",
          arguments: { argv: ["pnpm", "test"] }
        },
        {
          type: "tool_call",
          callId: "project-rule-second",
          tool: "execute_command",
          arguments: { argv: ["pnpm", "test"] }
        },
        { type: "completed", summary: "Used the exact project rule" }
      ]
    });
    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Persist an exact project capability",
      acceptanceCriteria: ["src/generated.ts exists"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.resume(runId);
    await harness.engine.command(
      runId,
      {
        type: "approve",
        approvalId: "approval-project-rule-first",
        scope: "project"
      },
      { actorId: "github_42", canManageProjectRules: true }
    );

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
    expect(projectRules.set).toHaveBeenCalledWith({
      projectId: "project-1",
      capabilityType: "command_exec",
      capabilityHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      constraints: {
        argv: ["pnpm", "test"],
        cwd: ".",
        shellMode: "direct"
      },
      decision: "allow",
      createdBy: "github_42",
      sourceApprovalId: "approval-project-rule-first"
    });
  });

  it("passes the exact capability fingerprint to project policy resolution", async () => {
    const authorize = vi.fn(async () => ({ decision: "allow" as const }));
    const harness = await createTestHarness({
      policy: { authorize },
      modelTurns: [
        {
          type: "tool_call",
          callId: "project-rule-lookup",
          tool: "execute_command",
          arguments: { argv: ["pnpm", "test"] }
        },
        { type: "completed", summary: "Project rule resolved" }
      ]
    });
    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Use an existing exact project rule",
      acceptanceCriteria: ["The command runs"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.resume(runId);

    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          projectId: "project-1",
          toolCallId: "project-rule-lookup",
          capabilityHash: expect.stringMatching(/^[a-f0-9]{64}$/u)
        })
      })
    );
  });

  it("rejects a pending tool call without executing it", async () => {
    const harness = await createTestHarness({
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

    await harness.engine.resume(runId);

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

  it("reuses a run-scoped denial as a denied tool result without re-prompting", async () => {
    const harness = await createTestHarness({
      expectNoChangedFiles: true,
      modelTurns: [
        {
          type: "tool_call",
          callId: "call-denied-first",
          tool: "execute_command",
          arguments: { argv: ["curl", "https://example.com"] }
        },
        {
          type: "tool_call",
          callId: "call-denied-second",
          tool: "execute_command",
          arguments: { argv: ["curl", "https://example.com"] }
        },
        { type: "completed", summary: "Continued without the denied capability" }
      ]
    });
    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Do not repeat a denied capability prompt",
      acceptanceCriteria: ["No files are changed"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.resume(runId);
    await harness.engine.command(runId, {
      type: "reject",
      approvalId: "approval-call-denied-first",
      scope: "run"
    });

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
    const approvalEvents = parseSseEvents(await harness.events.resume(runId)).filter(
      (event) => event.type === "approval_requested"
    );
    expect(approvalEvents).toHaveLength(1);
  });

  it("pauses for an exact network endpoint and resumes after one approval", async () => {
    const approvals = createInMemoryApprovalLedger({
      now: () => "2026-08-28T04:00:00.000Z"
    });
    const harness = await createTestHarness({
      expectNoChangedFiles: true,
      approvals,
      modelTurns: [
        {
          type: "tool_call",
          callId: "call-network",
          tool: "request_network_egress",
          arguments: {
            scheme: "https",
            domain: "registry.npmjs.org",
            port: 443,
            purpose: "Resolve reviewed project dependencies"
          }
        },
        { type: "completed", summary: "Network grant received" }
      ]
    });
    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Request dependency registry access",
      acceptanceCriteria: ["No files are changed"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.resume(runId);

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "waiting_approval",
      pendingApproval: {
        id: "approval-call-network",
        capabilityType: "network_egress",
        summary: "Connect to https://registry.npmjs.org:443"
      }
    });
    await harness.engine.command(
      runId,
      {
        type: "approve",
        approvalId: "approval-call-network",
        scope: "once"
      },
      { actorId: "github_42" }
    );

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
    await expect(approvals.get("approval-call-network")).resolves.toMatchObject({
      capabilityType: "network_egress",
      constraints: {
        scheme: "https",
        domain: "registry.npmjs.org",
        port: 443
      },
      status: "decided",
      decision: "allow",
      decidedBy: "github_42"
    });
  });

  it("reuses only the approved network endpoint and resumes after another is rejected", async () => {
    const harness = await createTestHarness({
      expectNoChangedFiles: true,
      modelTurns: [
        networkTurn("network-first", "registry.npmjs.org"),
        networkTurn("network-same", "registry.npmjs.org"),
        networkTurn("network-different", "files.pythonhosted.org"),
        { type: "completed", summary: "Handled both endpoint decisions" }
      ]
    });
    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Use only explicitly reviewed endpoints",
      acceptanceCriteria: ["No files are changed"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.resume(runId);
    await harness.engine.command(runId, {
      type: "approve",
      approvalId: "approval-network-first",
      scope: "run"
    });

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "waiting_approval",
      pendingApproval: {
        id: "approval-network-different",
        summary: "Connect to https://files.pythonhosted.org:443"
      }
    });
    await harness.engine.command(runId, {
      type: "reject",
      approvalId: "approval-network-different",
      scope: "once"
    });
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
    const approvalEvents = parseSseEvents(await harness.events.resume(runId)).filter(
      (event) => event.type === "approval_requested"
    );
    expect(approvalEvents).toHaveLength(2);
  });

  it("persists a model question and continues from the matching user answer", async () => {
    const observedResults: ModelToolResult[][] = [];
    let turn = 0;
    const harness = await createTestHarness({
      model: {
        async next(input) {
          observedResults.push(structuredClone(input.toolResults));
          turn += 1;
          return turn === 1
            ? {
                type: "user_request" as const,
                requestId: "question-1",
                continuationId: "response-1",
                prompt: "Which API path should remain compatible?"
              }
            : { type: "completed" as const, summary: "Continued with user input" };
        }
      }
    });
    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Update the API",
      acceptanceCriteria: ["Compatibility is preserved"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.resume(runId);
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "waiting_user",
      pendingUserRequest: {
        id: "question-1",
        prompt: "Which API path should remain compatible?"
      }
    });
    // A delayed browser tab must not answer a newer question by reusing stale state.
    await expect(
      harness.engine.command(runId, {
        type: "answer",
        commandId: "answer-stale",
        requestId: "stale-question",
        value: "This answer is stale"
      })
    ).rejects.toThrow(/matching user input/i);
    await harness.engine.command(runId, {
      type: "answer",
      commandId: "answer-question-1",
      requestId: "question-1",
      value: "/api/v1 must remain compatible"
    });
    // A lost HTTP response can be retried after the Run has already completed.
    await expect(
      harness.engine.command(runId, {
        type: "answer",
        commandId: "answer-question-1",
        requestId: "question-1",
        value: "/api/v1 must remain compatible"
      })
    ).resolves.toBeUndefined();
    await expect(
      harness.engine.command(runId, {
        type: "answer",
        commandId: "answer-question-1",
        requestId: "question-1",
        value: "Use /api/v2 instead"
      })
    ).rejects.toThrow(/different payload/i);

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
    expect(observedResults[1]).toEqual([
      {
        callId: "question-1",
        continuationId: "response-1",
        status: "answered",
        value: "/api/v1 must remain compatible"
      }
    ]);
    const conversationEvents = (await harness.events.resume(runId))
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)))
      .filter((event) =>
        [
          "agent_question",
          "user_message_submitted",
          "user_message_delivered"
        ].includes(event.type)
      );
    expect(conversationEvents.map((event) => event.type)).toEqual([
      "agent_question",
      "user_message_submitted",
      "user_message_delivered"
    ]);
  });

  it("applies steering text to the question currently waiting for user input", async () => {
    const observedResults: ModelToolResult[][] = [];
    let turn = 0;
    const harness = await createTestHarness({
      model: {
        async next(input) {
          observedResults.push(structuredClone(input.toolResults));
          turn += 1;
          return turn === 1
            ? {
                type: "user_request" as const,
                requestId: "question-steer",
                prompt: "Which compatibility constraints apply?"
              }
            : { type: "completed" as const, summary: "Applied steering" };
        }
      }
    });
    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Update the API",
      acceptanceCriteria: ["Compatibility is preserved"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.resume(runId);
    await harness.engine.command(runId, {
      type: "steer",
      commandId: "steer-waiting-question",
      message: "Keep response error codes unchanged"
    });

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
    expect(observedResults[1]).toEqual([
      {
        callId: "question-steer",
        status: "answered",
        value: "Keep response error codes unchanged"
      }
    ]);
  });

  it("queues steering while another worker owns the active model turn", async () => {
    const observedSteering: string[][] = [];
    let resolveFirstTurn!: (turn: AgentModelTurn) => void;
    let markModelEntered!: () => void;
    const modelEntered = new Promise<void>((resolve) => {
      markModelEntered = resolve;
    });
    let turn = 0;
    const harness = await createTestHarness({
      model: {
        async next(input) {
          observedSteering.push([...(input.steeringMessages ?? [])]);
          turn += 1;
          if (turn === 1) {
            markModelEntered();
            return new Promise<AgentModelTurn>((resolve) => {
              resolveFirstTurn = resolve;
            });
          }
          return { type: "completed" as const, summary: "Applied live steering" };
        }
      }
    });
    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Update the API",
      acceptanceCriteria: ["Compatibility is preserved"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    const resume = harness.engine.resume(runId);
    await modelEntered;
    // Mailbox enqueue must not contend for the lease held by the active driver.
    await harness.engine.command(runId, {
      type: "steer",
      commandId: "steer-live-1",
      message: "Keep the legacy error payload"
    });
    await harness.engine.command(runId, {
      type: "steer",
      commandId: "steer-live-1",
      message: "Keep the legacy error payload"
    });
    await expect(
      harness.engine.command(runId, {
        type: "steer",
        commandId: "steer-live-1",
        message: "Replace the payload instead"
      })
    ).rejects.toThrow(/different message/i);
    resolveFirstTurn({
      type: "tool_call",
      callId: "call-before-steer",
      tool: "execute_command",
      arguments: { argv: ["pnpm", "test"] }
    });
    await resume;

    expect(observedSteering).toEqual([
      [],
      ["Keep the legacy error payload"]
    ]);
    const conversationEvents = (await harness.events.resume(runId))
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)))
      .filter((event) =>
        ["user_message_submitted", "user_message_delivered"].includes(
          event.type
        )
      );
    expect(conversationEvents).toEqual([
      expect.objectContaining({
        type: "user_message_submitted",
        data: expect.objectContaining({
          mode: "steer",
          message: "Keep the legacy error payload"
        })
      }),
      expect.objectContaining({
        type: "user_message_delivered",
        data: expect.objectContaining({ messageIds: ["steer:1"] })
      })
    ]);
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
    await expect(
      harness.engine.command(runId, {
        type: "steer",
        commandId: "steer-live-1",
        message: "Keep the legacy error payload"
      })
    ).resolves.toBeUndefined();
    await expect(
      harness.engine.command(runId, {
        type: "steer",
        commandId: "steer-live-1",
        message: "Change the legacy payload"
      })
    ).rejects.toThrow(/different message/i);
  });

  it("does not re-invoke the model when resuming a run waiting for approval", async () => {
    // durable continuation recovery:Worker 崩溃在 waiting_approval 状态,
    // 下一次 resume(新 Worker 接管)必须停在等待批准处,
    // 不得重复调用模型——否则会把同一个 turn 当作新 turn 处理,
    // 产生重复 tool call 或丢失审批语义。
    let modelCalls = 0;
    const model: AgentModel = {
      next: async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            type: "tool_call" as const,
            callId: "call-1",
            tool: "execute_command" as const,
            arguments: { argv: ["pnpm", "test"] }
          };
        }
        return { type: "completed" as const, summary: "Done after approval" };
      }
    };
    const harness = await createTestHarness({ model });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run tests",
      acceptanceCriteria: ["All pass"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.resume(runId);
    expect(modelCalls).toBe(1); // 第一次 resume 触发模型调用,返回 tool_call 后等待批准

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "waiting_approval"
    });

    // 第二次 resume(模拟崩溃后重启/新 Worker 接管)
    await harness.engine.resume(runId);
    expect(modelCalls).toBe(1); // 模型不应被重复调用
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "waiting_approval"
    });

    // approve 后能正常推进
    await harness.engine.command(runId, {
      type: "approve",
      approvalId: "approval-call-1",
      scope: "once"
    });
    // approve 后 drive 继续,model 再调一次(completed)→ verify → succeeded
    expect(modelCalls).toBe(2);
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
  });

  it("denies commands listed in the run-scoped deniedCommands list", async () => {
    // run-scoped approval/rejection policy:每个 Run 可在 start 时声明
    // deniedCommands 列表,即使 approvalMode 是 full_access 也要拒绝。
    // 优先级高于 approvalMode 全局规则——这是"这个 Run 特定禁用某些命令"的边界。
    const harness = await createTestHarness({
      modelTurns: [
        {
          type: "tool_call",
          callId: "call-curl",
          tool: "execute_command",
          arguments: { argv: ["curl", "https://example.com"] }
        }
      ]
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Inspect the project",
      acceptanceCriteria: ["Read-only"],
      approvalMode: "full_access",
      fileAccessScope: "workspace_only",
      deniedCommands: ["curl", "docker"]
    });

    await harness.engine.resume(runId);

    const view = await harness.engine.inspect(runId);
    expect(view.status).toBe("failed");
    expect(view.failure?.code).toBe("policy_denied");
    expect(view.failure?.message).toContain("curl");
  });

  it("records a model failure instead of leaving the run active", async () => {
    const harness = await createTestHarness({
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

    await harness.engine.resume(runId);

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "failed",
      failure: {
        code: "agent_loop_failed",
        message: "Model provider unavailable"
      }
    });

    expect(
      parseSseEvents(await harness.events.resume(runId)).slice(-2)
    ).toEqual([
      expect.objectContaining({
        type: "run_failed",
        data: {
          code: "agent_loop_failed",
          message: "Model provider unavailable"
        }
      }),
      expect.objectContaining({
        type: "status_changed",
        data: { status: "failed" }
      })
    ]);
  });

  it("cancels a run while it is waiting for approval", async () => {
    const harness = await createTestHarness({
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

    await harness.engine.resume(runId);

    await harness.engine.command(runId, { type: "cancel" });

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "cancelled"
    });
  });

  it("publishes ordered status events for clients", async () => {
    const harness = await createTestHarness({ verificationOutcome: "passed" });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Add a health endpoint",
      acceptanceCriteria: ["Verification passes"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.resume(runId);

    const stream = await harness.events.resume(runId);
    // Decode only public SSE data fields; the test never reads RunStore internals.
    const statuses = stream
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)))
      .filter((event) => event.type === "status_changed")
      .map((event) => event.data.status);

    expect(statuses).toEqual([
      "queued",
      "preparing",
      "running",
      "verifying",
      "succeeded"
    ]);
  });

  it("enqueues a queued run without preparing an environment or calling the model", async () => {
    // 入队与执行分离:start 只持久化 queued Run 并立即返回,
    // 环境准备与模型调用必须等 Worker 侧 resume 驱动时才发生。
    let modelCalls = 0;
    const model: AgentModel = {
      next: async () => {
        modelCalls += 1;
        return { type: "completed", summary: "Should not be reached" };
      }
    };
    const environment = new RecordingRunEnvironment();
    const harness = await createTestHarness({ model, environment });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Add a health endpoint",
      acceptanceCriteria: ["Verification passes"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      id: runId,
      status: "queued"
    });
    expect(environment.prepareCount).toBe(0);
    expect(modelCalls).toBe(0);
  });

  it("keeps a run cancelled when cancellation lands during a pending model call", async () => {
    // 场景:引擎挂起在模型调用上时用户取消。取消必须最终生效--
    // 驱动循环恢复后不得用取消前的旧快照执行工具调用,也不得覆盖 cancelled 终态。
    let releaseFirstTurn!: (turn: AgentModelTurn) => void;
    let resolveModelEntered!: () => void;
    const modelEntered = new Promise<void>(
      (resolve) => (resolveModelEntered = resolve)
    );
    let modelCalls = 0;
    const model: AgentModel = {
      next: async () => {
        modelCalls += 1;
        resolveModelEntered();
        // 第一次调用挂起以打开竞态窗口;后续调用立即完成
        if (modelCalls === 1) {
          return new Promise<AgentModelTurn>(
            (resolve) => (releaseFirstTurn = resolve)
          );
        }
        return { type: "completed", summary: "Turn after cancellation" };
      }
    };
    const environment = new RecordingRunEnvironment();
    const harness = await createTestHarness({ model, environment });

    // 测试支架固定 createId 为 "run-1",start + resume 让驱动循环挂起再触发竞态
    const startPromise = harness.engine
      .start({
        projectId: "project-1",
        environmentId: "environment-1",
        task: "Run checks",
        acceptanceCriteria: ["Checks pass"],
        approvalMode: "auto_review",
        fileAccessScope: "workspace_only"
      })
      .then((runId) => harness.engine.resume(runId));

    await modelEntered; // 引擎已挂起在第一次模型调用上
    await harness.engine.command("run-1", { type: "cancel" });
    releaseFirstTurn({
      type: "tool_call",
      callId: "call-raced",
      tool: "execute_command",
      arguments: { argv: ["pnpm", "test"] }
    });
    await startPromise;

    const view = await harness.engine.inspect("run-1");
    expect(view.status).toBe("cancelled");
    expect(environment.performCount).toBe(0);
  });

  it("keeps a run cancelled when cancellation lands during an in-flight command execution", async () => {
    // 场景:工具命令已在执行(perform 挂起)时用户取消。命令返回后的
    // 过期写入必须被拒绝,不得把 cancelled 覆盖成 running/succeeded,
    // 也不得把 Run 记成 agent_loop_failed。
    let releasePerform!: (result: EnvironmentResult) => void;
    let resolvePerformEntered!: () => void;
    const performEntered = new Promise<void>(
      (resolve) => (resolvePerformEntered = resolve)
    );
    const environment: RunEnvironment = {
      prepare: async (spec) => ({
        id: `handle-${spec.runId}`,
        environmentId: spec.environmentId
      }),
      perform: async () => {
        resolvePerformEntered();
        // 命令挂起中,制造"取消先于命令完成"的时序
        return new Promise<EnvironmentResult>(
          (resolve) => (releasePerform = resolve)
        );
      },
      inspect: async () => ({ changedFiles: [] }),
      dispose: async () => {}
    };

    const harness = await createTestHarness({
      environment,
      modelTurns: [
        {
          type: "tool_call",
          callId: "call-inflight",
          tool: "execute_command",
          arguments: { argv: ["pnpm", "test"] }
        },
        { type: "completed", summary: "Completed after the in-flight command" }
      ]
    });

    // 测试支架固定 createId 为 "run-1",start + resume 让驱动循环推进到 perform 挂起再触发竞态
    const startPromise = harness.engine
      .start({
        projectId: "project-1",
        environmentId: "environment-1",
        task: "Run checks",
        acceptanceCriteria: ["Checks pass"],
        approvalMode: "auto_review",
        fileAccessScope: "workspace_only"
      })
      .then((runId) => harness.engine.resume(runId));

    await performEntered; // 工具命令已在执行中
    await harness.engine.command("run-1", { type: "cancel" });
    releasePerform({ exitCode: 0, stdout: "", stderr: "" });
    await startPromise;

    const view = await harness.engine.inspect("run-1");
    expect(view.status).toBe("cancelled");
    expect(view.failure).toBeUndefined();
  });

  it("treats resume as a no-op for terminal and cancelled runs", async () => {
    // Worker 周期性轮询场景:对终态 Run 调用 resume 必须无副作用,
    // 不得重新准备环境或再次驱动循环。
    const environment = new RecordingRunEnvironment();
    const harness = await createTestHarness({ environment });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.resume(runId);
    await harness.engine.command(runId, { type: "cancel" });
    const prepareBefore = environment.prepareCount;

    await harness.engine.resume(runId);
    await harness.engine.resume(runId);

    expect(environment.prepareCount).toBe(prepareBefore);
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "cancelled"
    });
  });

  it("resumes an in-progress run without re-preparing the environment", async () => {
    // Worker 重接管场景:首次 resume 已推进到 running;第二个 Worker 拿到
    // 同一 RunId 再次 resume 时,handle 已注册,必须直接续跑而不得重新准备。
    let resolveFirstTurn!: (turn: AgentModelTurn) => void;
    let firstTurnRequested!: Promise<void>;
    let resolveFirstTurnRequested!: () => void;
    firstTurnRequested = new Promise<void>(
      (resolve) => (resolveFirstTurnRequested = resolve)
    );
    let modelCalls = 0;
    const environment = new RecordingRunEnvironment();
    const model: AgentModel = {
      next: () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          resolveFirstTurnRequested();
          // 首次调用挂起,模拟 Worker 在模型调用边界崩溃
          return new Promise<AgentModelTurn>((resolve) => (resolveFirstTurn = resolve));
        }
        // 后续调用直接完成,模拟接管后的下一轮
        return Promise.resolve({
          type: "completed" as const,
          summary: "Recovered"
        });
      }
    };
    const harness = await createTestHarness({ model, environment });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    const firstResume = harness.engine.resume(runId);
    await firstTurnRequested; // 已挂起在首次模型调用上,prepare 已完成
    const prepareAfterFirst = environment.prepareCount;
    expect(prepareAfterFirst).toBe(1);

    // 第二个 Worker 接管:handle 仍在注册表里,必须直接续跑
    await harness.engine.resume(runId);
    expect(environment.prepareCount).toBe(prepareAfterFirst);

    // 释放首次 resume,让它走完驱动循环到 succeeded
    resolveFirstTurn({ type: "completed", summary: "First resume done" });
    await firstResume;
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
  });

  it("moves a run to environment_offline and disposes its environment on recover_environment", async () => {
    // Worker 在检测到本地环境无法继续(例如远端 Docker 失联、网络异常)时,
    // 必须主动放弃当前环境,转化为 environment_offline 并释放本地句柄,
    // 留给后续 Worker 重新 prepare。
    let releaseFirstTurn!: (turn: AgentModelTurn) => void;
    const environment = new RecordingRunEnvironment();
    const model: AgentModel = {
      next: () =>
        new Promise<AgentModelTurn>((resolve) => (releaseFirstTurn = resolve))
    };
    const harness = await createTestHarness({ model, environment });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    const resumePromise = harness.engine.resume(runId);
    // 等 prepareAndRun 完成并进入 running,挂起在首次模型调用上
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    await harness.engine.command(runId, {
      type: "recover_environment",
      reason: "Docker daemon unreachable"
    });

    expect(environment.disposeCount).toBe(1);
    expect(environment.lastDisposeOutcome).toBe("discard");
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "environment_offline"
    });

    releaseFirstTurn({ type: "completed", summary: "never reached" });
    await resumePromise.catch(() => undefined);
  });

  it("re-prepares an environment_offline run on the next resume", async () => {
    // Worker 重接管场景的延续:其他 Worker 把 Run 标为 environment_offline 后,
    // 任意 Worker 再次 resume 必须重新 prepare 并继续推进,而非无操作。
    const environment = new RecordingRunEnvironment();
    const harness = await createTestHarness({
      environment,
      verificationOutcome: "passed"
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.command(runId, {
      type: "recover_environment",
      reason: "Worker disconnected"
    });
    expect(environment.prepareCount).toBe(0);
    expect(environment.disposeCount).toBe(0);

    await harness.engine.resume(runId);
    expect(environment.prepareCount).toBe(1);
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
  });

  it("does not treat a re-resumed environment_offline run as a no-op even after a previous resume", async () => {
    // 严谨防护:recover_environment 必须从注册表中清掉句柄,否则下一次 resume
    // 会误判为"已注册"而跳过 prepareAndRun,导致 Run 永远卡在 offline。
    let releaseFirstTurn!: (turn: AgentModelTurn) => void;
    let modelCalls = 0;
    const model: AgentModel = {
      next: () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          // 首次 resume 挂起在模型调用上:已 prepare 且句柄已注册
          return new Promise<AgentModelTurn>(
            (resolve) => (releaseFirstTurn = resolve)
          );
        }
        return Promise.resolve({
          type: "completed" as const,
          summary: "Recovered"
        });
      }
    };
    const environment = new RecordingRunEnvironment();
    const harness = await createTestHarness({
      model,
      environment,
      verificationOutcome: "passed"
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    const resumeA = harness.engine.resume(runId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(environment.prepareCount).toBe(1);

    await harness.engine.command(runId, {
      type: "recover_environment",
      reason: "Worker disconnected"
    });
    expect(environment.disposeCount).toBe(1);

    releaseFirstTurn({ type: "completed", summary: "A done" });
    await resumeA;

    await harness.engine.resume(runId);
    expect(environment.prepareCount).toBe(2);
    // One discard handles offline recovery; terminal completion then keeps evidence.
    expect(environment.disposeCount).toBe(2);
    expect(environment.lastDisposeOutcome).toBe("keep");
    const view = await harness.engine.inspect(runId);
    expect(view.status).toBe("succeeded");
    expect(view.failure).toBeUndefined();
  });

  it("keeps terminal runs untouched when recover_environment arrives late", async () => {
    // 终态防复活:Run 已 succeeded 后迟到的恢复请求(命令或自检入口)
    // 必须是 no-op,不得把它拉回 environment_offline 重新驱动,
    // 也不得在终态清理完成后重复 dispose。
    const environment = new RecordingRunEnvironment();
    const harness = await createTestHarness({
      environment,
      verificationOutcome: "passed"
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.resume(runId); // -> succeeded

    // 两条入口都不得复活终态 Run
    await harness.engine.command(runId, {
      type: "recover_environment",
      reason: "late command"
    });
    await harness.engine.recoverEnvironment(runId);

    expect(environment.disposeCount).toBe(1);
    expect(environment.lastDisposeOutcome).toBe("keep");
    expect(environment.prepareCount).toBe(1);
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
  });

  it("grants a single lease per run and rejects concurrent resume from another worker", async () => {
    // 跨 Worker 互斥语义:同一 runId 的 lease 必须由唯一 owner 持有,
    // 第二个 Worker 的 resume 必须静默返回不得驱动 Run。
    const lease = createInMemoryRunLease();
    let releaseFirstTurn!: (turn: AgentModelTurn) => void;
    const environment = new RecordingRunEnvironment();
    const model: AgentModel = {
      next: () =>
        new Promise<AgentModelTurn>((resolve) => (releaseFirstTurn = resolve))
    };
    const harnessA = await createTestHarness({
      lease,
      model,
      environment,
      workerId: "worker-A"
    });

    const runId = await harnessA.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    const resumeA = harnessA.engine.resume(runId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // A 已挂起在首次模型调用,lease 由 worker-A 持有
    const harnessB = await createTestHarness({
      lease,
      environment,
      workerId: "worker-B"
    });
    await harnessB.engine.resume(runId); // 应静默返回:lease 已被 A 持有
    expect(environment.prepareCount).toBe(1); // B 没重新 prepare

    releaseFirstTurn({ type: "completed", summary: "A done" });
    await resumeA;
    await expect(harnessA.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
  });

  it("stops driving when the lease is invalidated mid-loop", async () => {
    // Worker 主动放弃场景:lease 被外部 invalidate 后,当前 drive 应在下一次
    // renewLease 时检测到失租,立即停止;Run 不进入终态,由新 owner 接管。
    const lease = createInMemoryRunLease();
    let releaseFirstTurn!: (turn: AgentModelTurn) => void;
    const environment = new RecordingRunEnvironment();
    const model: AgentModel = {
      next: () =>
        new Promise<AgentModelTurn>((resolve) => (releaseFirstTurn = resolve))
    };
    const harness = await createTestHarness({
      lease,
      model,
      environment,
      workerId: "worker-A"
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "full_access",
      fileAccessScope: "workspace_only"
    });

    const resumePromise = harness.engine.resume(runId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // 模拟"当前 Worker 被踢出":让 lease 被作废
    await lease.invalidate({ runId, ownerId: "worker-A" });

    releaseFirstTurn({ type: "tool_call", callId: "never", tool: "execute_command", arguments: { argv: ["echo"] } });
    await resumePromise;

    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "running"
    });
    expect(environment.performCount).toBe(0);
  });

  it("keeps the run untouched when the lease is lost before a terminal transition", async () => {
    // 失主写入防护:Worker A 挂起在模型调用上时 lease 被作废,随后释放的
    // completed turn 不得再触发 verifying/succeeded 等任何持久化状态写入,
    // 也不得把 Run 记成 agent_loop_failed--Run 保持 running,等新 owner 接管。
    const lease = createInMemoryRunLease();
    let releaseFirstTurn!: (turn: AgentModelTurn) => void;
    const environment = new RecordingRunEnvironment();
    const model: AgentModel = {
      next: () =>
        new Promise<AgentModelTurn>((resolve) => (releaseFirstTurn = resolve))
    };
    const harness = await createTestHarness({
      lease,
      model,
      environment,
      workerId: "worker-A"
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    const resumePromise = harness.engine.resume(runId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // A 已挂起在首次模型调用上;作废 A 的租约模拟被抢占/过期
    await lease.invalidate({ runId, ownerId: "worker-A" });

    releaseFirstTurn({ type: "completed", summary: "stale owner finished" });
    await resumePromise; // 失租属于预期并发事件,resume 不得向调度器抛错

    const view = await harness.engine.inspect(runId);
    expect(view.status).toBe("running");
    expect(view.failure).toBeUndefined();
  });

  it("recovers a durably completed tool result after lease loss", async () => {
    // 旧 owner 失租后不得写 Run 快照;接管者改从幂等账本恢复同一 callId
    // 的完成结果，再把它作为唯一可信的 toolResults 输入交给模型。
    const lease = createInMemoryRunLease();
    // 可观察面:每次模型调用收到的 toolResults 输入(接管者视角)
    const observedToolResults: ModelToolResult[][] = [];
    let releaseFirstTurn!: (turn: AgentModelTurn) => void;
    let resolveFirstTurnRequested!: () => void;
    const firstTurnRequested = new Promise<void>(
      (resolve) => (resolveFirstTurnRequested = resolve)
    );
    let modelCalls = 0;
    const model: AgentModel = {
      next: async (input) => {
        modelCalls += 1;
        // 克隆捕获,避免引擎后续 push 污染历史观察
        observedToolResults.push(structuredClone(input.toolResults));
        if (modelCalls === 1) {
          resolveFirstTurnRequested();
          // 首次调用挂起,打开 perform 竞态窗口
          return new Promise<AgentModelTurn>(
            (resolve) => (releaseFirstTurn = resolve)
          );
        }
        return { type: "completed", summary: "Takeover turn" };
      }
    };
    let releasePerform!: (result: EnvironmentResult) => void;
    let resolvePerformEntered!: () => void;
    const performEntered = new Promise<void>(
      (resolve) => (resolvePerformEntered = resolve)
    );
    let performCount = 0;
    const environment: RunEnvironment = {
      prepare: async (spec) => ({
        id: `handle-${spec.runId}`,
        environmentId: spec.environmentId
      }),
      perform: async () => {
        performCount += 1;
        resolvePerformEntered();
        // 命令挂起中,把失租时点卡在 perform 的 await 窗口内
        return new Promise<EnvironmentResult>(
          (resolve) => (releasePerform = resolve)
        );
      },
      inspect: async () => ({ changedFiles: [] }),
      dispose: async () => {}
    };
    const harness = await createTestHarness({
      lease,
      model,
      environment,
      workerId: "worker-A"
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "full_access",
      fileAccessScope: "workspace_only"
    });

    const resumeA = harness.engine.resume(runId);
    await firstTurnRequested; // 首次模型调用已挂起
    releaseFirstTurn({
      type: "tool_call",
      callId: "call-stale",
      tool: "execute_command",
      arguments: { argv: ["pnpm", "test"] }
    });
    await performEntered; // 工具命令已在执行中

    // perform 的 await 窗口内租约被作废:模拟新 owner 抢占
    await lease.invalidate({ runId, ownerId: "worker-A" });
    releasePerform({ exitCode: 0, stdout: "done", stderr: "" });
    await resumeA; // 失租:resume 静默放弃,不向调度器抛错

    // 下一次 resume(任意 Worker)接管续跑
    await harness.engine.resume(runId);

    expect(observedToolResults).toEqual([
      [],
      [
        {
          callId: "call-stale",
          status: "executed",
          exitCode: 0,
          stdout: "done",
          stderr: ""
        }
      ]
    ]);
    expect(performCount).toBe(1);
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
    const toolEvents = parseSseEvents(
      await harness.events.resume(runId)
    ).filter(
      (event) => event.type === "tool_started" || event.type === "tool_completed"
    );
    expect(toolEvents).toEqual([
      expect.objectContaining({
        type: "tool_started",
        data: expect.objectContaining({ callId: "call-stale" })
      }),
      expect.objectContaining({
        type: "tool_completed",
        data: expect.objectContaining({
          callId: "call-stale",
          recovered: true
        })
      })
    ]);
  });

  it("parks an environment failure and refuses to replay its uncertain call", async () => {
    // perform 抛错先转 environment_offline 以便换环境;但调用可能已产生
    // 部分副作用，接管时必须恢复原 callId 并由账本判为 outcome_unknown，
    // 不得重新询问模型或自动重放。
    let releaseFirstTurn!: (turn: AgentModelTurn) => void;
    let modelCalls = 0;
    const model: AgentModel = {
      next: () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return new Promise<AgentModelTurn>(
            (resolve) => (releaseFirstTurn = resolve)
          );
        }
        return Promise.resolve({
          type: "completed" as const,
          summary: "Recovered after re-prepare"
        });
      }
    };
    let performCount = 0;
    let prepareCount = 0;
    const environment: RunEnvironment = {
      prepare: async (spec) => {
        prepareCount += 1;
        return { id: `handle-${spec.runId}`, environmentId: spec.environmentId };
      },
      perform: async () => {
        performCount += 1;
        // 模拟真实 I/O 失败:Docker daemon unreachable、网络异常等
        throw new Error("Docker daemon unreachable");
      },
      inspect: async () => ({ changedFiles: [] }),
      dispose: async () => {}
    };
    const harness = await createTestHarness({
      model,
      environment,
      verificationOutcome: "passed"
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "full_access",
      fileAccessScope: "workspace_only"
    });

    const resumeA = harness.engine.resume(runId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    releaseFirstTurn({
      type: "tool_call",
      callId: "call-failing",
      tool: "execute_command",
      arguments: { argv: ["pnpm", "test"] }
    });
    await resumeA; // perform 抛错:resume 必须不向调度器抛错

    const view = await harness.engine.inspect(runId);
    expect(view.status).toBe("environment_offline");
    expect(view.failure).toBeUndefined();
    expect(performCount).toBe(1);

    // 下次 resume 会重 prepare，但同一未完成 claim 只能进入人工核对终态。
    await harness.engine.resume(runId);
    expect(prepareCount).toBe(2);
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "tool_call_outcome_unknown" }
    });
    expect(modelCalls).toBe(1);
    expect(performCount).toBe(1);
  });

  it("waits for the lease to expire before taking over a run", async () => {
    // 重试队列:Lease 被持有时,B 的 resume 不得立即放弃,而应在策略窗口内
    // 轮询直至 lease 过期再接管。可观察面:attempt 计数(>1)且 B 接管后 Run
    // 推进到 succeeded(共享 store 让两侧可见同一持久化快照)。
    const lease = createInMemoryRunLease();
    const sharedStore = new InMemoryRunStore();
    let releaseFirstTurn!: (turn: AgentModelTurn) => void;
    let modelCalls = 0;
    const model: AgentModel = {
      next: () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return new Promise<AgentModelTurn>(
            (resolve) => (releaseFirstTurn = resolve)
          );
        }
        return Promise.resolve({
          type: "completed" as const,
          summary: "Takeover completed"
        });
      }
    };
    const environment = new RecordingRunEnvironment();
    const attempts: number[] = [];
    const fastRetry: import("@lecoding/contracts").RetryPolicy = {
      shouldRetry: ({ elapsedMs }) => elapsedMs < 1_000,
      wait: async ({ attempt }) => {
        attempts.push(attempt);
        // 短间隔避免测试拖长;leaseMilliseconds=30 让 lease 在 30ms 后过期
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        return 0;
      }
    };
    const harnessA = await createTestHarness({
      lease,
      model,
      environment,
      workerId: "worker-A",
      leaseMilliseconds: 30,
      retry: fastRetry,
      store: sharedStore
    });
    const harnessB = await createTestHarness({
      lease,
      environment,
      workerId: "worker-B",
      retry: fastRetry,
      store: sharedStore
    });

    const runId = await harnessA.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    const resumeA = harnessA.engine.resume(runId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const resumeB = harnessB.engine.resume(runId); // 等待 lease 过期
    releaseFirstTurn({ type: "completed", summary: "A done" });
    await resumeA;

    await resumeB;
    // 关键现象:wait 至少被调用过一次 -> 证明重试发生而非立即拿到 lease
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    // 重试后 B 接管成功:Run 已被 A 推到 running,A 释放后 B 继续驱动到 succeeded
    await expect(harnessB.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
    // 整个生命周期只 prepare 一次,验证 B 复用了 A 的环境
    expect(environment.prepareCount).toBe(1);
  });

  it("moves a run to environment_offline when prepare throws", async () => {
    // prepare 抛错联动:与 perform 抛错一致,环境准备失败(远端 Docker 镜像拉取失败、
    // workspace 不可访问等)必须自动转 environment_offline,不得记为 agent_loop_failed,
    // 也不得向上抛错给调度器。Run 后续可被任意 Worker 接管续跑。
    const environment: RunEnvironment = {
      prepare: async () => {
        // 模拟真实环境失败:远端镜像拉取超时、网络不可达等
        throw new Error("image pull timed out");
      },
      perform: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      inspect: async () => ({ changedFiles: [] }),
      dispose: async () => {}
    };
    let prepareCount = 0;
    const wrappedEnvironment: RunEnvironment = {
      prepare: async (spec) => {
        prepareCount += 1;
        return environment.prepare(spec);
      },
      perform: environment.perform,
      inspect: environment.inspect,
      dispose: environment.dispose
    };
    const harness = await createTestHarness({
      environment: wrappedEnvironment,
      verificationOutcome: "passed"
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.resume(runId); // 必须不向调度器抛错

    const view = await harness.engine.inspect(runId);
    expect(view.status).toBe("environment_offline");
    expect(view.failure).toBeUndefined();
    expect(prepareCount).toBe(1);
  });

  it("keeps the lease alive across a long-running prepare", async () => {
    // prepare 心跳:prepare 是真实环境的长 await(镜像拉取可达数分钟),
    // 必须按 leaseMilliseconds/2 间隔持续续约,否则会因租约过期被新 Worker
    // 接管。可观察面:在 prepare 持续期间 B 尝试 resume 拿不到 lease,
    // 且 lease 续约次数 > 1(证明心跳生效)。
    const lease = createInMemoryRunLease();
    const sharedStore = new InMemoryRunStore();
    let resolvePrepare!: () => void;
    let prepareEntered!: Promise<void>;
    prepareEntered = new Promise<void>((resolve) => {
      resolvePrepare = () => resolve();
    });
    let prepareCount = 0;
    const environment: RunEnvironment = {
      prepare: async (spec) => {
        prepareCount += 1;
        prepareEntered = new Promise<void>((resolve) => {
          // prepare 进入后挂起,等待外部 resolve
          resolvePrepare = () => resolve();
        });
        await prepareEntered;
        return { id: `handle-${spec.runId}`, environmentId: spec.environmentId };
      },
      perform: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      inspect: async () => ({ changedFiles: [] }),
      dispose: async () => {}
    };
    const renewCounts: number[] = [];
    const wrappedLease: import("@lecoding/contracts").RunLease = {
      acquire: (input) =>
        lease.acquire(input),
      renew: async (input) => {
        const ok = await lease.renew(input);
        renewCounts.push(Date.now());
        return ok;
      },
      release: (input) => lease.release(input),
      invalidate: (input) => lease.invalidate(input)
    };
    const harnessA = await createTestHarness({
      lease: wrappedLease,
      environment,
      workerId: "worker-A",
      // lease 极短(40ms),prepare 心跳 20ms 一次,正好跨多个心跳周期
      leaseMilliseconds: 40,
      store: sharedStore
    });
    const harnessB = await createTestHarness({
      lease: wrappedLease,
      environment: new RecordingRunEnvironment(),
      workerId: "worker-B",
      store: sharedStore
    });

    const runId = await harnessA.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    const resumeA = harnessA.engine.resume(runId);
    // 等 prepare 进入(已通过 transition("preparing"))
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // A 在 prepare 上挂起时,B 尝试 resume 必须被拒(因为心跳持续续约)
    const resumeB = harnessB.engine.resume(runId);
    // 等待若干个心跳周期再让 prepare 完成
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    resolvePrepare();
    await resumeA;
    await resumeB;

    expect(prepareCount).toBe(1); // A 一次性完成,B 不得重复 prepare
    expect(renewCounts.length).toBeGreaterThan(1); // 证明心跳续约多次
    await expect(harnessB.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
  });

  it("keeps the lease alive across a long-running verify", async () => {
    // verify 心跳:verifier.verify 是远端报告服务调用,可达数十秒。
    // 同样必须按 leaseMilliseconds/2 持续续约,否则 verify 期间失主。
    // 可观察面:verify 挂起期间续约计数 > 1,B resume 被拒,Run 走到 succeeded。
    const lease = createInMemoryRunLease();
    const sharedStore = new InMemoryRunStore();
    const renewCounts: number[] = [];
    const wrappedLease: import("@lecoding/contracts").RunLease = {
      acquire: (input) => lease.acquire(input),
      renew: async (input) => {
        const ok = await lease.renew(input);
        renewCounts.push(Date.now());
        return ok;
      },
      release: (input) => lease.release(input),
      invalidate: (input) => lease.invalidate(input)
    };
    let resolveVerify!: () => void;
    let verifyEntered!: Promise<void>;
    verifyEntered = new Promise<void>((resolve) => {
      resolveVerify = () => resolve();
    });
    const environment = new RecordingRunEnvironment();
    const model = {
      next: async () => ({ type: "completed" as const, summary: "Done" })
    };
    const verifier: import("@lecoding/verifier").Verifier = {
      verify: async () => {
        verifyEntered = new Promise<void>((resolve) => {
          resolveVerify = () => resolve();
        });
        await verifyEntered;
        return {
          outcome: "passed" as const,
          checks: [{ name: "ok", outcome: "passed" as const, detail: "ok" }]
        };
      }
    };
    const harnessA = await createTestHarness({
      lease: wrappedLease,
      model,
      environment,
      verifier,
      workerId: "worker-A",
      leaseMilliseconds: 40,
      store: sharedStore
    });
    const harnessB = await createTestHarness({
      lease: wrappedLease,
      environment: new RecordingRunEnvironment(),
      workerId: "worker-B",
      store: sharedStore
    });

    const runId = await harnessA.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    const resumeA = harnessA.engine.resume(runId);
    // 等到 verify 进入(已通过 transition("verifying"))
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // verify 挂起时 B 尝试 resume 必须被拒
    const resumeB = harnessB.engine.resume(runId);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    resolveVerify();
    await resumeA;
    await resumeB;

    expect(renewCounts.length).toBeGreaterThan(1); // 心跳持续续约
    await expect(harnessB.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
  });

  it("passes the run cancellation signal into verification", async () => {
    const cancelBus = new InMemoryRunCancelBus();
    let enteredVerification!: () => void;
    const verificationEntered = new Promise<void>((resolve) => {
      enteredVerification = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const harness = await createTestHarness({
      cancelBus,
      verifier: {
        async verify(_input, signal) {
          receivedSignal = signal;
          enteredVerification();
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              resolve();
              return;
            }
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return {
            outcome: "inconclusive",
            checks: [
              {
                name: "verification cancellation",
                outcome: "inconclusive",
                detail: "Verification was cancelled"
              }
            ]
          };
        }
      }
    });
    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    const resume = harness.engine.resume(runId);
    await verificationEntered;
    await cancelBus.publish(runId);
    await resume;

    expect(receivedSignal?.aborted).toBe(true);
  });

  it("invalidates the lease when the heartbeat renew fails mid-await", async () => {
    // 跨进程旁路语义:本地心跳续约失败(例如网络分区、PG 不可达)时,
    // 心跳必须主动 invalidate 当前 lease 让其他 Worker 立刻接管,
    // 而不是等 lease 自然过期(本地 leaseMilliseconds 不可靠--setInterval
    // 可能已暂停执行)。可观察面:外部触发 renew=false 后,
    // 当前 Run 的 lease 被 invalidate,Fn resolve 后心跳抛 LeaseLostError。
    const lease = createInMemoryRunLease();
    let resolvePrepare!: () => void;
    let prepareEntered!: Promise<void>;
    prepareEntered = new Promise<void>((resolve) => {
      resolvePrepare = () => resolve();
    });
    const environment: RunEnvironment = {
      prepare: async (spec) => {
        prepareEntered = new Promise<void>((resolve) => {
          resolvePrepare = () => resolve();
        });
        await prepareEntered;
        return { id: `handle-${spec.runId}`, environmentId: spec.environmentId };
      },
      perform: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      inspect: async () => ({ changedFiles: [] }),
      dispose: async () => {}
    };
    let renewShouldFail = false;
    const wrappedLease: import("@lecoding/contracts").RunLease = {
      acquire: (input) => lease.acquire(input),
      renew: async (input) => {
        if (renewShouldFail) {
          return false;
        }
        return lease.renew(input);
      },
      release: (input) => lease.release(input),
      invalidate: (input) => lease.invalidate(input)
    };
    let invalidatedAt = 0;
    const spyingLease: import("@lecoding/contracts").RunLease = {
      acquire: (input) => wrappedLease.acquire(input),
      renew: (input) => wrappedLease.renew(input),
      release: (input) => wrappedLease.release(input),
      invalidate: async (input) => {
        invalidatedAt = Date.now();
        await wrappedLease.invalidate(input);
      }
    };
    const harness = await createTestHarness({
      lease: spyingLease,
      environment,
      workerId: "worker-A",
      leaseMilliseconds: 30
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    const resumePromise = harness.engine.resume(runId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // 触发下一次心跳续约失败
    renewShouldFail = true;
    // 等下一次心跳周期触达(interval=15ms)
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // heartbeat 已主动 invalidate 当前 lease
    expect(invalidatedAt).toBeGreaterThan(0);

    // resolve prepare 让 fn 走完,心跳应在 fn 完成时抛 LeaseLostError
    resolvePrepare();
    // lease 已被 invalidate,即便 leaseMilliseconds=30 在 prepare 内被 invalidate 替换
    // resume 必须不向调度器抛错(静默放弃)
    await resumePromise; // 不应抛错

    // lease 被作废后任何后续 acquire 都不会冲突
    const finalLease = await lease.acquire({
      runId,
      ownerId: "worker-B",
      leaseUntil: new Date(Date.now() + 30_000).toISOString()
    });
    expect(finalLease).toBeDefined();
  });

  it("recovers the environment from a worker self-check without the command interface", async () => {
    // Worker 内部故障自检场景:环境探测失败时,Worker 通过专用入口
    // (而非用户 command 接口)独立获取租约,把 Run 转为 environment_offline
    // 并 dispose 已注册环境;下一次 resume 重新 prepare 并续跑到终态。
    const lease = createInMemoryRunLease();
    let releaseFirstTurn!: (turn: AgentModelTurn) => void;
    let modelCalls = 0;
    const model: AgentModel = {
      next: () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          // 首次调用挂起,让 A 处于持租约 + 句柄已注册的运行中状态
          return new Promise<AgentModelTurn>(
            (resolve) => (releaseFirstTurn = resolve)
          );
        }
        return Promise.resolve({
          type: "completed" as const,
          summary: "Recovered after re-prepare"
        });
      }
    };
    const environment = new RecordingRunEnvironment();
    const harness = await createTestHarness({
      lease,
      model,
      environment,
      workerId: "worker-A"
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "auto_review",
      fileAccessScope: "workspace_only"
    });

    const resumeA = harness.engine.resume(runId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // A 挂起在首次模型调用上;自检入口不经 command 接口直接执行恢复
    await harness.engine.recoverEnvironment(runId);

    expect(environment.disposeCount).toBe(1);
    expect(environment.lastDisposeOutcome).toBe("discard");
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "environment_offline"
    });

    // A 的驱动循环恢复后停在非 running 状态,不得抛错
    releaseFirstTurn({ type: "completed", summary: "A done" });
    await resumeA;

    // 下一次 resume 重新 prepare 并续跑到终态
    await harness.engine.resume(runId);
    expect(environment.prepareCount).toBe(2);
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "succeeded"
    });
  });
});

/** Parses the public SSE seam so lifecycle assertions match Web replay behavior. */
function parseSseEvents(payload: string): Array<{
  type: string;
  data: Record<string, unknown>;
}> {
  return payload
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as {
      type: string;
      data: Record<string, unknown>;
    });
}

describe("Docker runtime limits + cancellation PoC", () => {
  it("aborts an in-flight perform when the run is cancelled", async () => {
    // PoC 取消语义:RunEngine 在 cancel 命令进入时调 handles.abort(runId),
    // 适配器收到 AbortSignal 立即 reject perform。
    // 可观察面:perform 提前 reject(< 1s 而非长 await),Run 终态 cancelled,
    // dispose 被调。
    const env = new FakeDockerRunEnvironment({ commandDurationMs: 60_000 });
    let performStarted = false;
    let performRejectReason = "";
    const wrappedEnv: RunEnvironment = {
      prepare: env.prepare.bind(env),
      perform: async (handle, action, signal) => {
        performStarted = true;
        try {
          return await env.perform(handle, action, signal);
        } catch (e) {
          performRejectReason = (e as Error).message;
          throw e;
        }
      },
      inspect: env.inspect.bind(env),
      dispose: env.dispose.bind(env)
    };
    const harness = await createTestHarness({
      environment: wrappedEnv,
      modelTurns: [
        {
          type: "tool_call",
          callId: "call-cancel",
          tool: "execute_command",
          arguments: { argv: ["sleep", "60"] }
        }
      ]
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Long-running command",
      acceptanceCriteria: ["Pass"],
      approvalMode: "full_access",
      fileAccessScope: "workspace_only"
    });

    const resumePromise = harness.engine.resume(runId);
    // 等到 perform 进入(模型已返回 tool_call)
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(performStarted).toBe(true);

    // cancel 命令:由于 lease 现在由 A worker 持有,cancel 命令需等 lease 释放。
    // harness 默认 lease 24h,但 dispose 期间 lease 仍被持有——这里用一个简单
    // 的方法绕过:让 perform 短到不会卡住,但我们想测的是中断语义。
    // 实际场景:A worker 在 perform 中不续约 → lease 过期 → cancel 抢到。
    // 这里用超时 setTimeout 模拟 lease 失效后的 cancel 路径,直接调 abort:
    const cancelPromise = harness.engine.command(runId, { type: "cancel" });
    // 给 cancel 一点时间获取 lease
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    await resumePromise;
    await cancelPromise;

    expect(performRejectReason).toMatch(/aborted|cancel/i);
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "cancelled"
    });
  });

  it("does not replay a command after the perform exceeds the memory limit", async () => {
    // PoC runtime limits:perform 抛错(模拟 cgroup OOM kill)触发
    // RunEngine 的 environment_offline 自动联动,Run 进入 environment_offline,
    // 下次 resume 重新 prepare 后仍需把未完成 claim 作为不确定结果停住。
    const env = new FakeDockerRunEnvironment({
      failNextCommand: "memory_exceeded"
    });
    let prepareCount = 0;
    const wrappedEnv: RunEnvironment = {
      prepare: async (spec) => {
        prepareCount += 1;
        return env.prepare(spec);
      },
      perform: env.perform.bind(env),
      inspect: env.inspect.bind(env),
      dispose: env.dispose.bind(env)
    };
    const harness = await createTestHarness({
      environment: wrappedEnv,
      modelTurns: [
        {
          type: "tool_call",
          callId: "call-oom",
          tool: "execute_command",
          arguments: { argv: ["node", "-e", "alloc"] }
        },
        { type: "completed", summary: "Recovered after memory fix" }
      ]
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Memory-intensive task",
      acceptanceCriteria: ["Pass"],
      approvalMode: "full_access",
      fileAccessScope: "workspace_only"
    });

    await harness.engine.resume(runId);

    // 第一次 resume:perform 抛 OOM → environment_offline
    expect(prepareCount).toBe(1);
    const offline = await harness.engine.inspect(runId);
    expect(offline.status).toBe("environment_offline");

    // 第二次 resume:重新 prepare,但不重放可能已部分执行的命令
    await harness.engine.resume(runId);
    expect(prepareCount).toBe(2);
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "tool_call_outcome_unknown" }
    });
  });

  it("drives a run to cancelled when perform is aborted, not environment_offline", async () => {
    // 区分 abort 触发的 error 与真实 I/O 错误的语义:
    // cancel 命令的 handles.abort() 触发 AbortSignal,perform 中断 reject,
    // drive 收到 error 时应识别为 cancel(而非环境 I/O 错误),
    // 直接转 cancelled,不得绕路 environment_offline(避免不必要的重 prepare)。
    // 可观察面:
    // - perform reject 的 error 是 RunCancelledByAbortError 类型
    // - Run 终态 cancelled(不是 environment_offline)
    // - Run 在 cancelled 状态下不再需要重新 prepare(drive 没进入重试路径)
    const env = new FakeDockerRunEnvironment({ commandDurationMs: 60_000 });
    let prepareCount = 0;
    const wrappedEnv: RunEnvironment = {
      prepare: async (spec) => {
        prepareCount += 1;
        return env.prepare(spec);
      },
      perform: env.perform.bind(env),
      inspect: env.inspect.bind(env),
      dispose: env.dispose.bind(env)
    };
    const harness = await createTestHarness({
      environment: wrappedEnv,
      modelTurns: [
        {
          type: "tool_call",
          callId: "call-aborted",
          tool: "execute_command",
          arguments: { argv: ["sleep", "60"] }
        }
      ]
    });

    const runId = await harness.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Cancel by abort",
      acceptanceCriteria: ["Pass"],
      approvalMode: "full_access",
      fileAccessScope: "workspace_only"
    });

    const resumePromise = harness.engine.resume(runId);
    // 等 perform 进入(已注册 handle + abort controller)
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // 触发 cancel 命令的 abort 信号
    const cancelPromise = harness.engine.command(runId, { type: "cancel" });
    await resumePromise;
    await cancelPromise;

    // 可观察面:
    // - Run 终态是 cancelled(不是 environment_offline)
    // - prepareCount 仍为 1——说明 drive 没走 environment_offline 重试路径,
    //   而是直接转 cancelled
    // (perform reject 时 RunEngine 内部会把 abort 触发的 error 包成
    // RunCancelledByAbortError;wrappedEnv 在外层 catch 看到的是 env 原始 error,
    // 这里通过终态与 prepareCount 间接验证 RunEngine 走了正确路径。)
    expect(prepareCount).toBe(1); // 没有重 prepare——cancel 路径不重 prepare
    await expect(harness.engine.inspect(runId)).resolves.toMatchObject({
      status: "cancelled"
    });
  });
});

/** 记录环境准备与工具调用次数的内存环境,用于断言入队/取消后不再触发执行。 */
class RecordingRunEnvironment implements RunEnvironment {
  prepareCount = 0;
  performCount = 0;
  disposeCount = 0;
  lastDisposeOutcome: "keep" | "discard" | undefined;

  async prepare(spec: EnvironmentSpec): Promise<EnvironmentHandle> {
    this.prepareCount += 1;
    return { id: `handle-${spec.runId}`, environmentId: spec.environmentId };
  }

  async perform(): Promise<EnvironmentResult> {
    this.performCount += 1;
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async inspect(): Promise<EnvironmentReport> {
    return { changedFiles: [] };
  }

  async dispose(
    _handle: EnvironmentHandle,
    outcome: "keep" | "discard"
  ): Promise<void> {
    this.disposeCount += 1;
    this.lastDisposeOutcome = outcome;
  }
}
