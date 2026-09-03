import type {
  ApprovalMode,
  ApprovalScope,
  ControlPlaneConfig,
  CreateRunInput,
  ProjectId,
  RunId,
  RunSummary,
  RunView
} from "@lecoding/contracts";
import {
  approvalModeOptions,
  canLoadRunChanges,
  canResolveRunResult,
  canSteerRun,
  followRunEventStream,
  formatEditableApproval,
  isTerminalRunEvent,
  isTerminalStatus,
  resolveProjectSelection,
  type RunEventSource
} from "@lecoding/presentation";
import { isNotFound, isUnauthorized, type RunGateway } from "./gateway.js";
import {
  createInitialRunConsoleState,
  type ComposerDraft,
  type CredentialState,
  type RunConsoleState
} from "./state.js";

/**
 * User-facing copy lives with the state machine, not with the view.
 *
 * Both the Web page and the Electron Renderer render these strings verbatim,
 * so a behaviour change can never diverge between the two surfaces.
 */
const MESSAGES = {
  needsAuth: "控制面需要登录，请使用获准的 GitHub 账号或访问令牌。",
  offline: "无法连接本地 LeCoding 控制面，请确认 Worker 已启动。",
  noProjects: "控制面没有注册任何项目，请先注册一个项目。",
  historyUnavailable: "Run 历史暂时不可用；仍可创建新的 Run。",
  projectHistoryUnavailable: "所选项目的 Run 历史暂时不可用；仍可创建新的 Run。",
  createFailed: "创建 Run 失败。请检查任务、验收条件及 Worker 日志。",
  cancelFailed: "取消请求未被接受，Run 可能已经进入终态或正在交接租约。",
  refreshFailed: "无法刷新 Run 当前状态。",
  selectFailed: "无法恢复所选 Run，它可能已被清理或当前不可访问。",
  discardFailed: "无法丢弃 Run 结果；请确认 Run 已进入终态后重试。",
  keepFailed: "无法保留 Run 结果；请确认 Run 已进入终态后重试。",
  approvalFailed: "审批操作未被接受；它可能已被其他 Worker 处理或已经失效。",
  editApprovalFailed: "修改后的能力未被接受；只能缩小原请求且不能绕过固定拒绝规则。",
  userInputFailed: "用户输入未被接受；问题可能已失效或 Run 正由其他 Worker 接管。",
  artifactUnavailable: "Artifact 已过保留期或当前账号无权读取。",
  streamFailed: "实时事件恢复失败；当前状态仍可通过刷新 Run 获取。",
  policyUnavailable: "项目审批规则暂时不可用。",
  policyRevokeFailed: "项目审批规则撤销失败，请刷新后重试。",
  deviceCodeFailed: "设备码生成失败；请确认项目仍然可用后重试。",
  deviceBindFailed: "设备绑定失败；设备码可能已被使用或已过期。",
  deviceListFailed: "设备列表暂时不可用。",
  deviceRevokeFailed: "设备撤销失败；它可能已经被服务器移除。",
  worktreeCleaned: "已取消 Run 的隔离工作区已安全清理。",
  worktreeDiscarded: "该 Run 的隔离工作区已安全丢弃，源仓库未被修改。",
  worktreeKept: "该 Run 的结果已保留在隔离工作区，源仓库未被修改。",
  changesTruncated: "变更内容较大，当前展示已按安全上限截断。",
  changesFromWorktree: "以下内容来自 Run 的受管 Git worktree。",
  changesEmpty: "当前工作区没有未提交变更。",
  changesUnreadable: "当前 Run 尚未产生可读取的工作区变更。",
  changesIdle: "选择 Run 后显示其受管工作区变更。"
} as const;

export interface RunConsoleControllerOptions {
  gateway: RunGateway;
  events: RunEventSource;
  /** Injectable reconnect delay keeps retry behaviour deterministic in tests. */
  waitBeforeReconnect?: (signal: AbortSignal) => Promise<void>;
  /** Number of recent Runs listed in the history panel. Default 20. */
  historyLimit?: number;
}

