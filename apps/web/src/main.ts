import { createClient, type LeCodingClient } from "@lecoding/client-sdk";
import type { RunSummary } from "@lecoding/contracts";
import {
  approvalModeOptions,
  canResolveRunResult,
  canSteerRun,
  formatApprovalDetails,
  formatEditableApproval,
  formatEventTitle,
  formatProjectPolicyRule,
  formatRunBudget,
  formatRunEventDetail,
  isTerminalStatus,
  statusLabel,
  verificationTone
} from "@lecoding/presentation";
import {
  createRunConsoleController,
  type RunConsoleState
} from "@lecoding/run-controller";
import { createSdkRunEventSource } from "./events.js";
import { createSdkRunGateway } from "./gateway.js";
import "./styles.css";

const AUTH_TOKEN_STORAGE_KEY = "lecoding.httpAuthToken";

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
const approvalModeInput = requiredElement<HTMLSelectElement>("#approval-mode");
const approvalModeHelp = requiredElement<HTMLElement>("#approval-mode-help");
const runHistory = requiredElement<HTMLElement>("#run-history");
const policyRulesPanel = requiredElement<HTMLElement>("#policy-rules-panel");
const policyRules = requiredElement<HTMLElement>("#policy-rules");
const changedCount = requiredElement<HTMLElement>("#changed-count");
const changesState = requiredElement<HTMLElement>("#changes-state");
const changedFiles = requiredElement<HTMLElement>("#changed-files");
const diffOutput = requiredElement<HTMLElement>("#diff-output");
const artifactList = requiredElement<HTMLElement>("#artifact-list");
const artifactOutput = requiredElement<HTMLElement>("#artifact-output");
const budgetPanel = requiredElement<HTMLElement>("#budget-panel");
const budgetModel = requiredElement<HTMLElement>("#budget-model");
const budgetTokens = requiredElement<HTMLElement>("#budget-tokens");
const budgetCost = requiredElement<HTMLElement>("#budget-cost");
const budgetWallTime = requiredElement<HTMLElement>("#budget-wall-time");
const budgetToolCalls = requiredElement<HTMLElement>("#budget-tool-calls");
const budgetModelRetries = requiredElement<HTMLElement>("#budget-model-retries");
const budgetTeamCost = requiredElement<HTMLElement>("#budget-team-cost");
const budgetWarnings = requiredElement<HTMLElement>("#budget-warnings");
const taskInput = requiredElement<HTMLTextAreaElement>("#task");
const acceptanceInput = requiredElement<HTMLTextAreaElement>("#acceptance-criteria");

/**
 * The browser session is the only thing the page owns.
 *
 * Everything else — bootstrap, project selection, Run lifecycle, approvals,
 * reconnect policy — lives in the framework-neutral controller, so this file
 * is only a projection of `RunConsoleState` plus intent forwarding.
 */
let currentClient = createSessionClient(readSessionToken());

const gateway = {
  ...createSdkRunGateway(() => currentClient),
  async logout(): Promise<void> {
    await currentClient.logout().catch(() => undefined);
    // Dropping the token before the controller re-bootstraps keeps a dead
    // session from being replayed on the next request.
    writeSessionToken(undefined);
    currentClient = createSessionClient(undefined);
  }
};

const controller = createRunConsoleController({
  gateway,
  events: createSdkRunEventSource(() => currentClient)
});

/** Number of timeline entries already rendered; lets us append instead of rebuild. */
let renderedTimelineCount = 0;

controller.subscribe((state) => {
  render(state);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void controller.createRun();
});

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = authTokenInput.value.trim();
  if (token.length < 32) {
    // The control plane rejects short tokens outright, so fail before a round trip.
    return;
  }
  writeSessionToken(token);
  currentClient = createSessionClient(token);
  authTokenInput.value = "";
  void controller.initialize();
});

clearAuthButton.addEventListener("click", () => {
  void controller.logout();
});

githubLoginButton.addEventListener("click", () => {
  window.location.assign(currentClient.getGitHubLoginUrl());
});

cancelButton.addEventListener("click", () => {
  void controller.cancelCurrentRun();
});

discardResultButton.addEventListener("click", () => {
  if (!window.confirm("确认丢弃该 Run 的隔离工作区？此操作无法撤销。")) {
    return;
  }
  void controller.resolveCurrentResult("discard");
});

approveButton.addEventListener("click", () => {
  void controller.resolveCurrentApproval("approve");
});

rejectButton.addEventListener("click", () => {
  void controller.resolveCurrentApproval("reject");
});

