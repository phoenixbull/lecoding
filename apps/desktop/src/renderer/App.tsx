import { useEffect, useState } from "react";
import type { ApprovalMode } from "@lecoding/contracts";
import { approvalModeOptions } from "@lecoding/presentation";
import type { RunConsoleController } from "@lecoding/run-controller";
import { ApprovalCard } from "./components/ApprovalCard.js";
import { ArtifactPanel } from "./components/ArtifactPanel.js";
import { BudgetPanel } from "./components/BudgetPanel.js";
import { ChangesPanel } from "./components/ChangesPanel.js";
import { ConnectionBar } from "./components/ConnectionBar.js";
import { ConnectionScreen } from "./components/ConnectionScreen.js";
import { DegradedStorageBanner } from "./components/DegradedStorageBanner.js";
import { DeviceManagerPanel } from "./components/DeviceManagerPanel.js";
import { ProjectSidebar } from "./components/ProjectSidebar.js";
import { RunComposer } from "./components/RunComposer.js";
import { RunDetail } from "./components/RunDetail.js";
import { RunHistoryList } from "./components/RunHistoryList.js";
import { StatusBar } from "./components/StatusBar.js";
import { Timeline } from "./components/Timeline.js";
import { UserRequestCard } from "./components/UserRequestCard.js";
import { VerificationPanel } from "./components/VerificationPanel.js";
import type { LeCodingBridge } from "./gateway/bridge.js";
import { useControllerState } from "./use-controller-state.js";

/**
 * Console surfaces.
 *
 * `approval` is a tab rather than an inline card because approving a capability
 * is the one decision in the app that can grant durable authority; it gets the
 * whole screen instead of competing with the timeline.
 */
export type ConsoleTab = "overview" | "changes" | "approval" | "devices";

/**
 * Shape of the `session.status` response.
 *
 * The credential block mirrors `CredentialStatePush` from the shared contract
 * so one controller field can hold both the snapshot and later pushes.
 */
interface SessionStatusResult {
  credential?: {
    backend: "safeStorage" | "encryptedFile";
    degraded: boolean;
    reason?: string;
  };
}

export interface AppProps {
  controller: RunConsoleController;
  /** Preload bridge; the app mirrors main's credential health through it. */
  bridge: LeCodingBridge;
  serverUrl: string;
  appVersion: string;
  platform: "darwin" | "win32" | "linux";
  onConnect: (serverUrl: string) => void;
  onGitHubLogin: () => void;
  /** Injectable so tests can assert destructive actions without a dialog. */
  confirmAction?: (message: string) => boolean;
}

const ROLE_LABELS = {
  viewer: "只读",
  developer: "开发者",
  admin: "管理员"
} as const;

/**
 * Renderer root.
 *
 * React owns layout and event forwarding only. Every decision — when the Run
 * can be cancelled, whether a diff is loadable, how an approval draft is
 * preserved across refreshes — comes from the shared controller snapshot.
 */
