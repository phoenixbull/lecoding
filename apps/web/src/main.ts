import { createClient, LeCodingHttpError } from "@lecoding/client-sdk";
import type {
  ControlPlaneConfig,
  ProjectPolicyRule,
  RunChanges,
  RunEventV1,
  RunSummary,
  RunView,
  VerificationCheck
} from "@lecoding/contracts";
import {
  canLoadRunChanges,
  canResolveRunResult,
  formatApprovalDetails,
  formatEventTitle,
  formatEditableApproval,
  formatProjectPolicyRule,
  formatRunEventDetail,
  isTerminalStatus,
  isTerminalRunEvent,
  resolveProjectSelection,
  statusLabel,
  verificationTone
} from "./presentation.js";
import { followRunEventStream } from "./run-stream.js";
import "./styles.css";

const AUTH_TOKEN_STORAGE_KEY = "lecoding.httpAuthToken";
let client = createSessionClient(readSessionToken());
const form = requiredElement<HTMLFormElement>("#run-form");
const authPanel = requiredElement<HTMLElement>("#auth-panel");
const authForm = requiredElement<HTMLFormElement>("#auth-form");
const authTokenInput = requiredElement<HTMLInputElement>("#auth-token");
const githubLoginButton = requiredElement<HTMLButtonElement>("#github-login");
const clearAuthButton = requiredElement<HTMLButtonElement>("#clear-auth");
const submitButton = requiredElement<HTMLButtonElement>("#create-run");
const cancelButton = requiredElement<HTMLButtonElement>("#cancel-run");
const discardResultButton = requiredElement<HTMLButtonElement>("#discard-result");
const approvalCard = requiredElement<HTMLElement>("#approval-card");
const approvalSummary = requiredElement<HTMLElement>("#approval-summary");
const approvalCapability = requiredElement<HTMLElement>("#approval-capability");
const approvalRisk = requiredElement<HTMLElement>("#approval-risk");
const approvalReason = requiredElement<HTMLElement>("#approval-reason");
const approvalScope = requiredElement<HTMLSelectElement>("#approval-scope");
const approveButton = requiredElement<HTMLButtonElement>("#approve-approval");
const rejectButton = requiredElement<HTMLButtonElement>("#reject-approval");
const approvalEditPanel = requiredElement<HTMLElement>("#approval-edit-panel");
const approvalEditLabel = requiredElement<HTMLElement>("#approval-edit-label");
const approvalEditValue = requiredElement<HTMLTextAreaElement>("#approval-edit-value");
const approvalEditHelp = requiredElement<HTMLElement>("#approval-edit-help");
const editApproveButton = requiredElement<HTMLButtonElement>("#edit-approve");
const userRequestCard = requiredElement<HTMLElement>("#user-request-card");
const userRequestPrompt = requiredElement<HTMLElement>("#user-request-prompt");
const userResponse = requiredElement<HTMLTextAreaElement>("#user-response");
const answerButton = requiredElement<HTMLButtonElement>("#answer-run");
const steerButton = requiredElement<HTMLButtonElement>("#steer-run");
const projectValue = requiredElement<HTMLSelectElement>("#project-value");
const runIdValue = requiredElement<HTMLElement>("#run-id-value");
const statusBadge = requiredElement<HTMLElement>("#status-badge");
const streamState = requiredElement<HTMLElement>("#stream-state");
const timeline = requiredElement<HTMLOListElement>("#timeline");
const verification = requiredElement<HTMLElement>("#verification");
const emptyVerification = requiredElement<HTMLElement>("#verification-empty");
const errorBanner = requiredElement<HTMLElement>("#error-banner");
const environmentInput = requiredElement<HTMLInputElement>("#environment-id");
const runHistory = requiredElement<HTMLElement>("#run-history");
const policyRulesPanel = requiredElement<HTMLElement>("#policy-rules-panel");
const policyRules = requiredElement<HTMLElement>("#policy-rules");
const changedCount = requiredElement<HTMLElement>("#changed-count");
const changesState = requiredElement<HTMLElement>("#changes-state");
const changedFiles = requiredElement<HTMLElement>("#changed-files");
const diffOutput = requiredElement<HTMLElement>("#diff-output");