editApproveButton.addEventListener("click", () => {
  void controller.editAndApproveCurrent();
});

answerButton.addEventListener("click", () => {
  void controller.resolveUserRequest("answer");
});

steerButton.addEventListener("click", () => {
  void controller.resolveUserRequest("steer");
});

approvalScope.addEventListener("change", () => {
  controller.setApprovalScope(
    approvalScope.value === "project"
      ? "project"
      : approvalScope.value === "run"
        ? "run"
        : "once"
  );
});

approvalEditValue.addEventListener("input", () => {
  controller.setApprovalDraft(approvalEditValue.value);
});

userResponse.addEventListener("input", () => {
  controller.setUserResponseDraft(userResponse.value);
});

taskInput.addEventListener("input", () => {
  controller.setComposerDraft({ task: taskInput.value });
});

acceptanceInput.addEventListener("input", () => {
  controller.setComposerDraft({ acceptanceCriteria: acceptanceInput.value });
});

environmentInput.addEventListener("input", () => {
  controller.setComposerDraft({ environmentId: environmentInput.value });
});

approvalModeInput.addEventListener("change", () => {
  controller.setComposerDraft({
    approvalMode: approvalModeInput.value as RunConsoleState["composer"]["approvalMode"]
  });
});

projectValue.addEventListener("change", () => {
  void controller.selectProject(projectValue.value);
});

runHistory.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const button = target.closest<HTMLButtonElement>("button[data-run-id]");
  if (button?.dataset.runId) {
    void controller.selectRun(button.dataset.runId);
  }
});

artifactList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const button = target.closest<HTMLButtonElement>("button[data-artifact-id]");
  if (button?.dataset.artifactId) {
    void controller.loadArtifact(button.dataset.artifactId);
  }
});

policyRules.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const button = target.closest<HTMLButtonElement>("button[data-rule-id]");
  if (button?.dataset.ruleId) {
    void controller.revokePolicyRule(button.dataset.ruleId);
  }
});

errorBanner.addEventListener("click", () => {
  controller.dismissError();
});

void controller.initialize();

function render(state: RunConsoleState): void {
  const authenticated = state.phase !== "needs_auth";
  authPanel.hidden = authenticated;
  clearAuthButton.hidden = !authenticated;

  renderError(state);
  renderProjectOptions(state);
  renderComposer(state);
  renderHistory(state);
  renderPolicyRules(state);
  renderRunHeader(state);
  renderStream(state);
  renderBudget(state);
  renderApproval(state);
  renderUserRequest(state);
  renderTimeline(state);
  renderVerification(state);
  renderArtifacts(state);
  renderChanges(state);
  renderResultAction(state);
}

function renderError(state: RunConsoleState): void {
  errorBanner.textContent = state.error ?? "";
  errorBanner.hidden = state.error === undefined;
}

function renderProjectOptions(state: RunConsoleState): void {
  const projects = state.bootstrap?.projects ?? [];
  projectValue.replaceChildren();
  if (projects.length === 0) {
    const option = document.createElement("option");
    option.textContent =
      state.phase === "loading" ? "连接中…" : state.phase === "needs_auth" ? "需要认证" : "没有可用项目";
    projectValue.append(option);
    projectValue.disabled = true;
    return;
  }
  for (const project of projects) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.id;
    option.selected = project.id === state.selectedProjectId;
    projectValue.append(option);
  }
  // A single registration stays visible but must not imply a false choice.
  projectValue.disabled = projects.length === 1;
}

function renderComposer(state: RunConsoleState): void {
  setValueIfChanged(taskInput, state.composer.task);
  setValueIfChanged(acceptanceInput, state.composer.acceptanceCriteria);
  setValueIfChanged(environmentInput, state.composer.environmentId);

  const role = state.bootstrap?.projects.find(
    (project) => project.id === state.selectedProjectId
  )?.role;
  const options = role ? approvalModeOptions(role) : [];
  approvalModeInput.replaceChildren(
    ...options.map(({ value, label }) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    })
  );
  setValueIfChanged(approvalModeInput, state.composer.approvalMode);
  approvalModeInput.disabled = options.length === 0;
  approvalModeHelp.textContent =
    state.composer.approvalMode === "full_access"
      ? "仅管理员可用；仍受工作区隔离、固定拒绝和硬限制约束。"
      : state.composer.approvalMode === "auto_review"
        ? "独立风险审查器自动放行低风险操作，其余仍会请求批准。"
        : approvalModeInput.disabled
          ? "当前项目只有查看权限，不能创建 Run。"
          : "按能力规则请求批准，固定拒绝始终不可绕过。";
  submitButton.disabled = !state.canCreate || state.pending.creating;
}

