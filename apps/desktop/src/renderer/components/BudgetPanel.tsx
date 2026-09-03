import { formatRunBudget } from "@lecoding/presentation";
import type { RunConsoleState } from "@lecoding/run-controller";

export interface BudgetPanelProps {
  state: RunConsoleState;
}

/** Quota monitor: usage against every hard limit, plus warning chips. */
export function BudgetPanel({ state }: BudgetPanelProps) {
  const budget = state.currentRun?.budget;
  if (!budget) {
    return null;
  }
  const details = formatRunBudget(budget);
  return (
    <section className="panel budget-panel" data-tone={details.tone}>
      <div className="panel-header">
        <div>
          <p className="eyebrow">Quota monitor</p>
          <h3>用量与硬限制</h3>
        </div>
        <span className="mono">{details.model}</span>
      </div>
      <dl className="budget-grid">
        <div>
          <dt>Token</dt>
          <dd>{details.tokens}</dd>
        </div>
        <div>
          <dt>Run 费用</dt>
          <dd>{details.cost}</dd>
        </div>
        <div>
          <dt>墙钟时间</dt>
          <dd>{details.wallTime}</dd>
        </div>
        <div>
          <dt>工具调用</dt>
          <dd>{details.toolCalls}</dd>
        </div>
        <div>
          <dt>模型重试</dt>
          <dd>{details.modelRetries}</dd>
        </div>
        <div>
          <dt>团队月预算</dt>
          <dd>{details.teamCost}</dd>
        </div>
      </dl>
      {details.warnings.length > 0 ? (
        <div className="budget-warnings">
          {details.warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
