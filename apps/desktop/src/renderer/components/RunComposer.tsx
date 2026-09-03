import type { ApprovalMode } from "@lecoding/contracts";
import { approvalModeOptions } from "@lecoding/presentation";
import type { RunConsoleController, RunConsoleState } from "@lecoding/run-controller";

/** Composer snapshot, role-bounded modes, and command owner used by the form. */
export interface RunComposerProps {
  controller: RunConsoleController;
  state: RunConsoleState;
  allowedModes: ApprovalMode[];
}

const MODE_HELP: Record<ApprovalMode, string> = {
  manual: "按能力规则请求批准，固定拒绝始终不可绕过。",
  auto_review: "独立风险审查器自动放行低风险操作，其余仍会请求批准。",
  full_access: "仅管理员可用；仍受工作区隔离、固定拒绝和硬限制约束。"
};

/**
 * Task composer.
 *
 * Every field is controlled by the controller's composer draft so switching
 * projects or re-rendering can never lose what the operator typed.
 */
export function RunComposer({
  controller,
  state,
  allowedModes
}: RunComposerProps) {
  const { composer, canCreate, pending } = state;
  const options = allowedModes.map((mode) => ({
    value: mode,
    label: approvalModeOptions("admin").find((option) => option.value === mode)?.label ?? mode
  }));
  const disabled = !canCreate || pending.creating;

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">New run</p>
          <h3>交给 Agent</h3>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void controller.createRun();
        }}
      >
        <div className="field">
          <label htmlFor="task-input">任务</label>
          <textarea
            id="task-input"
            value={composer.task}
            disabled={disabled}
            placeholder="例如：为 API 增加健康检查端点，并补齐测试。"
            onChange={(event) => {
              controller.setComposerDraft({ task: event.target.value });
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="criteria-input">验收条件</label>
          <textarea
            id="criteria-input"
            value={composer.acceptanceCriteria}
            disabled={disabled}
            placeholder={"每行一条，例如：\n测试全部通过\n类型检查通过"}
            onChange={(event) => {
              controller.setComposerDraft({
                acceptanceCriteria: event.target.value
              });
            }}
          />
          <small>每行一条；Verifier 必须为每条条件建立证据。</small>
        </div>
        <div className="field">
          <label htmlFor="environment-input">执行环境</label>
          <input
            id="environment-input"
            value={composer.environmentId}
            disabled={disabled}
            onChange={(event) => {
              controller.setComposerDraft({ environmentId: event.target.value });
            }}
          />
          <small>桌面端 Run 固定为 workspace-only 隔离范围。</small>
        </div>
        <div className="field">
          <label htmlFor="approval-mode-select">审批模式</label>
          <select
            id="approval-mode-select"
            value={composer.approvalMode}
            disabled={disabled || options.length === 0}
            onChange={(event) => {
              controller.setComposerDraft({
                approvalMode: event.target.value as ApprovalMode
              });
            }}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <small>{MODE_HELP[composer.approvalMode]}</small>
        </div>
        <button className="primary-button" type="submit" disabled={disabled}>
          {pending.creating ? "创建中…" : "创建并运行"}
        </button>
      </form>
    </section>
  );
}