let bootstrap: ControlPlaneConfig | undefined;
let currentRun: RunView | undefined;
let streamController: AbortController | undefined;
let approvalCommandPending = false;
let renderedEditableApprovalId: string | undefined;
let userCommandPending = false;
let selectedRunId: string | undefined;
let selectedProjectId: string | undefined;
let recentRuns: RunSummary[] = [];
const discardedRunIds = new Set<string>();

void initialize();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void createRun();
});

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = authTokenInput.value.trim();
  if (token.length < 32) {
    showError("访问令牌至少需要 32 个字符。");
    return;
  }
  writeSessionToken(token);
  client = createSessionClient(token);
  authTokenInput.value = "";
  authPanel.hidden = true;
  clearAuthButton.hidden = false;
  void initialize();
});

clearAuthButton.addEventListener("click", () => {
  void logout();
});

githubLoginButton.addEventListener("click", () => {
  window.location.assign(client.getGitHubLoginUrl());
});

async function logout(): Promise<void> {
  streamController?.abort();
  await client.logout().catch(() => undefined);
  writeSessionToken(undefined);
  client = createSessionClient(undefined);
  bootstrap = undefined;
  clearAuthButton.hidden = true;
  clearAuthenticatedView();
  void initialize();
}

cancelButton.addEventListener("click", () => {
  void cancelCurrentRun();
});

discardResultButton.addEventListener("click", () => {
  void discardCurrentResult();
});

approveButton.addEventListener("click", () => {
  void resolveCurrentApproval("approve");
});

rejectButton.addEventListener("click", () => {
  void resolveCurrentApproval("reject");
});

editApproveButton.addEventListener("click", () => {
  void editAndApproveCurrentCapability();
});

answerButton.addEventListener("click", () => {
  void resolveUserRequest("answer");
});

steerButton.addEventListener("click", () => {
  void resolveUserRequest("steer");
});

runHistory.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }
  const button = event.target.closest<HTMLButtonElement>(
    "button[data-run-id]"
  );
  if (button?.dataset.runId) {
    void selectRun(button.dataset.runId);
  }
});

projectValue.addEventListener("change", () => {
  if (
    !bootstrap ||
    !bootstrap.projects.some((project) => project.id === projectValue.value) ||
    selectedProjectId === projectValue.value
  ) {
    return;
  }
  // Switching projects severs the old SSE/read model before loading the new scope.
  selectedProjectId = projectValue.value;
  clearProjectView("正在加载所选项目的 Run…");
  void loadHistory(true).catch(() => {
    showError("所选项目的 Run 历史暂时不可用；仍可创建新的 Run。");
  });
  void loadProjectPolicyRules();
});

policyRules.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }
  const button = event.target.closest<HTMLButtonElement>("button[data-rule-id]");
  if (button?.dataset.ruleId) {
    void revokeProjectPolicyRule(button.dataset.ruleId);
  }
});

async function initialize(): Promise<void> {
  try {
    bootstrap = await client.getControlPlaneConfig();
    authPanel.hidden = true;
    clearAuthButton.hidden = false;
    submitButton.disabled = false;
    hideError();
    const selection = resolveProjectSelection(bootstrap, selectedProjectId);
    selectedProjectId = selection.selectedProjectId;
    renderProjectOptions(selection.projectIds, selectedProjectId);
    environmentInput.value = bootstrap.defaultEnvironmentId;
    setStreamState("就绪", "idle");
  } catch (error) {
    if (error instanceof LeCodingHttpError && error.status === 401) {
      writeSessionToken(undefined);
      client = createSessionClient(undefined);
      requireAuthentication();
      return;
    }
    showError("无法连接本地 LeCoding 控制面，请确认 Worker 已启动。");
    setStreamState("离线", "negative");
    submitButton.disabled = true;
    return;
  }
  try {
    await loadHistory(true);
  } catch {
    showError("Run 历史暂时不可用；仍可创建新的 Run。");
  }
  await loadProjectPolicyRules();
}

async function loadProjectPolicyRules(): Promise<void> {
  if (!selectedProjectId) {
    policyRulesPanel.hidden = true;
    return;
  }
  try {
    const result = await client.listProjectPolicyRules(selectedProjectId);
    renderProjectPolicyRules(result.rules);
    policyRulesPanel.hidden = false;
  } catch (error) {
    // The API deliberately returns 404 to hide this admin-only surface.
    if (error instanceof LeCodingHttpError && error.status === 404) {
      policyRulesPanel.hidden = true;
      policyRules.replaceChildren();
      return;
    }
    policyRulesPanel.hidden = false;
    policyRules.textContent = "项目审批规则暂时不可用。";
  }
}

