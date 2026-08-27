import { describe, expect, it } from "vitest";
import type { JsonValue } from "@lecoding/contracts";
import {
  canLoadRunChanges,
  formatEventTitle,
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
});
