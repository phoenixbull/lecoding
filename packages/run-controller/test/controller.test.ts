import { afterEach, describe, expect, it } from "vitest";
import type { PendingApproval } from "@lecoding/contracts";
import { createRunConsoleController, type RunConsoleController } from "../src/controller.js";
import {
  ADMIN_CONFIG,
  createFakeGateway,
  createManualEventSource,
  HttpError,
  makeChanges,
  makeEvent,
  makeRule,
  makeRunView,
  makeSummary,
  settle,
  VIEWER_CONFIG,
  type FakeGateway,
  type ManualEventSource
} from "./fakes.js";

let controller: RunConsoleController | undefined;

afterEach(() => {
  controller?.dispose();
  controller = undefined;
});

/** Wires a controller to fakes with a reconnect delay that never blocks a test. */
function setup(options: {
  gateway?: FakeGateway;
  events?: ManualEventSource;
} = {}): {
  controller: RunConsoleController;
  gateway: FakeGateway;
  events: ManualEventSource;
} {
  const gateway = options.gateway ?? createFakeGateway();
  const events = options.events ?? createManualEventSource();
  const instance = createRunConsoleController({
    gateway,
    events,
    // Reconnect immediately so a transport failure in a test does not need a
    // real timer; the manual source parks the next subscription until the test
    // emits again.
    waitBeforeReconnect: () => Promise.resolve()
  });
  controller = instance;
  return { controller: instance, gateway, events };
}

describe("initialize", () => {
  it("boots into the ready phase and restores the most recent Run", async () => {
    const { controller: instance } = setup({
      gateway: createFakeGateway({
        views: [makeRunView({ id: "run-9", status: "succeeded" })],
        history: [makeSummary({ id: "run-9", status: "succeeded" })],
        rules: [makeRule()]
      })
    });
    await instance.initialize();
    const state = instance.getState();
    expect(state.phase).toBe("ready");
    expect(state.selectedProjectId).toBe("project-a");
    expect(state.canCreate).toBe(true);
    expect(state.composer.environmentId).toBe("sandbox-v1");
    expect(state.selectedRunId).toBe("run-9");
    expect(state.currentRun?.status).toBe("succeeded");
    expect(state.policyRules).toHaveLength(1);
  });

  it("moves to needs_auth when the control plane rejects the session", async () => {
    const { controller: instance } = setup({
      gateway: createFakeGateway({
        configError: new HttpError("Failed to load control plane", 401)
      })
    });
    await instance.initialize();
    const state = instance.getState();
    expect(state.phase).toBe("needs_auth");
    expect(state.error).toContain("需要登录");
    expect(state.canCreate).toBe(false);
  });

  it("moves to offline for a transport failure rather than an auth failure", async () => {
    const { controller: instance } = setup({
      gateway: createFakeGateway({ configError: new Error("ECONNREFUSED") })
    });
    await instance.initialize();
    expect(instance.getState().phase).toBe("offline");
    expect(instance.getState().error).toContain("Worker");
  });

  it("refuses to guess a project when the control plane registers none", async () => {
    const { controller: instance } = setup({
      gateway: createFakeGateway({
        config: { projectId: "project-a", projects: [], defaultEnvironmentId: "sandbox-v1" }
      })
    });
    await instance.initialize();
    expect(instance.getState().phase).toBe("offline");
    expect(instance.getState().error).toContain("没有注册任何项目");
  });

  it("disables Run creation for a viewer", async () => {
    const { controller: instance } = setup({
      gateway: createFakeGateway({ config: VIEWER_CONFIG })
    });
    await instance.initialize();
    expect(instance.getState().canCreate).toBe(false);
    await instance.createRun();
    expect(instance.getState().error).toBeUndefined();
  });
});

describe("logout", () => {
  it("clears the session and re-bootstraps from scratch", async () => {
    const gateway = createFakeGateway({
      views: [makeRunView({ id: "run-9", status: "succeeded" })],
      history: [makeSummary({ id: "run-9", status: "succeeded" })]
    });
    const { controller: instance } = setup({ gateway });
    await instance.initialize();
    expect(instance.getState().selectedRunId).toBe("run-9");

    await instance.logout();
    expect(gateway.calls.some((call) => call.method === "logout")).toBe(true);
    // The follow-up bootstrap repopulates the console from the same gateway.
    expect(instance.getState().phase).toBe("ready");
    expect(instance.getState().selectedRunId).toBe("run-9");
  });
});