function renderProjectPolicyRules(rules: ProjectPolicyRule[]): void {
  const activeRules = rules.filter((rule) => rule.revokedAt === undefined);
  if (activeRules.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "当前没有生效中的项目规则。";
    policyRules.replaceChildren(empty);
    return;
  }
  policyRules.replaceChildren(
    ...activeRules.map((rule) => {
      const details = formatProjectPolicyRule(rule);
      const row = document.createElement("div");
      row.className = "policy-rule-row";
      const summary = document.createElement("span");
      summary.textContent = `${details.capability} · ${details.decision} · ${details.fingerprint}`;
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "secondary-button compact";
      revoke.dataset.ruleId = details.id;
      revoke.textContent = "撤销";
      row.replaceChildren(summary, revoke);
      return row;
    })
  );
}

async function revokeProjectPolicyRule(ruleId: string): Promise<void> {
  if (!selectedProjectId) {
    return;
  }
  try {
    await client.revokeProjectPolicyRule(selectedProjectId, ruleId);
    await loadProjectPolicyRules();
  } catch {
    showError("项目审批规则撤销失败，请刷新后重试。");
  }
}

function createSessionClient(accessToken: string | undefined) {
  return createClient({
    baseUrl: window.location.origin,
    ...(accessToken ? { accessToken } : {})
  });
}

