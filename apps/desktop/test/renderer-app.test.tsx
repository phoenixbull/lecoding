/**
 * @vitest-environment jsdom
 *
 * Renderer component tests.
 *
 * These are integration-level on purpose: a real `RunConsoleController` drives
 * a real `App` through a fake preload bridge. The controller is wired to
 * `createIpcRunGateway`, so every assertion proves the whole Renderer path —
 * component → controller → bridge — and not just markup.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import type { RunView } from "@lecoding/contracts";
import { createRunConsoleController, type RunConsoleController } from "@lecoding/run-controller";
import { App } from "../src/renderer/App.js";
import { createIpcRunEventSource } from "../src/renderer/gateway/ipc-event-source.js";
import { createIpcRunGateway } from "../src/renderer/gateway/ipc-gateway.js";
import { createFakeBridge, type FakeBridge } from "./renderer-bridge.js";

// React 19 requires the test environment to opt into act() semantics.
declare global {
  // eslint-disable-next-line no-var -- required by React's act environment flag
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CONFIG = {
  projectId: "project-a",
  projects: [{ id: "project-a", role: "admin" as const }],
  defaultEnvironmentId: "sandbox-v1"
};

const RUN: RunView = {
  id: "run-1",
  projectId: "project-a",
  environmentId: "sandbox-v1",
  task: "实现健康检查端点",
  status: "running"
};

function makeEvent(sequence: number, status = "running") {
  return {
    version: 1 as const,
    sequence,
    runId: "run-1",
    type: "status_changed" as const,
    occurredAt: "2026-01-01T00:00:00.000Z",
    data: { status }
  };
}

describe("Renderer App", () => {
  let bridge: FakeBridge;
  let controller: RunConsoleController | undefined;

  beforeEach(() => {
    bridge = createFakeBridge();
    // Default answers for the channels the controller touches on boot.
    bridge.respond("config.load", CONFIG);
    bridge.respond("runs.inspect", RUN);
    bridge.respond("runs.list", {
      runs: [
        {
          id: "run-1",
          projectId: "project-a",
          environmentId: "sandbox-v1",
          task: "实现健康检查端点",
          status: "running",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    });
    bridge.respond("runs.changes", {
      changedFiles: [],
      unifiedDiff: "",
      truncated: false
    });
    bridge.respond("policy.list", { rules: [] });
    bridge.respond("devices.list", { devices: [] });
    bridge.respond("session.status", { bootstrapped: true });
  });

  afterEach(() => {
    controller?.dispose();
    controller = undefined;
    cleanup();
  });

  /** Renders the app and bootstraps the controller inside act(). */
  async function renderApp(): Promise<void> {
    const instance = createRunConsoleController({
      gateway: createIpcRunGateway(bridge),
      events: createIpcRunEventSource(bridge),
      waitBeforeReconnect: () => Promise.resolve()
    });
    controller = instance;
    render(
      <App
        controller={instance}
        bridge={bridge}
        serverUrl="https://agent.example"
        appVersion="1.2.3"
        platform="darwin"
        onConnect={() => undefined}
        onGitHubLogin={() => undefined}
        confirmAction={() => true}
      />
    );
    await act(async () => {
      await instance.initialize();
    });
  }

  it("shows the connection screen while the session is not authenticated", async () => {
    bridge.respond("config.load", undefined);
    bridge["config.load"] = async () => {
      bridge.calls.push({ channel: "config.load", payload: {} });
      throw Object.assign(new Error("control plane: HTTP 401"), { status: 401 });
    };
    await renderApp();
    await waitFor(() => {
      expect(screen.getByLabelText("服务器地址")).toBeTruthy();
    });
    expect(screen.queryByText("执行概览")).toBeNull();
  });

  it("renders the Run console once the control plane answers", async () => {
    await renderApp();
    await waitFor(() => {
      expect(screen.getByText("执行概览")).toBeTruthy();
    });
    // The task appears in both the history list and the Run header.
    expect(screen.getAllByText("实现健康检查端点").length).toBeGreaterThan(0);
  });

  it("relays a pushed Run event into the timeline", async () => {
    await renderApp();
    await waitFor(() => {
      expect(screen.getByText("执行概览")).toBeTruthy();
    });
    await act(async () => {
      bridge.emitRunEvent({ runId: "run-1", event: makeEvent(1, "running") });
    });
    await waitFor(() => {
      // "执行中" is both the status badge and the timeline detail.
      expect(screen.getAllByText("执行中").length).toBeGreaterThan(0);
    });
  });

  it("renders a pending approval and forwards the decision through the bridge", async () => {
    bridge.respond("runs.inspect", {
      ...RUN,
      status: "waiting_approval",
      pendingApproval: {
        id: "approval-1",
        callId: "call-1",
        summary: "运行 git status",
        capabilityType: "command_exec",
        capabilityHash: "hash",
        riskLevel: "medium",
        allowedScopes: ["once", "run"],
        editableCapability: { type: "command_exec", argv: ["git", "status"] }
      }
    } satisfies RunView);
    await renderApp();
    await waitFor(() => {
      expect(screen.getByTestId("approval-card")).toBeTruthy();
    });
    expect(screen.getByText("中风险")).toBeTruthy();
    // The editable draft is seeded from the server-supplied capability, never
    // reconstructed from the human-readable summary.
    expect(screen.getByLabelText("编辑命令参数（每行一个 argv）")).toBeTruthy();

    await act(async () => {
      screen.getByText("批准").click();
    });
    await waitFor(() => {
      expect(bridge.calls.some((call) => call.channel === "runs.approve")).toBe(true);
    });
    const approve = bridge.calls.find((call) => call.channel === "runs.approve");
    expect(approve?.payload).toEqual({
      runId: "run-1",
      approvalId: "approval-1",
      scope: "once"
    });
  });

  it("confirms before discarding a finished Run's worktree", async () => {
    const confirmations: string[] = [];
    bridge.respond("runs.inspect", { ...RUN, status: "succeeded" } satisfies RunView);
    const instance = createRunConsoleController({
      gateway: createIpcRunGateway(bridge),
      events: createIpcRunEventSource(bridge),
      waitBeforeReconnect: () => Promise.resolve()
    });
    controller = instance;
    render(
      <App
        controller={instance}
        bridge={bridge}
        serverUrl="https://agent.example"
        appVersion="1.2.3"
        platform="darwin"
        onConnect={() => undefined}
        onGitHubLogin={() => undefined}
        confirmAction={(message) => {
          confirmations.push(message);
          return true;
        }}
      />
    );
    await act(async () => {
      await instance.initialize();
    });

    await waitFor(() => {
      expect(screen.getAllByText("丢弃结果").length).toBeGreaterThan(0);
    });
    await act(async () => {
      screen.getAllByText("丢弃结果")[0]!.click();
    });
    await waitFor(() => {
      expect(bridge.calls.some((call) => call.channel === "runs.resolve")).toBe(true);
    });
    // Discarding is irreversible, so the view must gate it explicitly.
    expect(confirmations.some((message) => message.includes("丢弃"))).toBe(true);
  });

  it("surfaces a degraded credential backend until it recovers", async () => {
    await renderApp();
    await waitFor(() => {
      expect(screen.getByText("执行概览")).toBeTruthy();
    });
    await act(async () => {
      bridge.emitCredentialState({
        backend: "encryptedFile",
        degraded: true,
        reason: "safeStorage 不可用"
      });
    });
    await waitFor(() => {
      expect(screen.getByText(/凭据存储已降级/)).toBeTruthy();
    });
  });

  it("never renders untrusted Run text as markup", async () => {
    bridge.respond("runs.inspect", {
      ...RUN,
      task: "<img src=x onerror=alert(1)>"
    } satisfies RunView);
    await renderApp();
    await waitFor(() => {
      expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    });
    expect(document.querySelector("img")).toBeNull();
  });
});