describe("project selection", () => {
  it("severs the old read model before loading the new scope", async () => {
    const gateway = createFakeGateway({
      config: {
        projectId: "project-a",
        projects: [
          { id: "project-a", role: "admin" },
          { id: "project-b", role: "admin" }
        ],
        defaultEnvironmentId: "sandbox-v1"
      },
      views: [makeRunView({ id: "run-9", status: "succeeded" })],
      history: [makeSummary({ id: "run-9", status: "succeeded" })]
    });
    const { controller: instance } = setup({ gateway });
    await instance.initialize();
    expect(instance.getState().selectedRunId).toBe("run-9");

    gateway.setHistory([makeSummary({ id: "run-b1" })]);
    await instance.selectProject("project-b");

    const state = instance.getState();
    expect(state.selectedProjectId).toBe("project-b");
    // No view may keep showing the previous project's Run.
    expect(state.currentRun).toBeUndefined();
    expect(state.timeline).toEqual([]);
    expect(state.recentRuns.map((run) => run.id)).toEqual(["run-b1"]);
  });

  it("ignores a project the control plane did not register", async () => {
    const { controller: instance } = setup();
    await instance.initialize();
    await instance.selectProject("project-unknown");
    expect(instance.getState().selectedProjectId).toBe("project-a");
  });
});

describe("createRun", () => {
  it("builds the create input from the composer draft", async () => {
    const { controller: instance, gateway } = setup({
      gateway: createFakeGateway({ history: [] })
    });
    await instance.initialize();
    instance.setComposerDraft({
      task: "  为 API 增加健康检查端点  ",
      acceptanceCriteria: "测试全部通过\n\n类型检查通过\n",
      environmentId: "sandbox-v1",
      approvalMode: "manual"
    });
    await instance.createRun();

    expect(gateway.createdInputs).toEqual([
      {
        environmentId: "sandbox-v1",
        task: "为 API 增加健康检查端点",
        acceptanceCriteria: ["测试全部通过", "类型检查通过"],
        approvalMode: "manual",
        fileAccessScope: "workspace_only"
      }
    ]);
    expect(instance.getState().selectedRunId).toBe("run-created-1");
  });

  it("clears the composer task after a successful create", async () => {
    const { controller: instance } = setup({ gateway: createFakeGateway({ history: [] }) });
    await instance.initialize();
    instance.setComposerDraft({ task: "实现健康检查" });
    await instance.createRun();
    expect(instance.getState().composer.task).toBe("");
  });

  it("refuses to create a Run without a task", async () => {
    const { controller: instance, gateway } = setup({
      gateway: createFakeGateway({ history: [] })
    });
    await instance.initialize();
    instance.setComposerDraft({ task: "   " });
    await instance.createRun();
    expect(gateway.createdInputs).toEqual([]);
  });

  it("surfaces a failure without leaving the composer stuck in flight", async () => {
    const { controller: instance, gateway } = setup({
      gateway: createFakeGateway({ history: [] })
    });
    await instance.initialize();
    instance.setComposerDraft({ task: "实现健康检查" });
    gateway.fail("createRun", new Error("server down"));
    await instance.createRun();
    const state = instance.getState();
    expect(state.error).toContain("创建 Run 失败");
    expect(state.pending.creating).toBe(false);
  });
});

describe("Run selection and evidence", () => {
  it("loads changes for a Run that owns a worktree", async () => {
    const gateway = createFakeGateway({ history: [] });
    gateway.setView(makeRunView({ id: "run-1", status: "succeeded" }));
    gateway.setChanges("run-1", makeChanges());
    const { controller: instance } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    const state = instance.getState();
    expect(state.currentRun?.id).toBe("run-1");
    expect(state.changes?.changedFiles).toEqual(["src/health.ts"]);
  });

  it("explains that a cancelled Run's worktree was already cleaned up", async () => {
    const gateway = createFakeGateway({ history: [] });
    gateway.setView(makeRunView({ id: "run-1", status: "cancelled" }));
    const { controller: instance } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    expect(instance.getState().changes).toBeUndefined();
    expect(instance.getState().changesMessage).toContain("已安全清理");
  });

  it("remembers a discarded worktree when changes come back 404", async () => {
    const gateway = createFakeGateway({ history: [] });
    gateway.setView(makeRunView({ id: "run-1", status: "succeeded" }));
    gateway.setChangesFailure("run-1", new HttpError("Failed to load changes", 404));
    const { controller: instance } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    expect(instance.getState().discardedRunIds).toContain("run-1");
  });

  it("reads a retained artifact without letting the content leave the console", async () => {
    const gateway = createFakeGateway({ history: [] });
    gateway.setView(makeRunView({ id: "run-1", status: "succeeded" }));
    gateway.setChanges("run-1", makeChanges());
    gateway.setArtifact("run-1", "artifact-1", "truncated output");
    const { controller: instance } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    await instance.loadArtifact("artifact-1");
    expect(instance.getState().artifactText).toBe("truncated output");
  });

  it("reports an expired artifact instead of failing silently", async () => {
    const gateway = createFakeGateway({ history: [] });
    gateway.setView(makeRunView({ id: "run-1", status: "succeeded" }));
    const { controller: instance } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    await instance.loadArtifact("artifact-missing");
    expect(instance.getState().artifactText).toContain("过保留期");
  });
});