function readSessionToken(): string | undefined {
  try {
    return window.sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeSessionToken(token: string | undefined): void {
  try {
    if (token) {
      // sessionStorage avoids URL leakage and clears the credential with the tab session.
      window.sessionStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    } else {
      window.sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    }
  } catch {
    // The in-memory client remains usable when browser storage is unavailable.
  }
}

function requireAuthentication(): void {
  clearAuthenticatedView();
  bootstrap = undefined;
  authPanel.hidden = false;
  clearAuthButton.hidden = true;
  renderProjectOptions([], undefined, "需要认证");
  submitButton.disabled = true;
  showError("控制面需要登录，请使用获准的 GitHub 账号或访问令牌。");
  setStreamState("需要认证", "warning");
  authTokenInput.focus();
}

function clearAuthenticatedView(): void {
  // Logout removes already-rendered task and evidence text before any network retry.
  discardedRunIds.clear();
  clearProjectView("认证后显示受管工作区变更。");
  selectedProjectId = undefined;
  renderProjectOptions([], undefined, "连接中…");
}

function clearProjectView(changesMessage = "选择 Run 后显示其受管工作区变更。"): void {
  streamController?.abort();
  streamController = undefined;
  currentRun = undefined;
  selectedRunId = undefined;
  recentRuns = [];
  approvalCommandPending = false;
  userCommandPending = false;
  timeline.replaceChildren();
  runHistory.replaceChildren();
  const historyPlaceholder = document.createElement("p");
  historyPlaceholder.className = "empty-state";
  historyPlaceholder.textContent = "正在加载最近 Run…";
  runHistory.append(historyPlaceholder);
  policyRules.replaceChildren();
  policyRulesPanel.hidden = true;
  verification.replaceChildren();
  verification.append(emptyVerification);
  emptyVerification.hidden = false;
  approvalCard.hidden = true;
  userRequestCard.hidden = true;
  cancelButton.hidden = true;
  discardResultButton.hidden = true;
  runIdValue.textContent = "—";
  statusBadge.textContent = "尚未创建";
  delete statusBadge.dataset.status;
  setStreamState("就绪", "idle");
  resetChanges(changesMessage);
}

function renderProjectOptions(
  projectIds: readonly string[],
  selected: string | undefined,
  emptyLabel = "没有可用项目"
): void {
  projectValue.replaceChildren();
  if (projectIds.length === 0) {
    const option = document.createElement("option");
    option.textContent = emptyLabel;
    projectValue.append(option);
    projectValue.disabled = true;
    return;
  }
  for (const projectId of projectIds) {
    const option = document.createElement("option");
    option.value = projectId;
    option.textContent = projectId;
    option.selected = projectId === selected;
    projectValue.append(option);
  }
  // A single registration remains visible but does not imply a false choice.
  projectValue.disabled = projectIds.length === 1;
}

async function createRun(): Promise<void> {
  if (!bootstrap || !selectedProjectId) {
    return;
  }
  hideError();
  submitButton.disabled = true;
  streamController?.abort();
  selectedRunId = undefined;
  timeline.replaceChildren();
  resetChanges();
  verification.replaceChildren();
  verification.append(emptyVerification);
  emptyVerification.hidden = false;

  const data = new FormData(form);
  const acceptanceCriteria = String(data.get("acceptanceCriteria") ?? "")
    .split("\n")
    .map((criterion) => criterion.trim())
    .filter(Boolean);
  try {
    const { runId } = await client.createRun(selectedProjectId, {
      environmentId: String(data.get("environmentId") ?? "").trim(),
      task: String(data.get("task") ?? "").trim(),
      acceptanceCriteria,
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });
    selectedRunId = runId;
    currentRun = await client.inspectRun(runId);
    renderRun(currentRun);
    await loadHistory(false).catch(() => undefined);
    setStreamState("连接中", "warning");
    void followRun(runId);
  } catch {
    showError("创建 Run 失败。请检查任务、验收条件及 Worker 日志。");
    setStreamState("请求失败", "negative");
  } finally {
    submitButton.disabled = false;
  }
}

async function followRun(runId: string): Promise<void> {
  const controller = new AbortController();
  streamController = controller;
  setStreamState("实时连接", "positive");
  await followRunEventStream({
    client,
    runId,
    signal: controller.signal,
    async onEvent(event) {
      if (controller.signal.aborted || selectedRunId !== runId) {
        return "stop";
      }
      setStreamState("实时连接", "positive");
      appendEvent(event);
      const inspected = await client.inspectRun(runId);
      if (controller.signal.aborted || selectedRunId !== runId) {
        return "stop";
      }
      currentRun = inspected;
      renderRun(inspected);
      updateHistoryStatus(inspected);
      if (canLoadRunChanges(inspected.status)) {
        void loadChanges(runId);
      } else if (inspected.status === "cancelled") {
        resetChanges("已取消 Run 的隔离工作区已安全清理。");
      }
      if (isTerminalRunEvent(event)) {
        setStreamState("已完成", "idle");
        return "stop";
      }
      return "continue";
    },
    async onReconnect() {
      if (!controller.signal.aborted) {
        setStreamState("正在重连", "warning");
        // Refresh keeps status useful while the durable SSE cursor reconnects.
        const refreshed = await refreshRun(runId);
        if (refreshed && isTerminalStatus(refreshed.status)) {
          setStreamState("已完成", "idle");
          return "stop";
        }
      }
      return "continue";
    }
  }).catch(() => {
    if (!controller.signal.aborted) {
      showError("实时事件恢复失败；当前状态仍可通过刷新 Run 获取。");
      setStreamState("恢复失败", "negative");
      void refreshRun(runId);
    }
  });
}

async function cancelCurrentRun(): Promise<void> {
  if (!currentRun || isTerminalStatus(currentRun.status)) {
    return;
  }
  hideError();
  cancelButton.disabled = true;
  try {
    await client.cancelRun(currentRun.id);
    await refreshRun(currentRun.id);
  } catch {
    showError("取消请求未被接受，Run 可能已经进入终态或正在交接租约。");
  }
}

async function refreshRun(runId: string): Promise<RunView | undefined> {
  try {
    const inspected = await client.inspectRun(runId);
    if (selectedRunId !== runId) {
      return undefined;
    }
    currentRun = inspected;
    renderRun(inspected);
    updateHistoryStatus(inspected);
    return inspected;
  } catch {
    showError("无法刷新 Run 当前状态。");
    return undefined;
  }
}

async function loadHistory(restoreLatest: boolean): Promise<void> {
  if (!bootstrap || !selectedProjectId) {
    return;
  }
  const result = await client.listRuns(selectedProjectId, 20);
  recentRuns = result.runs;
  renderHistory();
  if (restoreLatest && !selectedRunId && recentRuns[0]) {
    await selectRun(recentRuns[0].id);
  }
}

async function selectRun(runId: string): Promise<void> {
  if (selectedRunId === runId && currentRun) {
    return;
  }
  streamController?.abort();
  selectedRunId = runId;
  currentRun = undefined;
  timeline.replaceChildren();
  resetChanges();
  setStreamState("恢复中", "warning");
  renderHistory();
  try {
    const inspected = await client.inspectRun(runId);
    if (selectedRunId !== runId) {
      return;
    }
    currentRun = inspected;
    renderRun(inspected);
    updateHistoryStatus(inspected);
    if (canLoadRunChanges(inspected.status)) {
      await loadChanges(runId);
    } else if (inspected.status === "cancelled") {
      resetChanges("已取消 Run 的隔离工作区已安全清理。");
    }
    // Even terminal Runs replay their durable event history through the same SSE seam.
    void followRun(runId);
  } catch {
    if (selectedRunId === runId) {
      showError("无法恢复所选 Run，它可能已被清理或当前不可访问。");
      setStreamState("恢复失败", "negative");
    }
  }
}

async function loadChanges(runId: string): Promise<void> {
  try {
    const changes = await client.getRunChanges(runId);
    if (selectedRunId === runId) {
      renderChanges(changes);
    }
  } catch (error) {
    if (selectedRunId === runId) {
      if (error instanceof LeCodingHttpError && error.status === 404) {
        // A discarded result has no worktree to read; remember that disposition locally.
        discardedRunIds.add(runId);
        updateResultAction();
      }
      resetChanges("当前 Run 尚未产生可读取的工作区变更。");
    }
  }
}

async function discardCurrentResult(): Promise<void> {
  if (!currentRun || !canResolveRunResult(currentRun.status)) {
    return;
  }
  const runId = currentRun.id;
  if (!window.confirm("确认丢弃该 Run 的隔离工作区？此操作无法撤销。")) {
    return;
  }
  hideError();
  discardResultButton.disabled = true;
  try {
    await client.resolveRunResult(runId, "discard");
    discardedRunIds.add(runId);
    resetChanges("该 Run 的隔离工作区已安全丢弃，源仓库未被修改。");
  } catch {
    showError("无法丢弃 Run 结果；请确认 Run 已进入终态后重试。");
  } finally {
    updateResultAction();
  }
}

function renderChanges(changes: RunChanges): void {
  changedCount.textContent = `${changes.changedFiles.length} 个文件`;
  changesState.textContent = changes.truncated
    ? "变更内容较大，当前展示已按安全上限截断。"
    : changes.changedFiles.length > 0
      ? "以下内容来自 Run 的受管 Git worktree。"
      : "当前工作区没有未提交变更。";
  changedFiles.replaceChildren();
  for (const path of changes.changedFiles) {
    const item = document.createElement("div");
    item.className = "changed-file";
    item.textContent = path;
    changedFiles.append(item);
  }
  diffOutput.textContent = changes.unifiedDiff || "没有可展示的文本 Diff。";
}

function resetChanges(message = "选择 Run 后显示其受管工作区变更。"): void {
  changedCount.textContent = "0 个文件";
  changesState.textContent = message;
  changedFiles.replaceChildren();
  diffOutput.textContent = "";
}

function updateHistoryStatus(run: RunView): void {
  recentRuns = recentRuns.map((summary) =>
    summary.id === run.id ? { ...summary, status: run.status } : summary
  );
  renderHistory();
}

function renderHistory(): void {
  runHistory.replaceChildren();
  if (recentRuns.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "还没有 Run；创建后可在这里恢复。";
    runHistory.append(empty);
    return;
  }
  for (const run of recentRuns) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";
    button.dataset.runId = run.id;
    button.dataset.active = String(run.id === selectedRunId);
    const task = document.createElement("strong");
    task.textContent = run.task;
    const meta = document.createElement("span");
    meta.textContent = `${statusLabel(run.status)} · ${new Date(run.updatedAt).toLocaleString("zh-CN", { hour12: false })}`;
    button.append(task, meta);
    runHistory.append(button);
  }
}

function renderRun(run: RunView): void {
  runIdValue.textContent = run.id;
  statusBadge.textContent = statusLabel(run.status);
  statusBadge.dataset.status = run.status;
  cancelButton.disabled = isTerminalStatus(run.status) || run.status === "cancelling";
  cancelButton.hidden = false;
  updateResultAction();
  renderApproval(run);
  renderUserRequest(run);
  renderVerification(run.verification?.checks ?? []);
}

function updateResultAction(): void {
  const available =
    currentRun !== undefined &&
    canResolveRunResult(currentRun.status) &&
    !discardedRunIds.has(currentRun.id);
  discardResultButton.hidden = !available;
  discardResultButton.disabled = !available;
}

function renderApproval(run: RunView): void {
  const approval = run.status === "waiting_approval" ? run.pendingApproval : undefined;
  if (!approval) {
    approvalCard.hidden = true;
    approvalSummary.textContent = "";
    approvalCapability.textContent = "";
    approvalRisk.textContent = "";
    approvalReason.textContent = "";
    approvalScope.replaceChildren();
    approvalEditPanel.hidden = true;
    renderedEditableApprovalId = undefined;
    return;
  }
  const details = formatApprovalDetails(approval);
  // All provider/policy strings enter the DOM only through textContent.
  approvalSummary.textContent = details.target;
  approvalCapability.textContent = details.capability;
  approvalRisk.textContent = details.risk;
  approvalReason.textContent = details.reason;
  const previousScope = approvalScope.value;
  approvalScope.replaceChildren(
    ...details.allowedScopes.map(({ value, label }) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    })
  );
  if (details.allowedScopes.some(({ value }) => value === previousScope)) {
    // SSE refreshes must not silently weaken or broaden the user's selected scope.
    approvalScope.value = previousScope;
  }
  approvalCard.hidden = false;
  approveButton.disabled = approvalCommandPending;
  rejectButton.disabled = approvalCommandPending;
  approvalScope.disabled = approvalCommandPending;
  const editable = formatEditableApproval(approval);
  if (editable) {
    approvalEditLabel.textContent = editable.label;
    approvalEditHelp.textContent = editable.help;
    if (renderedEditableApprovalId !== approval.id) {
      // SSE refresh must preserve an in-progress user edit for the same approval.
      approvalEditValue.value = editable.value;
      renderedEditableApprovalId = approval.id;
    }
    approvalEditPanel.hidden = false;
    approvalEditValue.disabled = approvalCommandPending;
    editApproveButton.disabled = approvalCommandPending;
  } else {
    approvalEditPanel.hidden = true;
    renderedEditableApprovalId = undefined;
  }
}