function renderHistory(state: RunConsoleState): void {
  runHistory.replaceChildren();
  if (state.recentRuns.length === 0) {
    runHistory.append(
      emptyState(
        state.phase === "loading" ? "正在加载最近 Run…" : "还没有 Run；创建后可在这里恢复。"
      )
    );
    return;
  }
  for (const run of state.recentRuns) {
    runHistory.append(historyButton(run, run.id === state.selectedRunId));
  }
}

function renderPolicyRules(state: RunConsoleState): void {
  policyRulesPanel.hidden = !state.policyRulesVisible;
  policyRules.replaceChildren();
  if (state.policyRules.length === 0) {
    policyRules.append(emptyState("当前没有生效中的项目规则。"));
    return;
  }
  for (const rule of state.policyRules) {
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
    policyRules.append(row);
  }
}

function renderRunHeader(state: RunConsoleState): void {
  const run = state.currentRun;
  runIdValue.textContent = run?.id ?? "—";
  statusBadge.textContent = run ? statusLabel(run.status) : "尚未创建";
  if (run) {
    statusBadge.dataset.status = run.status;
  } else {
    delete statusBadge.dataset.status;
  }
  cancelButton.hidden = run === undefined;
  cancelButton.disabled =
    run === undefined ||
    state.pending.cancelling ||
    isTerminalStatus(run.status) ||
    run.status === "cancelling";
}

const STREAM_LABELS: Record<RunConsoleState["stream"]["phase"], string> = {
  idle: "就绪",
  connecting: "连接中",
  live: "实时连接",
  reconnecting: "正在重连",
  closed: "已完成",
  failed: "恢复失败"
};

function renderStream(state: RunConsoleState): void {
  streamState.textContent = STREAM_LABELS[state.stream.phase];
  streamState.dataset.tone =
    state.stream.phase === "live"
      ? "positive"
      : state.stream.phase === "closed" || state.stream.phase === "idle"
        ? "idle"
        : state.stream.phase === "failed"
          ? "negative"
          : "warning";
}

function renderBudget(state: RunConsoleState): void {
  const budget = state.currentRun?.budget;
  budgetWarnings.replaceChildren();
  if (!budget) {
    budgetPanel.hidden = true;
    for (const target of [
      budgetModel,
      budgetTokens,
      budgetCost,
      budgetWallTime,
      budgetToolCalls,
      budgetModelRetries,
      budgetTeamCost
    ]) {
      target.textContent = "";
    }
    return;
  }
  const details = formatRunBudget(budget);
  budgetPanel.hidden = false;
  budgetPanel.dataset.tone = details.tone;
  budgetModel.textContent = details.model;
  budgetTokens.textContent = details.tokens;
  budgetCost.textContent = details.cost;
  budgetWallTime.textContent = details.wallTime;
  budgetToolCalls.textContent = details.toolCalls;
  budgetModelRetries.textContent = details.modelRetries;
  budgetTeamCost.textContent = details.teamCost;
  for (const warning of details.warnings) {
    const chip = document.createElement("span");
    chip.textContent = warning;
    budgetWarnings.append(chip);
  }
}

function renderApproval(state: RunConsoleState): void {
  const approval =
    state.currentRun?.status === "waiting_approval"
      ? state.currentRun.pendingApproval
      : undefined;
  if (!approval) {
    approvalCard.hidden = true;
    approvalEditPanel.hidden = true;
    return;
  }
  const details = formatApprovalDetails(approval);
  // Every policy/provider string enters the DOM through textContent only.
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
  const scopes = details.allowedScopes.map((option) => option.value);
  setValueIfChanged(
    approvalScope,
    scopes.includes(previousScope as never) ? previousScope : state.approvalScope
  );

  approvalCard.hidden = false;
  approveButton.disabled = state.pending.approval;
  rejectButton.disabled = state.pending.approval;
  approvalScope.disabled = state.pending.approval;

  const editable = formatEditableApproval(approval);
  if (editable) {
    approvalEditLabel.textContent = editable.label;
    approvalEditHelp.textContent = editable.help;
    // The controller keys the draft by approval id, so an SSE refresh cannot
    // clobber an in-progress edit for the same approval.
    if (state.approvalDraft?.approvalId === approval.id) {
      setValueIfChanged(approvalEditValue, state.approvalDraft.value);
    } else {
      setValueIfChanged(approvalEditValue, editable.value);
    }
    approvalEditPanel.hidden = false;
    approvalEditValue.disabled = state.pending.approval;
    editApproveButton.disabled = state.pending.approval;
  } else {
    approvalEditPanel.hidden = true;
  }
}