describe("cancellation", () => {
  it("cancels a live Run and refreshes it", async () => {
    const gateway = createFakeGateway({ history: [] });
    gateway.setView(makeRunView({ id: "run-1", status: "running" }));
    const { controller: instance } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    await instance.cancelCurrentRun();
    expect(gateway.calls.some((call) => call.method === "cancelRun")).toBe(true);
    expect(instance.getState().pending.cancelling).toBe(false);
  });

  it("refuses to cancel a Run that already reached a terminal state", async () => {
    const gateway = createFakeGateway({ history: [] });
    gateway.setView(makeRunView({ id: "run-1", status: "succeeded" }));
    const { controller: instance } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    await instance.cancelCurrentRun();
    expect(gateway.calls.some((call) => call.method === "cancelRun")).toBe(false);
  });
});

describe("result disposition", () => {
  it("keeps a result and reports that the source repository is untouched", async () => {
    const gateway = createFakeGateway({ history: [] });
    gateway.setView(makeRunView({ id: "run-1", status: "succeeded" }));
    gateway.setChanges("run-1", makeChanges());
    const { controller: instance } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    await instance.resolveCurrentResult("keep");
    const state = instance.getState();
    expect(state.changesMessage).toContain("源仓库未被修改");
    expect(state.discardedRunIds).toEqual([]);
  });

  it("discards a result once and then stops offering the action", async () => {
    const gateway = createFakeGateway({ history: [] });
    gateway.setView(makeRunView({ id: "run-1", status: "succeeded" }));
    gateway.setChanges("run-1", makeChanges());
    const { controller: instance } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    await instance.resolveCurrentResult("discard");
    expect(instance.getState().discardedRunIds).toContain("run-1");

    const before = gateway.calls.filter((call) => call.method === "resolveRunResult").length;
    await instance.resolveCurrentResult("discard");
    expect(
      gateway.calls.filter((call) => call.method === "resolveRunResult").length
    ).toBe(before);
  });

  it("refuses to dispose a Run that is still executing", async () => {
    const gateway = createFakeGateway({ history: [] });
    gateway.setView(makeRunView({ id: "run-1", status: "running" }));
    const { controller: instance } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    await instance.resolveCurrentResult("discard");
    expect(gateway.calls.some((call) => call.method === "resolveRunResult")).toBe(false);
  });
});

