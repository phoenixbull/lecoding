import { describe, expect, it } from "vitest";
import type {
  ControlPlaneConfig,
  PendingApproval,
  RunBudgetView,
  RunEventV1,
  RunStatus
} from "@lecoding/contracts";
import {
  approvalModeOptions,
  canLoadRunChanges,
  canResolveRunResult,
  canSteerRun,
  formatApprovalDetails,
  formatEditableApproval,
  formatEventTitle,
  formatProjectPolicyRule,
  formatRunBudget,
  formatRunEventDetail,
  isTerminalRunEvent,
  isTerminalStatus,
  resolveProjectSelection,
  statusLabel,
  verificationTone
} from "../src/presentation.js";

function makeBudget(overrides: Partial<RunBudgetView> = {}): RunBudgetView {
  return {
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 2,
    totalTokens: 15,
    maxTotalTokens: 100,
    costUsd: 0.5,
    maxCostUsd: 2,
    warningCostUsd: 1,
    maxWallTimeMs: 60_000,
    elapsedMs: 30_000,
    toolCalls: 3,
    maxToolCalls: 20,
    modelRetries: 0,
    maxModelRetries: 3,
    teamMonthlyCostUsd: 1,
    teamMonthlyWarningUsd: 8,
    teamMonthlyMaxUsd: 10,
    modelId: "claude-sonnet-4-5",
    pricingVersion: "2026-01",
    warnings: [],
    ...overrides
  };
}