async function editAndApproveCurrentCapability(): Promise<void> {
  const run = currentRun;
  const approval = run?.status === "waiting_approval" ? run.pendingApproval : undefined;
  const original = approval?.editableCapability;
  if (!run || !approval || !original || approvalCommandPending) {
    return;
  }
  const replacement =
    original.type === "command_exec"
      ? {
          type: "command_exec" as const,
          // Lines preserve argv boundaries; empty lines mean removed arguments.
          argv: approvalEditValue.value
            .replace(/\r\n/gu, "\n")
            .split("\n")
            .filter((argument) => argument.length > 0)
        }
      : {
          type: "network_egress" as const,
          scheme: "https" as const,
          domain: approvalEditValue.value.trim().toLowerCase(),
          port: original.port
        };
  hideError();
  approvalCommandPending = true;
  renderApproval(run);
  try {
    await client.editAndApproveRun(run.id, approval.id, replacement);
    await refreshRun(run.id);
  } catch {
    showError("修改后的能力未被接受；只能缩小原请求且不能绕过固定拒绝规则。");
  } finally {
    approvalCommandPending = false;
    if (currentRun) {
      renderApproval(currentRun);
    }
  }
}

function renderUserRequest(run: RunView): void {
  const request = run.status === "waiting_user" ? run.pendingUserRequest : undefined;
  const acceptsLiveSteering = [
    "queued",
    "preparing",
    "running",
    "environment_offline"
  ].includes(run.status);
  if (!request && !acceptsLiveSteering) {
    userRequestCard.hidden = true;
    userRequestPrompt.textContent = "";
    userResponse.value = "";
    return;
  }
  // Model-authored questions stay inert even if they contain markup-like text.
  userRequestPrompt.textContent =
    request?.prompt ?? "可追加约束；Agent 会在下一个安全模型回合读取。";
  userResponse.placeholder = request
    ? "回答问题，或作为追加约束继续本次 Run。"
    : "例如：保持旧版错误结构，不要修改公开 API。";
  userRequestCard.hidden = false;
  userResponse.disabled = userCommandPending;
  answerButton.hidden = !request;
  answerButton.disabled = userCommandPending;
  steerButton.disabled = userCommandPending;
}