describe("approvals", () => {
  const APPROVAL = {
    id: "approval-1",
    callId: "call-1",
    summary: "运行 git status",
    capabilityType: "command_exec" as const,
    capabilityHash: "hash",
    riskLevel: "low" as const,
    allowedScopes: ["once", "run"],
    editableCapability: { type: "command_exec" as const, argv: ["git", "status"] }
  } satisfies PendingApproval;

  async function waitingApproval() {
    const gateway = createFakeGateway({ history: [] });
    gateway.setView(
      makeRunView({ id: "run-1", status: "waiting_approval", pendingApproval: APPROVAL })
    );
    const wired = setup({ gateway });
    await wired.controller.initialize();
    await wired.controller.selectRun("run-1");
    return wired;
  }

  it("seeds the editable draft from the server-supplied capability", async () => {
    const { controller: instance } = await waitingApproval();
    expect(instance.getState().approvalDraft).toEqual({
      approvalId: "approval-1",
      value: "git\nstatus"
    });
  });

  it("preserves an in-progress edit across an SSE refresh of the same approval", async () => {
    const { controller: instance, events } = await waitingApproval();
    instance.setApprovalDraft("git\nstatus\n--short");
    events.emit("run-1", makeEvent(2));
    await settle();
    expect(instance.getState().approvalDraft?.value).toBe("git\nstatus\n--short");
  });

  it("resets the draft when a genuinely different approval arrives", async () => {
    const { controller: instance, gateway, events } = await waitingApproval();
    instance.setApprovalDraft("git\nstatus\n--short");
    gateway.setView(
      makeRunView({
        id: "run-1",
        status: "waiting_approval",
        pendingApproval: {
          ...APPROVAL,
          id: "approval-2",
          editableCapability: { type: "command_exec", argv: ["ls", "-la"] }
        }
      })
    );
    events.emit("run-1", makeEvent(2));
    await settle();
    expect(instance.getState().approvalDraft).toEqual({
      approvalId: "approval-2",
      value: "ls\n-la"
    });
  });

  it("approves with the selected persistence scope", async () => {
    const { controller: instance, gateway } = await waitingApproval();
    instance.setApprovalScope("run");
    await instance.resolveCurrentApproval("approve");
    const call = gateway.calls.find((entry) => entry.method === "approveRun");
    expect(call?.args).toEqual(["run-1", "approval-1", "run"]);
  });

  it("rejects with the selected persistence scope", async () => {
    const { controller: instance, gateway } = await waitingApproval();
    instance.setApprovalScope("project");
    await instance.resolveCurrentApproval("reject");
    const call = gateway.calls.find((entry) => entry.method === "rejectRun");
    expect(call?.args).toEqual(["run-1", "approval-1", "project"]);
  });

  it("narrows a command capability line by line when approving an edit", async () => {
    const { controller: instance, gateway } = await waitingApproval();
    instance.setApprovalDraft("git\nstatus\n--short");
    await instance.editAndApproveCurrent();
    const call = gateway.calls.find((entry) => entry.method === "editAndApproveRun");
    expect(call?.args[2]).toEqual({
      type: "command_exec",
      argv: ["git", "status", "--short"]
    });
  });

  it("lowercases a narrowed network domain and preserves the original port", async () => {
    const gateway = createFakeGateway({ history: [] });
    gateway.setView(
      makeRunView({
        id: "run-1",
        status: "waiting_approval",
        pendingApproval: {
          ...APPROVAL,
          capabilityType: "network_egress",
          editableCapability: {
            type: "network_egress",
            scheme: "https",
            domain: "api.example.com",
            port: 443
          }
        }
      })
    );
    const wired = setup({ gateway });
    controller = wired.controller;
    await wired.controller.initialize();
    await wired.controller.selectRun("run-1");
    wired.controller.setApprovalDraft("  Sub.API.Example.com  ");
    await wired.controller.editAndApproveCurrent();
    const call = gateway.calls.find((entry) => entry.method === "editAndApproveRun");
    expect(call?.args[2]).toEqual({
      type: "network_egress",
      scheme: "https",
      domain: "sub.api.example.com",
      port: 443
    });
  });

  it("does nothing when there is no pending approval", async () => {
    const gateway = createFakeGateway({ history: [] });
    const { controller: instance } = setup({ gateway });
    await instance.initialize();
    await instance.resolveCurrentApproval("approve");
    expect(gateway.calls.some((call) => call.method === "approveRun")).toBe(false);
  });
});

describe("user answers and steering", () => {
  it("answers a pending Agent question", async () => {
    const gateway = createFakeGateway({ history: [] });
    gateway.setView(
      makeRunView({
        id: "run-1",
        status: "waiting_user",
        pendingUserRequest: { id: "request-1", prompt: "选择迁移策略" }
      })
    );
    const { controller: instance } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    instance.setUserResponseDraft("保持旧版错误结构");
    await instance.resolveUserRequest("answer");
    const call = gateway.calls.find((entry) => entry.method === "answerRun");
    expect(call?.args).toEqual(["run-1", "request-1", "保持旧版错误结构"]);
    expect(instance.getState().userResponseDraft).toBe("");
  });

  it("steers a live Run that is not waiting for an answer", async () => {
    const gateway = createFakeGateway({ history: [] });
    gateway.setView(makeRunView({ id: "run-1", status: "running" }));
    const { controller: instance } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    instance.setUserResponseDraft("不要修改公开 API");
    await instance.resolveUserRequest("steer");
    const call = gateway.calls.find((entry) => entry.method === "steerRun");
    expect(call?.args).toEqual(["run-1", "不要修改公开 API"]);
  });

  it("rejects an empty or oversized answer", async () => {
    const gateway = createFakeGateway({ history: [] });
    gateway.setView(
      makeRunView({
        id: "run-1",
        status: "waiting_user",
        pendingUserRequest: { id: "request-1", prompt: "选择迁移策略" }
      })
    );
    const { controller: instance } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");

    instance.setUserResponseDraft("   ");
    await instance.resolveUserRequest("answer");
    expect(gateway.calls.some((call) => call.method === "answerRun")).toBe(false);

    instance.setUserResponseDraft("x".repeat(4_001));
    await instance.resolveUserRequest("answer");
    expect(gateway.calls.some((call) => call.method === "answerRun")).toBe(false);
  });

  it("will not answer when the Run has no pending question", async () => {
    const gateway = createFakeGateway({ history: [] });
    gateway.setView(makeRunView({ id: "run-1", status: "succeeded" }));
    const { controller: instance } = setup({ gateway });
    await instance.initialize();
    await instance.selectRun("run-1");
    instance.setUserResponseDraft("随便回答");
    await instance.resolveUserRequest("answer");
    expect(gateway.calls.some((call) => call.method === "answerRun")).toBe(false);
  });
});