describe("status predicates", () => {
  it("treats only succeeded, failed, and cancelled as terminal", () => {
    expect(isTerminalStatus("succeeded")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    // A cancelling Run still owns a lease and a worktree, so it is not terminal.
    expect(isTerminalStatus("cancelling")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
  });

  it("exposes a managed worktree only after preparation and not after cancel", () => {
    expect(canLoadRunChanges("running")).toBe(true);
    expect(canLoadRunChanges("succeeded")).toBe(true);
    expect(canLoadRunChanges("queued")).toBe(false);
    expect(canLoadRunChanges("preparing")).toBe(false);
    expect(canLoadRunChanges("cancelling")).toBe(false);
    expect(canLoadRunChanges("cancelled")).toBe(false);
  });

  it("allows keep/discard only for finished Runs", () => {
    expect(canResolveRunResult("succeeded")).toBe(true);
    expect(canResolveRunResult("failed")).toBe(true);
    expect(canResolveRunResult("cancelled")).toBe(false);
    expect(canResolveRunResult("running")).toBe(false);
  });

  it("offers steering under exactly the statuses the engine accepts", () => {
    // The engine rejects a steer outside these statuses, so the UI must gate
    // the control on the same rule rather than keep its own copy.
    expect(canSteerRun("queued")).toBe(true);
    expect(canSteerRun("preparing")).toBe(true);
    expect(canSteerRun("running")).toBe(true);
    expect(canSteerRun("environment_offline")).toBe(true);
    // waiting_user has its own answer channel; terminal statuses have no
    // future model boundary to steer.
    expect(canSteerRun("waiting_user")).toBe(false);
    expect(canSteerRun("waiting_approval")).toBe(false);
    expect(canSteerRun("succeeded")).toBe(false);
    expect(canSteerRun("cancelled")).toBe(false);
  });

  it("labels every RunStatus without falling through to a raw enum value", () => {
    const statuses: RunStatus[] = [
      "queued",
      "preparing",
      "running",
      "waiting_approval",
      "waiting_user",
      "environment_offline",
      "verifying",
      "succeeded",
      "failed",
      "cancelling",
      "cancelled"
    ];
    for (const status of statuses) {
      expect(statusLabel(status).length).toBeGreaterThan(0);
    }
  });
});

describe("formatRunBudget", () => {
  it("stays positive while every metric is below its warning threshold", () => {
    const details = formatRunBudget(makeBudget());
    expect(details.tone).toBe("positive");
    expect(details.warnings).toEqual([]);
    expect(details.model).toBe("claude-sonnet-4-5 · 2026-01");
    // Elapsed time is always shown against its hard limit so an operator can
    // see the remaining budget rather than a bare duration.
    expect(details.wallTime).toBe("0分30秒 / 1分");
  });

  it("surfaces warning labels and flips the tone once a threshold is crossed", () => {
    const details = formatRunBudget(
      makeBudget({ warnings: ["cost_warning", "retry_warning"] })
    );
    expect(details.tone).toBe("warning");
    expect(details.warnings).toEqual(["成本接近上限", "模型重试接近上限"]);
  });

  it("renders sub-cent costs with enough precision to be non-zero", () => {
    const details = formatRunBudget(makeBudget({ costUsd: 0.000004 }));
    expect(details.cost).toContain("0.000004");
  });
});

describe("approval projections", () => {
  it("offers no approval modes to a viewer and full access only to an admin", () => {
    expect(approvalModeOptions("viewer")).toEqual([]);
    expect(approvalModeOptions("developer").map((o) => o.value)).toEqual([
      "manual",
      "auto_review"
    ]);
    expect(approvalModeOptions("admin").map((o) => o.value)).toEqual([
      "manual",
      "auto_review",
      "full_access"
    ]);
  });

  it("renders command approvals without shell reconstruction", () => {
    const approval = {
      id: "approval-1",
      callId: "call-1",
      summary: "运行 git status",
      capabilityType: "command_exec",
      capabilityHash: "abcdef0123456789",
      riskLevel: "low",
      allowedScopes: ["once", "run"],
      editableCapability: { type: "command_exec", argv: ["git", "status"] }
    } as unknown as PendingApproval;
    const details = formatApprovalDetails(approval);
    expect(details.capability).toBe("受控命令");
    expect(details.risk).toBe("低风险");
    expect(details.allowedScopes.map((s) => s.value)).toEqual(["once", "run"]);
    const editable = formatEditableApproval(approval);
    // argv stays line-separated so the operator edits arguments, never a shell string.
    expect(editable).toEqual({
      kind: "command_exec",
      label: "编辑命令参数（每行一个 argv）",
      value: "git\nstatus",
      help: "只能删除参数并保持原顺序；修改后仅允许本次调用。"
    });
  });

  it("defaults missing scopes to once so the narrowest option wins", () => {
    const approval = {
      id: "approval-2",
      callId: "call-2",
      summary: "访问 api.example.com",
      capabilityType: "network_egress",
      capabilityHash: "hash",
      riskLevel: "medium"
    } as unknown as PendingApproval;
    expect(formatApprovalDetails(approval).allowedScopes).toEqual([
      { value: "once", label: "仅本次调用" }
    ]);
    expect(formatEditableApproval(approval)).toBeUndefined();
  });

  it("truncates untrusted approval text before it reaches the view", () => {
    const approval = {
      id: "approval-3",
      callId: "call-3",
      summary: "x".repeat(500),
      capabilityType: "command_exec",
      capabilityHash: "hash",
      riskLevel: "high",
      reason: "y".repeat(500)
    } as unknown as PendingApproval;
    const details = formatApprovalDetails(approval);
    expect(details.target.length).toBe(240);
    expect(details.reason.length).toBe(240);
  });
});

describe("resolveProjectSelection", () => {
  const config = {
    projectId: "project-b",
    projects: [{ id: "project-a" }, { id: "project-b" }],
    defaultEnvironmentId: "sandbox-v1"
  } as unknown as ControlPlaneConfig;

  it("keeps a previous selection that is still registered", () => {
    expect(resolveProjectSelection(config, "project-a")).toEqual({
      projectIds: ["project-a", "project-b"],
      selectedProjectId: "project-a"
    });
  });

  it("falls back to the configured project when the previous one disappeared", () => {
    expect(resolveProjectSelection(config, "project-removed")).toEqual({
      projectIds: ["project-a", "project-b"],
      selectedProjectId: "project-b"
    });
  });

  it("refuses to guess when the control plane exposes no projects", () => {
    expect(() =>
      resolveProjectSelection(
        { ...config, projects: [] } as unknown as ControlPlaneConfig,
        undefined
      )
    ).toThrow(/no registered projects/);
  });
});

describe("formatRunEventDetail", () => {
  function event(type: RunEventV1["type"], data: unknown, sequence = 1): RunEventV1 {
    return {
      version: 1,
      sequence,
      runId: "run-1",
      type,
      occurredAt: "2026-01-01T00:00:00.000Z",
      data: data as RunEventV1["data"]
    };
  }

  it("renders a known status transition with its localized label", () => {
    expect(formatRunEventDetail(event("status_changed", { status: "running" }))).toBe(
      "执行中"
    );
  });

  it("degrades an unknown status to a sequence placeholder", () => {
    expect(formatRunEventDetail(event("status_changed", { status: "bogus" }, 7))).toBe(
      "事件 #7"
    );
  });

  it("ignores counters that are not non-negative integers", () => {
    const detail = formatRunEventDetail(
      event("tool_started", { command: "pnpm test", argumentCount: -1 })
    );
    expect(detail).toBe("pnpm test");
  });

  it("accepts a valid argument count", () => {
    expect(
      formatRunEventDetail(
        event("tool_started", { command: "pnpm test", argumentCount: 2 })
      )
    ).toBe("pnpm test（2 个参数）");
  });

  it("reports denied and executed tool outcomes distinctly", () => {
    expect(formatRunEventDetail(event("tool_completed", { outcome: "denied" }))).toBe(
      "用户已拒绝执行"
    );
    expect(
      formatRunEventDetail(
        event("tool_completed", { outcome: "executed", exitCode: 0 })
      )
    ).toBe("执行完成，退出码 0");
  });

  it("renders verification outcomes with their check count", () => {
    expect(
      formatRunEventDetail(
        event("verification_completed", { outcome: "passed", checkCount: 3 })
      )
    ).toBe("验证通过（3 项检查）");
    expect(
      formatRunEventDetail(event("verification_completed", { outcome: "nope" }, 9))
    ).toBe("事件 #9");
  });

  it("appends the failure code to a run_failed message", () => {
    expect(
      formatRunEventDetail(
        event("run_failed", { message: "worktree missing", code: "E_WORKTREE" })
      )
    ).toBe("worktree missing（E_WORKTREE）");
  });

  it("always has a title for every event type", () => {
    expect(formatEventTitle("approval_requested")).toBe("需要审批");
    expect(formatEventTitle("user_message_delivered")).toBe("指令已投递");
  });
});

describe("isTerminalRunEvent", () => {
  it("only matches status_changed events carrying a terminal status", () => {
    const base = {
      version: 1 as const,
      sequence: 1,
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:00.000Z"
    };
    expect(
      isTerminalRunEvent({
        ...base,
        type: "status_changed",
        data: { status: "succeeded" } as RunEventV1["data"]
      })
    ).toBe(true);
    expect(
      isTerminalRunEvent({
        ...base,
        type: "status_changed",
        data: { status: "verifying" } as RunEventV1["data"]
      })
    ).toBe(false);
    expect(
      isTerminalRunEvent({
        ...base,
        type: "tool_completed",
        data: { status: "succeeded" } as RunEventV1["data"]
      })
    ).toBe(false);
  });
});

describe("verificationTone", () => {
  it("keeps inconclusive evidence visually distinct from a pass", () => {
    expect(verificationTone("passed")).toBe("positive");
    expect(verificationTone("failed")).toBe("negative");
    expect(verificationTone("inconclusive")).toBe("warning");
  });
});

describe("formatProjectPolicyRule", () => {
  it("labels capability and decision and marks revoked rules inactive", () => {
    expect(
      formatProjectPolicyRule({
        id: "rule-1",
        projectId: "project-a",
        capabilityType: "network_egress",
        capabilityHash: "0123456789abcdef",
        decision: "deny",
        createdAt: "2026-01-01T00:00:00.000Z",
        revokedAt: "2026-01-02T00:00:00.000Z"
      } as never)
    ).toEqual({
      id: "rule-1",
      capability: "网络访问",
      decision: "拒绝",
      fingerprint: "0123456789ab",
      active: false
    });
  });
});