async function resolveUserRequest(decision: "answer" | "steer"): Promise<void> {
  const run = currentRun;
  const request = run?.status === "waiting_user" ? run.pendingUserRequest : undefined;
  const acceptsLiveSteering =
    run !== undefined &&
    ["queued", "preparing", "running", "environment_offline"].includes(
      run.status
    );
  const value = userResponse.value.trim();
  if (
    !run ||
    (decision === "answer" && !request) ||
    (decision === "steer" && !request && !acceptsLiveSteering) ||
    value === "" ||
    value.length > 4_000 ||
    userCommandPending
  ) {
    return;
  }
  hideError();
  userCommandPending = true;
  renderUserRequest(run);
  try {
    if (decision === "answer") {
      if (!request) {
        return;
      }
      await client.answerRun(run.id, request.id, value);
    } else {
      await client.steerRun(run.id, value);
    }
    userResponse.value = "";
    await refreshRun(run.id);
  } catch {
    showError("用户输入未被接受；问题可能已失效或 Run 正由其他 Worker 接管。");
  } finally {
    userCommandPending = false;
    if (currentRun) {
      renderUserRequest(currentRun);
    }
  }
}

async function resolveCurrentApproval(
  decision: "approve" | "reject"
): Promise<void> {
  const run = currentRun;
  const approval = run?.status === "waiting_approval" ? run.pendingApproval : undefined;
  if (!run || !approval || approvalCommandPending) {
    return;
  }
  const scope =
    approvalScope.value === "project"
      ? "project"
      : approvalScope.value === "run"
        ? "run"
        : "once";
  hideError();
  approvalCommandPending = true;
  renderApproval(run);
  try {
    if (decision === "approve") {
      await client.approveRun(run.id, approval.id, scope);
    } else {
      await client.rejectRun(run.id, approval.id, scope);
    }
    await refreshRun(run.id);
  } catch {
    showError("审批操作未被接受；它可能已被其他 Worker 处理或已经失效。");
  } finally {
    approvalCommandPending = false;
    if (currentRun) {
      renderApproval(currentRun);
    }
  }
}

