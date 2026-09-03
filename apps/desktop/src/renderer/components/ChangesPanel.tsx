import { canResolveRunResult } from "@lecoding/presentation";
import type { RunConsoleController, RunConsoleState } from "@lecoding/run-controller";

export interface ChangesPanelProps {
  controller: RunConsoleController;
  state: RunConsoleState;
  onConfirmDiscard: () => boolean;
}

/**
 * Managed-worktree diff.
 *
 * The unified diff is rendered as plain text: it is untrusted repository
 * content and must never be interpreted as markup.
 */
export function ChangesPanel({
  controller,
  state,
  onConfirmDiscard
}: ChangesPanelProps) {
  const changes = state.changes;
  const run = state.currentRun;
  const canDiscard =
    run !== undefined &&
    canResolveRunResult(run.status) &&
    !state.discardedRunIds.includes(run.id) &&
    !state.pending.resolving;

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Workspace changes</p>
          <h3>代码变更</h3>
        </div>
        <div className="row-actions">
          <span className="status-badge">
            {changes?.changedFiles.length ?? 0} 个文件
          </span>
          {canDiscard ? (
            <button
              className="danger-button compact"
              type="button"
              onClick={() => {
                if (onConfirmDiscard()) {
                  void controller.resolveCurrentResult("discard");
                }
              }}
            >
              丢弃结果
            </button>
          ) : null}
        </div>
      </div>
      <p className="muted">{state.changesMessage}</p>
      <div className="stack">
        {changes && changes.changedFiles.length > 0 ? (
          <div className="changed-files">
            {changes.changedFiles.map((path) => (
              <div key={path} className="changed-file">
                {path}
              </div>
            ))}
          </div>
        ) : null}
        <pre className="diff-output">
          {changes?.unifiedDiff ?? "没有可展示的文本 Diff。"}
        </pre>
      </div>
    </section>
  );
}