export interface RunConsoleController {
  /** Immutable snapshot; views read it and never write to it. */
  getState(): RunConsoleState;
  /** Returns an unsubscribe function. Listeners are notified at most once per microtask. */
  subscribe(listener: (state: RunConsoleState) => void): () => void;
  initialize(): Promise<void>;
  logout(): Promise<void>;
  setComposerDraft(patch: Partial<ComposerDraft>): void;
  selectProject(projectId: ProjectId): Promise<void>;
  createRun(): Promise<void>;
  selectRun(runId: RunId): Promise<void>;
  cancelCurrentRun(): Promise<void>;
  resolveCurrentResult(outcome: "keep" | "discard"): Promise<void>;
  setApprovalScope(scope: ApprovalScope): void;
  setApprovalDraft(value: string): void;
  resolveCurrentApproval(decision: "approve" | "reject"): Promise<void>;
  editAndApproveCurrent(): Promise<void>;
  setUserResponseDraft(value: string): void;
  resolveUserRequest(decision: "answer" | "steer"): Promise<void>;
  loadArtifact(artifactId: string): Promise<void>;
  refreshPolicyRules(): Promise<void>;
  revokePolicyRule(ruleId: string): Promise<void>;
  refreshDevices(): Promise<void>;
  createDeviceCode(): Promise<void>;
  bindDevice(input: { code: string; deviceLabel: string; platform: string }): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
  setCredential(credential: CredentialState | undefined): void;
  dismissError(): void;
  dispose(): void;
}

/**
 * Framework-neutral Run console state machine.
 *
 * The controller owns every Run-management behaviour — bootstrap, project
 * selection, Run creation, durable event following with reconnect and
 * de-duplication, approvals, user answers, verification evidence, and result
 * disposition. Views (Web DOM or React) only project the snapshot and forward
 * intents, which is what keeps the two surfaces semantically identical.
 */