export function App({
  controller,
  bridge,
  serverUrl,
  appVersion,
  platform,
  onConnect,
  onGitHubLogin,
  confirmAction
}: AppProps) {
  const state = useControllerState(controller);
  const [tab, setTab] = useState<ConsoleTab>("overview");

  // Credential health belongs to the main process, so the view mirrors both
  // the current snapshot and later pushes into the controller: one place owns
  // the warning and every surface renders it identically.
  useEffect(() => {
    let active = true;
    const apply = (push: {
      backend: "safeStorage" | "encryptedFile";
      degraded: boolean;
      reason?: string;
    }): void => {
      controller.setCredential({
        backend: push.backend,
        degraded: push.degraded,
        ...(push.reason === undefined ? {} : { reason: push.reason })
      });
    };
    const unsubscribe = bridge.onCredentialState(apply);
    void bridge["session.status"]({})
      .then((result) => {
        const status = result as SessionStatusResult;
        if (active && status.credential) {
          apply(status.credential);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge, controller]);

  const confirm =
    confirmAction ??
    ((message: string) => globalThis.confirm?.(message) === true);

  const projectIds = state.bootstrap?.projects.map((project) => project.id) ?? [];
  const role = state.bootstrap?.projects.find(
    (project) => project.id === state.selectedProjectId
  )?.role;
  const allowedModes: ApprovalMode[] = role
    ? approvalModeOptions(role).map((option) => option.value)
    : [];
  const pendingApproval =
    state.currentRun?.status === "waiting_approval"
      ? state.currentRun.pendingApproval
      : undefined;

  // A blocking approval must be visible whichever tab the operator is on, so
  // selecting a Run that starts waiting on approval pulls the tab forward.
  useEffect(() => {
    if (pendingApproval && tab === "overview") {
      setTab("approval");
    }
  }, [pendingApproval, tab]);

  if (state.phase !== "ready") {
    return (
      <div className="app-shell">
        <ConnectionBar state={state} serverUrl={serverUrl} />
        <main className="main-area">
          <ConnectionScreen
            controller={controller}
            state={state}
            platform={platform}
            onGitHubLogin={onGitHubLogin}
            onConnect={onConnect}
          />
        </main>
        <StatusBar
          state={state}
          appVersion={appVersion}
          onDismissError={() => {
            controller.dismissError();
          }}
        />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <ConnectionBar state={state} serverUrl={serverUrl} />
      <main className="main-area">
        <div className="stack" style={{ padding: "12px 12px 0" }}>
          <DegradedStorageBanner state={state} />
          {state.error ? (
            <div className="banner" data-tone="negative" role="alert">
              <span>{state.error}</span>
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => {
                  controller.dismissError();
                }}
              >
                ×
              </button>
            </div>
          ) : null}
        </div>

        <div className="console-grid">
          <div className="column">
            <ProjectSidebar
              controller={controller}
              projectIds={projectIds}
              selectedProjectId={state.selectedProjectId}
              roleLabel={role ? ROLE_LABELS[role] : "—"}
            />
            <RunComposer controller={controller} state={state} allowedModes={allowedModes} />
            <RunHistoryList controller={controller} state={state} />
          </div>

          <div className="column">
            <div className="tabs" role="tablist">
              <button
                className="tab-button"
                type="button"
                role="tab"
                aria-selected={tab === "overview"}
                onClick={() => {
                  setTab("overview");
                }}
              >
                概览
              </button>
              <button
                className="tab-button"
                type="button"
                role="tab"
                aria-selected={tab === "changes"}
                onClick={() => {
                  setTab("changes");
                }}
              >
                变更
              </button>
              <button
                className="tab-button"
                type="button"
                role="tab"
                aria-selected={tab === "approval"}
                onClick={() => {
                  setTab("approval");
                }}
              >
                审批
                {pendingApproval ? <span className="tab-badge">1</span> : null}
              </button>
              <button
                className="tab-button"
                type="button"
                role="tab"
                aria-selected={tab === "devices"}
                onClick={() => {
                  setTab("devices");
                }}
              >
                设备
              </button>
            </div>

            <RunDetail controller={controller} state={state} onConfirmDiscard={() => confirm("确认丢弃该 Run 的隔离工作区？此操作无法撤销。")} />

            {/* A pending approval blocks the Run, so it stays on screen even
                when the operator is looking at another tab. */}
            {tab !== "approval" ? (
              <ApprovalCard controller={controller} state={state} />
            ) : null}
            {tab !== "approval" ? (
              <UserRequestCard controller={controller} state={state} />
            ) : null}

            {tab === "overview" ? (
              <>
                <Timeline state={state} />
                <VerificationPanel state={state} />
              </>
            ) : null}
            {tab === "changes" ? (
              <ChangesPanel
                controller={controller}
                state={state}
                onConfirmDiscard={() => confirm("确认丢弃该 Run 的隔离工作区？此操作无法撤销。")}
              />
            ) : null}
            {tab === "approval" ? (
              <>
                <ApprovalCard controller={controller} state={state} />
                <UserRequestCard controller={controller} state={state} />
              </>
            ) : null}
            {tab === "devices" ? (
              <DeviceManagerPanel
                controller={controller}
                state={state}
                onConfirmAction={confirm}
              />
            ) : null}
          </div>

          <div className="column">
            <BudgetPanel state={state} />
            <ArtifactPanel controller={controller} state={state} />
          </div>
        </div>
      </main>
      <StatusBar
        state={state}
        appVersion={appVersion}
        onDismissError={() => {
          controller.dismissError();
        }}
      />
    </div>
  );
}