describe("project policy rules", () => {
  it("hides the admin-only panel when the server answers 404", async () => {
    const { controller: instance, gateway } = setup({
      gateway: createFakeGateway({ history: [] })
    });
    await instance.initialize();
    gateway.setRulesError(new HttpError("Failed to list policy rules", 404));
    await instance.refreshPolicyRules();
    expect(instance.getState().policyRulesVisible).toBe(false);
    expect(instance.getState().error).toBeUndefined();
  });

  it("shows a failure for a non-authorization error instead of hiding the panel", async () => {
    const { controller: instance, gateway } = setup({
      gateway: createFakeGateway({ history: [] })
    });
    await instance.initialize();
    gateway.setRulesError(new Error("worker busy"));
    await instance.refreshPolicyRules();
    expect(instance.getState().policyRulesVisible).toBe(true);
    expect(instance.getState().error).toContain("审批规则暂时不可用");
  });

  it("drops a revoked rule from the visible list", async () => {
    const { controller: instance, gateway } = setup({
      gateway: createFakeGateway({ history: [] })
    });
    await instance.initialize();
    gateway.setRules([makeRule({ id: "rule-1" }), makeRule({ id: "rule-2" })]);
    await instance.refreshPolicyRules();
    await instance.revokePolicyRule("rule-1");
    expect(instance.getState().policyRules.map((rule) => rule.id)).toEqual(["rule-2"]);
  });
});

describe("notification", () => {
  it("coalesces a burst of state changes into a single notification", async () => {
    const { controller: instance } = setup({
      gateway: createFakeGateway({ history: [] })
    });
    await instance.initialize();
    let notifications = 0;
    const unsubscribe = instance.subscribe(() => {
      notifications += 1;
    });
    instance.setApprovalScope("run");
    instance.setUserResponseDraft("x");
    instance.dismissError();
    await settle();
    expect(notifications).toBe(1);

    unsubscribe();
    instance.setApprovalScope("once");
    await settle();
    expect(notifications).toBe(1);
  });

  it("hands the listener the latest snapshot, not the first one", async () => {
    const { controller: instance } = setup({
      gateway: createFakeGateway({ history: [] })
    });
    await instance.initialize();
    const seen: string[] = [];
    instance.subscribe((snapshot) => {
      seen.push(snapshot.approvalScope);
    });
    instance.setApprovalScope("run");
    instance.setApprovalScope("project");
    await settle();
    expect(seen).toEqual(["project"]);
  });
});