export function createRunConsoleController(
  options: RunConsoleControllerOptions
): RunConsoleController {
  const { gateway, events } = options;
  const historyLimit = options.historyLimit ?? 20;

  let state: RunConsoleState = createInitialRunConsoleState();
  let streamController: AbortController | undefined;
  const listeners = new Set<(state: RunConsoleState) => void>();
  const inspectInFlight = new Map<RunId, Promise<RunView>>();
  let notifyScheduled = false;

  function notify(): void {
    if (notifyScheduled) {
      return;
    }
    notifyScheduled = true;
    // Coalescing into one microtask keeps an event burst from producing one
    // React commit (or one DOM rebuild) per event.
    queueMicrotask(() => {
      notifyScheduled = false;
      const snapshot = state;
      for (const listener of [...listeners]) {
        listener(snapshot);
      }
    });
  }

  function mutate(fn: (draft: RunConsoleState) => void): void {
    const draft: RunConsoleState = { ...state };
    fn(draft);
    state = draft;
    notify();
  }

  /** Assigns an optional key when a value exists and removes the key otherwise. */
  function assign<T extends keyof RunConsoleState>(
    draft: RunConsoleState,
    key: T,
    value: RunConsoleState[T] | undefined
  ): void {
    if (value === undefined) {
      delete (draft as Partial<RunConsoleState>)[key];
      return;
    }
    draft[key] = value;
  }

  function currentPendingApproval() {
    const run = state.currentRun;
    return run?.status === "waiting_approval" ? run.pendingApproval : undefined;
  }

  function currentPendingUserRequest() {
    const run = state.currentRun;
    return run?.status === "waiting_user" ? run.pendingUserRequest : undefined;
  }

  /**
   * One in-flight inspect per Run. During a reconnect storm every replayed
   * event triggers a refresh; without this merge the console would stack one
   * request per event instead of one per Run.
   */
  function inspectRun(runId: RunId): Promise<RunView> {
    const existing = inspectInFlight.get(runId);
    if (existing) {
      return existing;
    }
    const tracked = gateway.inspectRun(runId);
    void tracked.catch(() => undefined).then(() => {
      if (inspectInFlight.get(runId) === tracked) {
        inspectInFlight.delete(runId);
      }
    });
    inspectInFlight.set(runId, tracked);
    return tracked;
  }

  function updateHistoryStatus(run: RunView): void {
    mutate((draft) => {
      draft.recentRuns = draft.recentRuns.map((summary) =>
        summary.id === run.id ? { ...summary, status: run.status } : summary
      );
    });
  }

  /**
   * Applies a freshly inspected Run and preserves an in-progress approval edit.
   *
   * The draft is keyed by approval id: an SSE refresh for the same approval
   * must not clobber what the operator is typing, but a genuinely new approval
   * must start from the server-supplied value.
   */
  function applyRunView(view: RunView): void {
    const approval =
      view.status === "waiting_approval" ? view.pendingApproval : undefined;
    const keepsDraft = state.approvalDraft?.approvalId === approval?.id;
    mutate((draft) => {
      draft.currentRun = view;
      if (!keepsDraft) {
        const editable = approval ? formatEditableApproval(approval) : undefined;
        assign(
          draft,
          "approvalDraft",
          approval && editable
            ? { approvalId: approval.id, value: editable.value }
            : undefined
        );
      }
    });
  }

  function clearChanges(message: string): void {
    mutate((draft) => {
      assign(draft, "changes", undefined);
      draft.changesMessage = message;
    });
  }

  async function loadChanges(runId: RunId): Promise<void> {
    try {
      const changes = await gateway.getRunChanges(runId);
      if (state.selectedRunId !== runId) {
        return;
      }
      mutate((draft) => {
        draft.changes = changes;
        draft.changesMessage = changes.truncated
          ? MESSAGES.changesTruncated
          : changes.changedFiles.length > 0
            ? MESSAGES.changesFromWorktree
            : MESSAGES.changesEmpty;
      });
    } catch (error) {
      if (state.selectedRunId !== runId) {
        return;
      }
      mutate((draft) => {
        assign(draft, "changes", undefined);
        // A discarded result has no worktree left to read; remember that
        // disposition locally so the UI stops offering keep/discard.
        if (isNotFound(error) && !draft.discardedRunIds.includes(runId)) {
          draft.discardedRunIds = [...draft.discardedRunIds, runId];
        }
        draft.changesMessage = MESSAGES.changesUnreadable;
      });
    }
  }

  async function refreshRun(runId: RunId): Promise<RunView | undefined> {
    try {
      const inspected = await inspectRun(runId);
      if (state.selectedRunId !== runId) {
        return undefined;
      }
      applyRunView(inspected);
      updateHistoryStatus(inspected);
      return inspected;
    } catch {
      if (state.selectedRunId === runId) {
        mutate((draft) => {
          draft.error = MESSAGES.refreshFailed;
        });
      }
      return undefined;
    }
  }

  function followRun(runId: RunId): void {
    streamController?.abort();
    const controller = new AbortController();
    streamController = controller;
    mutate((draft) => {
      draft.stream = { phase: "connecting", runId };
    });

    void followRunEventStream({
      source: events,
      runId,
      signal: controller.signal,
      async onEvent(event) {
        if (controller.signal.aborted || state.selectedRunId !== runId) {
          return "stop";
        }
        mutate((draft) => {
          draft.stream = { phase: "live", runId };
          draft.timeline = [...draft.timeline, event];
        });
        const inspected = await inspectRun(runId).catch(() => undefined);
        if (controller.signal.aborted || state.selectedRunId !== runId) {
          return "stop";
        }
        if (inspected) {
          applyRunView(inspected);
          updateHistoryStatus(inspected);
          if (canLoadRunChanges(inspected.status)) {
            void loadChanges(runId);
          } else if (inspected.status === "cancelled") {
            clearChanges(MESSAGES.worktreeCleaned);
          }
          if (isTerminalRunEvent(event)) {
            mutate((draft) => {
              draft.stream = { phase: "closed", runId };
            });
            return "stop";
          }
        }
        return "continue";
      },
      async onReconnect() {
        if (controller.signal.aborted || state.selectedRunId !== runId) {
          return "stop";
        }
        mutate((draft) => {
          draft.stream = { phase: "reconnecting", runId };
        });
        // Refreshing on reconnect keeps the status useful while the durable
        // cursor replay is still catching up.
        const refreshed = await refreshRun(runId);
        if (refreshed && isTerminalStatus(refreshed.status)) {
          mutate((draft) => {
            draft.stream = { phase: "closed", runId };
          });
          return "stop";
        }
        return "continue";
      },
      ...(options.waitBeforeReconnect
        ? { waitBeforeReconnect: options.waitBeforeReconnect }
        : {})
    }).catch(() => {
      if (!controller.signal.aborted && state.selectedRunId === runId) {
        mutate((draft) => {
          draft.stream = { phase: "failed", runId };
          draft.error = MESSAGES.streamFailed;
        });
        void refreshRun(runId);
      }
    });
  }

  /** Re-derives the role-permitted approval modes and the default environment. */
  function applyProjectDefaults(): void {
    mutate((draft) => {
      if (!draft.bootstrap || draft.selectedProjectId === undefined) {
        return;
      }
      const role = draft.bootstrap.projects.find(
        (project) => project.id === draft.selectedProjectId
      )?.role;
      const allowed = role ? approvalModeOptions(role).map((option) => option.value) : [];
      const composer: ComposerDraft = { ...draft.composer };
      if (allowed.length > 0 && !allowed.includes(composer.approvalMode)) {
        composer.approvalMode = allowed[0]!;
      }
      if (composer.environmentId === "") {
        composer.environmentId = draft.bootstrap.defaultEnvironmentId;
      }
      draft.composer = composer;
      draft.canCreate = allowed.length > 0;
    });
  }

  async function loadHistory(restoreLatest: boolean): Promise<void> {
    const projectId = state.selectedProjectId;
    if (projectId === undefined) {
      return;
    }
    const result = await gateway.listRuns(projectId, historyLimit);
    if (state.selectedProjectId !== projectId) {
      return;
    }
    mutate((draft) => {
      draft.recentRuns = result.runs;
    });
    if (restoreLatest && !state.selectedRunId) {
      const latest: RunSummary | undefined = result.runs[0];
      if (latest) {
        await selectRun(latest.id);
      }
    }
  }

  function clearRunView(): void {
    streamController?.abort();
    streamController = undefined;
    mutate((draft) => {
      assign(draft, "currentRun", undefined);
      assign(draft, "selectedRunId", undefined);
      assign(draft, "changes", undefined);
      assign(draft, "artifactText", undefined);
      assign(draft, "approvalDraft", undefined);
      draft.timeline = [];
      draft.stream = { phase: "idle" };
      draft.changesMessage = MESSAGES.changesIdle;
    });
  }

  function applyUnauthenticated(draft: RunConsoleState): void {
    draft.phase = "needs_auth";
    assign(draft, "bootstrap", undefined);
    assign(draft, "selectedProjectId", undefined);
    assign(draft, "currentRun", undefined);
    assign(draft, "selectedRunId", undefined);
    assign(draft, "changes", undefined);
    assign(draft, "artifactText", undefined);
    assign(draft, "approvalDraft", undefined);
    draft.timeline = [];
    draft.recentRuns = [];
    draft.policyRules = [];
    draft.policyRulesVisible = false;
    draft.stream = { phase: "idle" };
    draft.canCreate = false;
    draft.changesMessage = MESSAGES.changesIdle;
  }

  /**
   * Loads the project policy rules, hiding the panel entirely when the server
   * answers 404 (its deliberate way of concealing an admin-only surface).
   */
  async function refreshPolicyRules(): Promise<void> {
    const projectId = state.selectedProjectId;
    if (projectId === undefined) {
      mutate((draft) => {
        draft.policyRulesVisible = false;
        draft.policyRules = [];
      });
      return;
    }
    try {
      const result = await gateway.listProjectPolicyRules(projectId);
      if (state.selectedProjectId !== projectId) {
        return;
      }
      mutate((draft) => {
        // Revoked rules stay in the server history but must not be offered as
        // something the operator can still revoke.
        draft.policyRules = result.rules.filter((rule) => rule.revokedAt === undefined);
        draft.policyRulesVisible = true;
      });
    } catch (error) {
      if (state.selectedProjectId !== projectId) {
        return;
      }
      const hidden = isNotFound(error);
      mutate((draft) => {
        draft.policyRules = [];
        draft.policyRulesVisible = !hidden;
        if (!hidden) {
          draft.error = MESSAGES.policyUnavailable;
        }
      });
    }
  }

  async function initialize(): Promise<void> {
    mutate((draft) => {
      draft.phase = "loading";
      assign(draft, "error", undefined);
    });
    let bootstrap: ControlPlaneConfig;
    try {
      bootstrap = await gateway.getControlPlaneConfig();
    } catch (error) {
      mutate((draft) => {
        if (isUnauthorized(error)) {
          applyUnauthenticated(draft);
          draft.error = MESSAGES.needsAuth;
          return;
        }
        draft.phase = "offline";
        draft.error = MESSAGES.offline;
      });
      return;
    }
    mutate((draft) => {
      draft.phase = "ready";
      draft.bootstrap = bootstrap;
      assign(draft, "error", undefined);
    });
    try {
      const selection = resolveProjectSelection(bootstrap, state.selectedProjectId);
      mutate((draft) => {
        draft.selectedProjectId = selection.selectedProjectId;
      });
    } catch {
      mutate((draft) => {
        draft.phase = "offline";
        draft.error = MESSAGES.noProjects;
      });
      return;
    }
    applyProjectDefaults();
    await loadHistory(true).catch(() => {
      mutate((draft) => {
        draft.error = MESSAGES.historyUnavailable;
      });
    });
    await refreshPolicyRules();
  }

  async function selectRun(runId: RunId): Promise<void> {
    if (state.selectedRunId === runId && state.currentRun) {
      return;
    }
    streamController?.abort();
    mutate((draft) => {
      assign(draft, "selectedRunId", runId);
      assign(draft, "currentRun", undefined);
      assign(draft, "changes", undefined);
      assign(draft, "artifactText", undefined);
      assign(draft, "approvalDraft", undefined);
      draft.timeline = [];
      draft.changesMessage = MESSAGES.changesIdle;
    });
    try {
      const inspected = await inspectRun(runId);
      if (state.selectedRunId !== runId) {
        return;
      }
      applyRunView(inspected);
      updateHistoryStatus(inspected);
      if (canLoadRunChanges(inspected.status)) {
        await loadChanges(runId);
      } else if (inspected.status === "cancelled") {
        clearChanges(MESSAGES.worktreeCleaned);
      }
    } catch {
      if (state.selectedRunId === runId) {
        mutate((draft) => {
          draft.error = MESSAGES.selectFailed;
          draft.stream = { phase: "failed", runId };
        });
        return;
      }
    }
    // Even terminal Runs replay their durable history through the same seam,
    // which is what makes "reopen the app and see the full timeline" work.
    followRun(runId);
  }

  return {
    getState(): RunConsoleState {
      return state;
    },

    subscribe(listener: (snapshot: RunConsoleState) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    initialize,

    async logout(): Promise<void> {
      streamController?.abort();
      streamController = undefined;
      await gateway.logout().catch(() => undefined);
      mutate((draft) => {
        applyUnauthenticated(draft);
        draft.phase = "loading";
        draft.discardedRunIds = [];
        draft.userResponseDraft = "";
      });
      await initialize();
    },

    setComposerDraft(patch: Partial<ComposerDraft>): void {
      mutate((draft) => {
        draft.composer = { ...draft.composer, ...patch };
      });
    },

    async selectProject(projectId: ProjectId): Promise<void> {
      if (!state.bootstrap?.projects.some((project) => project.id === projectId)) {
        return;
      }
      if (state.selectedProjectId === projectId) {
        return;
      }
      // Switching projects severs the old stream and read model before the new
      // scope is loaded, so no view can show cross-project data.
      clearRunView();
      mutate((draft) => {
        draft.selectedProjectId = projectId;
        draft.recentRuns = [];
        draft.policyRules = [];
        draft.policyRulesVisible = false;
      });
      applyProjectDefaults();
      await loadHistory(true).catch(() => {
        mutate((draft) => {
          draft.error = MESSAGES.projectHistoryUnavailable;
        });
      });
      await refreshPolicyRules();
    },

    async createRun(): Promise<void> {
      const projectId = state.selectedProjectId;
      if (!state.canCreate || projectId === undefined || state.pending.creating) {
        return;
      }
      const { task, acceptanceCriteria, environmentId, approvalMode } = state.composer;
      const trimmedTask = task.trim();
      if (trimmedTask === "" || environmentId.trim() === "") {
        return;
      }
      const input: CreateRunInput = {
        environmentId: environmentId.trim(),
        task: trimmedTask,
        acceptanceCriteria: splitCriteria(acceptanceCriteria),
        approvalMode: approvalMode as ApprovalMode,
        fileAccessScope: "workspace_only"
      };
      mutate((draft) => {
        draft.pending = { ...draft.pending, creating: true };
        assign(draft, "error", undefined);
      });
      try {
        const { runId } = await gateway.createRun(projectId, input);
        mutate((draft) => {
          assign(draft, "selectedRunId", runId);
          assign(draft, "currentRun", undefined);
          assign(draft, "changes", undefined);
          assign(draft, "artifactText", undefined);
          assign(draft, "approvalDraft", undefined);
          draft.timeline = [];
          draft.changesMessage = MESSAGES.changesIdle;
          draft.composer = { ...draft.composer, task: "", acceptanceCriteria: "" };
        });
        const inspected = await inspectRun(runId);
        if (state.selectedRunId === runId) {
          applyRunView(inspected);
        }
        await loadHistory(false).catch(() => undefined);
        followRun(runId);
      } catch {
        mutate((draft) => {
          draft.error = MESSAGES.createFailed;
          draft.stream = { phase: "failed" };
        });
      } finally {
        mutate((draft) => {
          draft.pending = { ...draft.pending, creating: false };
        });
      }
    },

    selectRun,

    async cancelCurrentRun(): Promise<void> {
      const run = state.currentRun;
      if (!run || isTerminalStatus(run.status) || run.status === "cancelling") {
        return;
      }
      mutate((draft) => {
        draft.pending = { ...draft.pending, cancelling: true };
        assign(draft, "error", undefined);
      });
      try {
        await gateway.cancelRun(run.id);
        await refreshRun(run.id);
      } catch {
        mutate((draft) => {
          draft.error = MESSAGES.cancelFailed;
        });
      } finally {
        mutate((draft) => {
          draft.pending = { ...draft.pending, cancelling: false };
        });
      }
    },

    async resolveCurrentResult(outcome: "keep" | "discard"): Promise<void> {
      const run = state.currentRun;
      if (
        !run ||
        !canResolveRunResult(run.status) ||
        state.discardedRunIds.includes(run.id) ||
        state.pending.resolving
      ) {
        return;
      }
      const runId = run.id;
      mutate((draft) => {
        draft.pending = { ...draft.pending, resolving: true };
        assign(draft, "error", undefined);
      });
      try {
        await gateway.resolveRunResult(runId, outcome);
        mutate((draft) => {
          if (outcome === "discard" && !draft.discardedRunIds.includes(runId)) {
            draft.discardedRunIds = [...draft.discardedRunIds, runId];
          }
          assign(draft, "changes", undefined);
          assign(draft, "artifactText", undefined);
          draft.changesMessage =
            outcome === "discard" ? MESSAGES.worktreeDiscarded : MESSAGES.worktreeKept;
        });
      } catch {
        mutate((draft) => {
          draft.error = outcome === "discard" ? MESSAGES.discardFailed : MESSAGES.keepFailed;
        });
      } finally {
        mutate((draft) => {
          draft.pending = { ...draft.pending, resolving: false };
        });
      }
    },

    setApprovalScope(scope: ApprovalScope): void {
      mutate((draft) => {
        draft.approvalScope = scope;
      });
    },

    setApprovalDraft(value: string): void {
      const approval = currentPendingApproval();
      if (!approval) {
        return;
      }
      mutate((draft) => {
        draft.approvalDraft = { approvalId: approval.id, value };
      });
    },

    async resolveCurrentApproval(decision: "approve" | "reject"): Promise<void> {
      const run = state.currentRun;
      const approval = currentPendingApproval();
      if (!run || !approval || state.pending.approval) {
        return;
      }
      const scope = state.approvalScope;
      mutate((draft) => {
        draft.pending = { ...draft.pending, approval: true };
        assign(draft, "error", undefined);
      });
      try {
        if (decision === "approve") {
          await gateway.approveRun(run.id, approval.id, scope);
        } else {
          await gateway.rejectRun(run.id, approval.id, scope);
        }
        await refreshRun(run.id);
      } catch {
        mutate((draft) => {
          draft.error = MESSAGES.approvalFailed;
        });
      } finally {
        mutate((draft) => {
          draft.pending = { ...draft.pending, approval: false };
        });
      }
    },

    async editAndApproveCurrent(): Promise<void> {
      const run = state.currentRun;
      const approval = currentPendingApproval();
      const original = approval?.editableCapability;
      const draftValue = state.approvalDraft?.value;
      if (
        !run ||
        !approval ||
        !original ||
        draftValue === undefined ||
        state.approvalDraft?.approvalId !== approval.id ||
        state.pending.approval
      ) {
        return;
      }
      // The operator may only narrow the request: command argv keeps its order
      // and loses entries, and a network target only moves to a sub-domain.
      const replacement =
        original.type === "command_exec"
          ? {
              type: "command_exec" as const,
              argv: draftValue
                .replace(/\r\n/gu, "\n")
                .split("\n")
                .filter((argument) => argument.length > 0)
            }
          : {
              type: "network_egress" as const,
              scheme: "https" as const,
              domain: draftValue.trim().toLowerCase(),
              port: original.port
            };
      mutate((draft) => {
        draft.pending = { ...draft.pending, approval: true };
        assign(draft, "error", undefined);
      });
      try {
        await gateway.editAndApproveRun(run.id, approval.id, replacement);
        await refreshRun(run.id);
      } catch {
        mutate((draft) => {
          draft.error = MESSAGES.editApprovalFailed;
        });
      } finally {
        mutate((draft) => {
          draft.pending = { ...draft.pending, approval: false };
        });
      }
    },

    setUserResponseDraft(value: string): void {
      mutate((draft) => {
        draft.userResponseDraft = value;
      });
    },

    async resolveUserRequest(decision: "answer" | "steer"): Promise<void> {
      const run = state.currentRun;
      const request = currentPendingUserRequest();
      const acceptsSteering = run !== undefined && canSteerRun(run.status);
      const value = state.userResponseDraft.trim();
      if (
        !run ||
        (decision === "answer" && !request) ||
        (decision === "steer" && !request && !acceptsSteering) ||
        value === "" ||
        value.length > 4_000 ||
        state.pending.userRequest
      ) {
        return;
      }
      mutate((draft) => {
        draft.pending = { ...draft.pending, userRequest: true };
        assign(draft, "error", undefined);
      });
      try {
        if (decision === "answer" && request) {
          await gateway.answerRun(run.id, request.id, value);
        } else {
          await gateway.steerRun(run.id, value);
        }
        mutate((draft) => {
          draft.userResponseDraft = "";
        });
        await refreshRun(run.id);
      } catch {
        mutate((draft) => {
          draft.error = MESSAGES.userInputFailed;
        });
      } finally {
        mutate((draft) => {
          draft.pending = { ...draft.pending, userRequest: false };
        });
      }
    },

    async loadArtifact(artifactId: string): Promise<void> {
      const run = state.currentRun;
      if (!run || state.pending.artifact) {
        return;
      }
      const runId = run.id;
      mutate((draft) => {
        draft.pending = { ...draft.pending, artifact: true };
        draft.artifactText = "正在读取脱敏输出…";
      });
      try {
        const content = await gateway.getRunArtifact(runId, artifactId);
        if (state.currentRun?.id === runId) {
          mutate((draft) => {
            draft.artifactText = content;
          });
        }
      } catch {
        if (state.currentRun?.id === runId) {
          mutate((draft) => {
            draft.artifactText = MESSAGES.artifactUnavailable;
          });
        }
      } finally {
        mutate((draft) => {
          draft.pending = { ...draft.pending, artifact: false };
        });
      }
    },

    refreshPolicyRules,

    async revokePolicyRule(ruleId: string): Promise<void> {
      const projectId = state.selectedProjectId;
      if (projectId === undefined) {
        return;
      }
      try {
        await gateway.revokeProjectPolicyRule(projectId, ruleId);
        await refreshPolicyRules();
      } catch {
        mutate((draft) => {
          draft.error = MESSAGES.policyRevokeFailed;
        });
      }
    },

    async refreshDevices(): Promise<void> {
      try {
        const listing = await gateway.listDevices();
        mutate((draft) => {
          draft.devices = listing.devices;
        });
      } catch {
        mutate((draft) => {
          draft.error = MESSAGES.deviceListFailed;
        });
      }
    },

    async createDeviceCode(): Promise<void> {
      const projectId = state.selectedProjectId;
      if (projectId === undefined || state.binding) {
        return;
      }
      mutate((draft) => {
        draft.binding = true;
        assign(draft, "error", undefined);
      });
      try {
        const issued = await gateway.createDeviceCode(projectId);
        mutate((draft) => {
          draft.deviceCode = { code: issued.code, expiresAt: issued.expiresAt };
        });
      } catch {
        mutate((draft) => {
          assign(draft, "deviceCode", undefined);
          draft.error = MESSAGES.deviceCodeFailed;
        });
      } finally {
        mutate((draft) => {
          draft.binding = false;
        });
      }
    },

    async bindDevice(input: {
      code: string;
      deviceLabel: string;
      platform: string;
    }): Promise<void> {
      const projectId = state.selectedProjectId;
      const trimmedCode = input.code.trim();
      const trimmedLabel = input.deviceLabel.trim();
      if (projectId === undefined || state.binding || trimmedCode === "") {
        return;
      }
      mutate((draft) => {
        draft.binding = true;
        assign(draft, "error", undefined);
      });
      try {
        // The exchange deliberately carries no session token: the device
        // authenticates with the one-time code, not with a browser session.
        await gateway.exchangeDeviceCode({
          code: trimmedCode,
          deviceLabel: trimmedLabel === "" ? "LeCoding Desktop" : trimmedLabel,
          platform: input.platform,
          projectId
        });
        mutate((draft) => {
          // The code is single-use; keeping it on screen invites a failed retry.
          assign(draft, "deviceCode", undefined);
        });
        await this.refreshDevices();
        await initialize();
      } catch {
        mutate((draft) => {
          draft.error = MESSAGES.deviceBindFailed;
        });
      } finally {
        mutate((draft) => {
          draft.binding = false;
        });
      }
    },

    async revokeDevice(deviceId: string): Promise<void> {
      try {
        await gateway.revokeDevice(deviceId);
        mutate((draft) => {
          draft.devices = draft.devices.filter(
            (device) => device.deviceId !== deviceId
          );
        });
        await this.refreshDevices();
      } catch {
        mutate((draft) => {
          draft.error = MESSAGES.deviceRevokeFailed;
        });
      }
    },

    setCredential(credential: CredentialState | undefined): void {
      mutate((draft) => {
        assign(draft, "credential", credential);
      });
    },

    dismissError(): void {
      mutate((draft) => {
        assign(draft, "error", undefined);
      });
    },

    dispose(): void {
      streamController?.abort();
      streamController = undefined;
      listeners.clear();
      inspectInFlight.clear();
    }
  };
}

/** Splits the acceptance-criteria textarea into trimmed, non-empty entries. */
function splitCriteria(raw: string): string[] {
  return raw
    .split("\n")
    .map((criterion) => criterion.trim())
    .filter(Boolean);
}