function appendEvent(event: RunEventV1): void {
  const item = document.createElement("li");
  item.className = "timeline-item";
  // Event type drives fixed local styling; provider/user text never becomes markup.
  item.dataset.eventType = event.type;
  const marker = document.createElement("span");
  marker.className = "timeline-marker";
  const content = document.createElement("div");
  content.className = "timeline-content";
  const title = document.createElement("strong");
  title.textContent = formatEventTitle(event.type);
  const detail = document.createElement("span");
  detail.textContent = formatRunEventDetail(event);
  const time = document.createElement("time");
  time.dateTime = event.occurredAt;
  time.textContent = new Date(event.occurredAt).toLocaleTimeString("zh-CN", {
    hour12: false
  });
  content.append(title, detail, time);
  item.append(marker, content);
  timeline.append(item);
  item.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderVerification(checks: VerificationCheck[]): void {
  verification.replaceChildren();
  if (checks.length === 0) {
    emptyVerification.hidden = false;
    verification.append(emptyVerification);
    return;
  }
  emptyVerification.hidden = true;
  for (const check of checks) {
    const card = document.createElement("article");
    card.className = "check-card";
    card.dataset.tone = verificationTone(check.outcome);
    const heading = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = check.name;
    const outcome = document.createElement("span");
    outcome.textContent = check.outcome;
    heading.append(name, outcome);
    const detail = document.createElement("p");
    detail.textContent = check.detail;
    card.append(heading, detail);
    verification.append(card);
  }
}

function setStreamState(
  label: string,
  tone: "idle" | "positive" | "warning" | "negative"
): void {
  streamState.textContent = label;
  streamState.dataset.tone = tone;
}

function showError(message: string): void {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
}

function hideError(): void {
  errorBanner.hidden = true;
  errorBanner.textContent = "";
}

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required Web element: ${selector}`);
  }
  return element;
}
