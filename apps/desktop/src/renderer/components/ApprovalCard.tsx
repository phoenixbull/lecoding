import type { ApprovalScope } from "@lecoding/contracts";
import {
  formatApprovalDetails,
  formatEditableApproval
} from "@lecoding/presentation";
import type { RunConsoleController, RunConsoleState } from "@lecoding/run-controller";

/** Controller snapshot and commands required to resolve one pending approval. */
export interface ApprovalCardProps {
  controller: RunConsoleController;
  state: RunConsoleState;
}

const SCOPE_HELP: Record<ApprovalScope, string> = {
  once: "只对本次调用生效。",
  run: "本 Run 内相同能力不再询问。",
  project: "写入项目规则，长期生效；请仅在确认能力安全后选择。"
};

/**
 * Approval decision surface.
 *
 * This is the highest-consequence screen in the product, so it is rendered as
 * a distinct high-contrast card and the scope selector spells out how long the
 * decision will keep applying.
 */
export function ApprovalCard({ controller, state }: ApprovalCardProps) {
  const run = state.currentRun;
  const approval =
    run?.status === "waiting_approval" ? run.pendingApproval : undefined;
  if (!approval) {
    return null;
  }
  const details = formatApprovalDetails(approval);
  const editable = formatEditableApproval(approval);
  const draft =
    state.approvalDraft?.approvalId === approval.id
      ? state.approvalDraft.value
      : (editable?.value ?? "");
  const busy = state.pending.approval;

  return (
    <section
      className="approval-card"
      aria-live="polite"
      aria-label="审批请求"
      data-testid="approval-card"
    >
      <div>
        <p className="eyebrow">Approval required</p>
        <h3>Agent 请求执行一项受控操作</h3>
        <div className="approval-metadata">
          <span className="chip">{details.capability}</span>
          <span className="chip">{details.risk}</span>
        </div>
        <p className="mono">{details.target}</p>
        <p className="approval-reason">{details.reason}</p>
      </div>

      <div className="approval-actions">
        <label htmlFor="approval-scope-select">作用范围</label>
        <select
          id="approval-scope-select"
          value={state.approvalScope}
          disabled={busy}
          onChange={(event) => {
            controller.setApprovalScope(event.target.value as ApprovalScope);
          }}
        >
          {details.allowedScopes.map((scope) => (
            <option key={scope.value} value={scope.value}>
              {scope.label}
            </option>
          ))}
        </select>
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={() => {
            void controller.resolveCurrentApproval("reject");
          }}
        >
          拒绝
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={busy}
          onClick={() => {
            void controller.resolveCurrentApproval("approve");
          }}
        >
          批准
        </button>
      </div>
      <p className="muted">{SCOPE_HELP[state.approvalScope]}</p>

      {editable ? (
        <div className="approval-edit-panel">
          <label htmlFor="approval-edit-input">{editable.label}</label>
          <textarea
            id="approval-edit-input"
            value={draft}
            disabled={busy}
            onChange={(event) => {
              controller.setApprovalDraft(event.target.value);
            }}
          />
          <small>{editable.help}</small>
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => {
              void controller.editAndApproveCurrent();
            }}
          >
            修改后仅允许一次
          </button>
        </div>
      ) : null}
    </section>
  );
}
