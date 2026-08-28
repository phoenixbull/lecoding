import { describe, expect, it } from "vitest";
import type { JsonValue } from "@lecoding/contracts";
import {
  canLoadRunChanges,
  canResolveRunResult,
  formatEventTitle,
  formatApprovalDetails,
  formatEditableApproval,
  formatProjectPolicyRule,
  formatRunEventDetail,
  isTerminalStatus,
  isTerminalRunEvent,
  resolveProjectSelection,
  statusLabel,
  verificationTone
} from "../src/presentation.js";

describe("Web Run presentation", () => {
  it("preserves a registered project selection and falls back to the server default", () => {
    const config = {
      projectId: "project-a",
      projects: [{ id: "project-a" }, { id: "project-b" }],
      defaultEnvironmentId: "local"
    };

    expect(resolveProjectSelection(config, "project-b")).toEqual({
      projectIds: ["project-a", "project-b"],
      selectedProjectId: "project-b"
    });
    expect(resolveProjectSelection(config, "removed-project")).toEqual({
      projectIds: ["project-a", "project-b"],
      selectedProjectId: "project-a"
    });
    expect(
      resolveProjectSelection({ ...config, projectId: "stale-default" }, undefined)
    ).toEqual({
      projectIds: ["project-a", "project-b"],
      selectedProjectId: "project-a"
    });
  });

  it("maps terminal and verification states without treating inconclusive as pass", () => {
    expect(isTerminalStatus("succeeded")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(isTerminalStatus("verifying")).toBe(false);
    expect(verificationTone("passed")).toBe("positive");
    expect(verificationTone("failed")).toBe("negative");
    expect(verificationTone("inconclusive")).toBe("warning");
    // A worktree does not exist while preparing and is discarded after cancel.
    expect(canLoadRunChanges("queued")).toBe(false);
    expect(canLoadRunChanges("preparing")).toBe(false);
    expect(canLoadRunChanges("running")).toBe(true);
    expect(canLoadRunChanges("waiting_approval")).toBe(true);
    expect(canLoadRunChanges("succeeded")).toBe(true);
    expect(canLoadRunChanges("cancelled")).toBe(false);
    // Only completed worktrees can be kept or discarded by the user.
    expect(canResolveRunResult("succeeded")).toBe(true);
    expect(canResolveRunResult("failed")).toBe(true);
    expect(canResolveRunResult("running")).toBe(false);
    expect(canResolveRunResult("cancelled")).toBe(false);
  });

  it("provides stable Chinese labels for status and timeline events", () => {
    expect(statusLabel("waiting_approval")).toBe("等待审批");
    expect(formatEventTitle("verification_completed")).toBe("验证完成");
    expect(formatEventTitle("agent_question")).toBe("Agent 追问");
    expect(
      formatRunEventDetail({
        version: 1,
        sequence: 2,
        runId: "run-1",
        type: "user_message_submitted",
        occurredAt: "2026-08-26T00:00:00.000Z",
        data: { mode: "steer", message: "保持 API 兼容" }
      })
    ).toBe("保持 API 兼容");
    expect(
      isTerminalRunEvent({
        version: 1,
        sequence: 3,
        runId: "run-1",
        type: "status_changed",
        occurredAt: "2026-08-26T00:00:00.000Z",
        data: { status: "succeeded" }
      })
    ).toBe(true);
  });

  it("renders bounded lifecycle evidence without exposing raw event objects", () => {
    const event = (
      type: Parameters<typeof formatEventTitle>[0],
      data: JsonValue
    ) =>
      formatRunEventDetail({
        version: 1,
        sequence: 8,
        runId: "run-1",
        type,
        occurredAt: "2026-08-26T00:00:00.000Z",
        data
      });

    expect(
      event("approval_requested", { summary: "Run pnpm test", secret: "hidden" })
    ).toBe("Run pnpm test");
    expect(event("tool_started", { command: "pnpm", argumentCount: 2 })).toBe(
      "pnpm（2 个参数）"
    );
    expect(
      event("tool_completed", { outcome: "executed", exitCode: 0 })
    ).toBe("执行完成，退出码 0");
    expect(
      event("verification_completed", { outcome: "passed", checkCount: 3 })
    ).toBe("验证通过（3 项检查）");
    expect(
      event("run_failed", { code: "agent_loop_failed", message: "Provider unavailable" })
    ).toBe("Provider unavailable（agent_loop_failed）");
  });

  it("presents a network approval with risk, reason, exact target, and scopes", () => {
    expect(
      formatApprovalDetails({
        id: "approval-network",
        callId: "network-1",
        summary: "Connect to https://registry.npmjs.org:443",
        capabilityType: "network_egress",
        capabilityHash: "a".repeat(64),
        reason: "Capability requires approval",
        riskLevel: "medium",
        allowedScopes: ["once", "run"]
      })
    ).toEqual({
      capability: "网络访问",
      risk: "中风险",
      reason: "Capability requires approval",
      target: "Connect to https://registry.npmjs.org:443",
      allowedScopes: [
        { value: "once", label: "仅本次调用" },
        { value: "run", label: "本 Run 内相同端点" }
      ]
    });
  });

  it("presents an active project rule without exposing raw constraints", () => {
    expect(
      formatProjectPolicyRule({
        id: "rule-1",
        projectId: "project-1",
        capabilityType: "network_egress",
        capabilityHash: "a".repeat(64),
        constraints: { host: "registry.npmjs.org", secret: "must-not-render" },
        decision: "allow",
        createdBy: "user-admin",
        sourceApprovalId: "approval-1",
        createdAt: "2026-08-28T00:00:00.000Z"
      })
    ).toEqual({
      id: "rule-1",
      capability: "网络访问",
      decision: "允许",
      fingerprint: "aaaaaaaaaaaa",
      active: true
    });
  });

  it("presents command argv as one inert argument per line for safe editing", () => {
    expect(
      formatEditableApproval({
        id: "approval-edit",
        callId: "call-edit",
        summary: "Run pnpm test --force",
        editableCapability: {
          type: "command_exec",
          argv: ["pnpm", "test", "--force"]
        }
      })
    ).toEqual({
      kind: "command_exec",
      label: "编辑命令参数（每行一个 argv）",
      value: "pnpm\ntest\n--force",
      help: "只能删除参数并保持原顺序；修改后仅允许本次调用。"
    });
  });
});