function renderUserRequest(state: RunConsoleState): void {
  const run = state.currentRun;
  const request = run?.status === "waiting_user" ? run.pendingUserRequest : undefined;
  const steeringAllowed = run !== undefined && canSteerRun(run.status);
  if (!request && !steeringAllowed) {
    userRequestCard.hidden = true;
    return;
  }
  // Model-authored questions stay inert even if they contain markup-like text.
  userRequestPrompt.textContent =
    request?.prompt ?? "可追加约束；Agent 会在下一个安全模型回合读取。";
  userResponse.placeholder = request
    ? "回答问题，或作为追加约束继续本次 Run。"
    : "例如：保持旧版错误结构，不要修改公开 API。";
  userRequestCard.hidden = false;
  setValueIfChanged(userResponse, state.userResponseDraft);
  userResponse.disabled = state.pending.userRequest;
  answerButton.hidden = !request;
  answerButton.disabled = state.pending.userRequest;
  steerButton.disabled = state.pending.userRequest;
}

function renderTimeline(state: RunConsoleState): void {
  if (state.timeline.length < renderedTimelineCount) {
    // A different Run was selected; the rendered list no longer applies.
    timeline.replaceChildren();
    renderedTimelineCount = 0;
  }
  for (let index = renderedTimelineCount; index < state.timeline.length; index += 1) {
    const event = state.timeline[index];
    if (!event) {
      continue;
    }
    const item = document.createElement("li");
    item.className = "timeline-item";
    // Event type drives fixed local styling; payload text never becomes markup.
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
  }
  renderedTimelineCount = state.timeline.length;
}

function renderVerification(state: RunConsoleState): void {
  const checks = state.currentRun?.verification?.checks ?? [];
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

function renderArtifacts(state: RunConsoleState): void {
  const artifacts = state.currentRun?.artifacts ?? [];
  artifactList.replaceChildren();
  if (artifacts.length === 0) {
    artifactList.append(emptyState("当前 Run 没有超限命令输出。"));
  }
  for (const artifact of artifacts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "artifact-item secondary-button";
    button.dataset.artifactId = artifact.id;
    button.textContent = `${artifact.kind === "command_stdout" ? "stdout" : "stderr"} · ${artifact.byteSize} bytes · ${artifact.contentHash.slice(0, 12)}`;
    artifactList.append(button);
  }
  artifactOutput.textContent = state.artifactText ?? "";
}

function renderChanges(state: RunConsoleState): void {
  const changes = state.changes;
  changedCount.textContent = `${changes?.changedFiles.length ?? 0} 个文件`;
  changesState.textContent = state.changesMessage;
  changedFiles.replaceChildren();
  for (const path of changes?.changedFiles ?? []) {
    const item = document.createElement("div");
    item.className = "changed-file";
    item.textContent = path;
    changedFiles.append(item);
  }
  diffOutput.textContent = changes?.unifiedDiff ?? "";
}

function renderResultAction(state: RunConsoleState): void {
  const run = state.currentRun;
  const available =
    run !== undefined &&
    canResolveRunResult(run.status) &&
    !state.discardedRunIds.includes(run.id);
  discardResultButton.hidden = !available;
  discardResultButton.disabled = !available || state.pending.resolving;
}

function historyButton(run: RunSummary, active: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "history-item";
  button.dataset.runId = run.id;
  button.dataset.active = String(active);
  const task = document.createElement("strong");
  task.textContent = run.task;
  const meta = document.createElement("span");
  meta.textContent = `${statusLabel(run.status)} · ${new Date(run.updatedAt).toLocaleString("zh-CN", { hour12: false })}`;
  button.append(task, meta);
  return button;
}

function emptyState(text: string): HTMLParagraphElement {
  const paragraph = document.createElement("p");
  paragraph.className = "empty-state";
  paragraph.textContent = text;
  return paragraph;
}

/**
 * Assigns a form value only when it actually changed.
 *
 * Re-rendering runs on every state change, and resetting `.value` on every
 * keystroke would move the caret to the end of the field.
 */
function setValueIfChanged(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
): void {
  if (element.value !== value) {
    element.value = value;
  }
}

function createSessionClient(accessToken: string | undefined): LeCodingClient {
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

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required Web element: ${selector}`);
  }
  return element;
}