describe("device binding", () => {
  it("lists bound devices for the installation", async () => {
    const { controller: instance } = setup({
      gateway: createFakeGateway({
        history: [],
        devices: [
          {
            deviceId: "device-1",
            deviceLabel: "office-mac",
            platform: "darwin",
            projectId: "project-a",
            projectName: "Project A",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastUsedAt: "2026-01-02T00:00:00.000Z",
            expiresAt: "2026-02-01T00:00:00.000Z"
          }
        ]
      })
    });
    await instance.initialize();
    await instance.refreshDevices();
    expect(instance.getState().devices.map((device) => device.deviceId)).toEqual([
      "device-1"
    ]);
  });

  it("mints a one-time code for the selected project", async () => {
    const { controller: instance } = setup({
      gateway: createFakeGateway({ history: [] })
    });
    await instance.initialize();
    await instance.createDeviceCode();
    const state = instance.getState();
    expect(state.deviceCode?.code).toBe("ABCDEFGHI");
    expect(state.binding).toBe(false);
  });

  it("clears the code after a successful exchange and re-bootstraps", async () => {
    const { controller: instance, gateway } = setup({
      gateway: createFakeGateway({ history: [] })
    });
    await instance.initialize();
    await instance.createDeviceCode();
    await instance.bindDevice({
      code: " ABCDEFGHI ",
      deviceLabel: "  office-mac  ",
      platform: "darwin"
    });
    const state = instance.getState();
    // The code is single-use; keeping it on screen invites a failed retry.
    expect(state.deviceCode).toBeUndefined();
    expect(state.devices.map((device) => device.deviceLabel)).toEqual([
      "office-mac"
    ]);
    const exchange = gateway.calls.find((call) => call.method === "exchangeDeviceCode");
    expect((exchange?.args[0] as { code: string }).code).toBe("ABCDEFGHI");
  });

  it("falls back to a default device label", async () => {
    const { controller: instance, gateway } = setup({
      gateway: createFakeGateway({ history: [] })
    });
    await instance.initialize();
    await instance.bindDevice({ code: "ABCDEFGHI", deviceLabel: "  ", platform: "win32" });
    const exchange = gateway.calls.find((call) => call.method === "exchangeDeviceCode");
    expect((exchange?.args[0] as { deviceLabel: string }).deviceLabel).toBe(
      "LeCoding Desktop"
    );
  });

  it("surfaces a bind failure without leaving the console stuck", async () => {
    const { controller: instance, gateway } = setup({
      gateway: createFakeGateway({ history: [] })
    });
    await instance.initialize();
    gateway.fail("exchangeDeviceCode", new Error("code consumed"));
    await instance.bindDevice({ code: "ABCDEFGHI", deviceLabel: "mac", platform: "darwin" });
    const state = instance.getState();
    expect(state.error).toContain("设备绑定失败");
    expect(state.binding).toBe(false);
  });

  it("refuses to bind an empty code", async () => {
    const { controller: instance, gateway } = setup({
      gateway: createFakeGateway({ history: [] })
    });
    await instance.initialize();
    await instance.bindDevice({ code: "   ", deviceLabel: "mac", platform: "darwin" });
    expect(
      gateway.calls.some((call) => call.method === "exchangeDeviceCode")
    ).toBe(false);
  });

  it("drops a revoked device from the list", async () => {
    const { controller: instance, gateway } = setup({
      gateway: createFakeGateway({
        history: [],
        devices: [
          {
            deviceId: "device-1",
            deviceLabel: "office-mac",
            platform: "darwin",
            projectId: "project-a",
            projectName: "Project A",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastUsedAt: "2026-01-02T00:00:00.000Z",
            expiresAt: "2026-02-01T00:00:00.000Z"
          }
        ]
      })
    });
    await instance.initialize();
    await instance.refreshDevices();
    await instance.revokeDevice("device-1");
    expect(instance.getState().devices).toEqual([]);
    expect(gateway.calls.some((call) => call.method === "revokeDevice")).toBe(true);
  });
});

describe("credential state", () => {
  it("surfaces a degraded credential backend so the UI can warn persistently", async () => {
    const { controller: instance } = setup({
      gateway: createFakeGateway({ history: [] })
    });
    await instance.initialize();
    expect(instance.getState().credential).toBeUndefined();
    instance.setCredential({
      backend: "encryptedFile",
      degraded: true,
      reason: "safeStorage 不可用"
    });
    expect(instance.getState().credential).toEqual({
      backend: "encryptedFile",
      degraded: true,
      reason: "safeStorage 不可用"
    });
  });

  it("clears the reported credential state", async () => {
    const { controller: instance } = setup({
      gateway: createFakeGateway({ history: [] })
    });
    await instance.initialize();
    instance.setCredential({ backend: "safeStorage", degraded: false });
    instance.setCredential(undefined);
    expect(instance.getState().credential).toBeUndefined();
  });
});

describe("error handling", () => {
  it("clears the banner on demand", async () => {
    const { controller: instance } = setup({
      gateway: createFakeGateway({ configError: new Error("ECONNREFUSED") })
    });
    await instance.initialize();
    expect(instance.getState().error).toBeDefined();
    instance.dismissError();
    expect(instance.getState().error).toBeUndefined();
  });
});

/** Guards against the admin config constant drifting away from the tests. */
describe("test fixtures", () => {
  it("uses an admin project so Run creation is permitted by default", () => {
    expect(ADMIN_CONFIG.projects[0]?.role).toBe("admin");
    expect(VIEWER_CONFIG.projects[0]?.role).toBe("viewer");
  });
});
