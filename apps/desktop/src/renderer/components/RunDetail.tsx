import { canResolveRunResult, isTerminalStatus, statusLabel } from "@lecoding/presentation";
import type { RunConsoleController, RunConsoleState } from "@lecoding/run-controller";

/** Selected Run commands plus confirmation required before discarding results. */
export interface RunDetailProps {
  controller: RunConsoleController;
  state: RunConsoleState;
  onConfirmDiscard: () => boolean;
}

/** Run header: identity, status, cancellation, and result disposition. */
export function RunDetail({
  controller,
  state,
  onConfirmDiscard
}: RunDetailProps) {
  const run = state.currentRun;
  const canCancel =
    run !== undefined &&
    !isTerminalStatus(run.status) &&
    run.status !== "cancelling" &&
    !state.pending.cancelling;
  const canDispose =
    run !== undefined &&
    canResolveRunResult(run.status) &&
    !state.discardedRunIds.includes(run.id) &&
    !state.pending.resolving;

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Live run</p>
          <h2>执行概览</h2>
        </div>
        <div className="row-actions">
          <span
            className="status-badge"
            data-status={run?.status}
            aria-live="polite"
          >
            {run ? statusLabel(run.status) : "尚未创建"}
          </span>
          <span className="stream-chip mono">{run?.id ?? "—"}</span>
          {run ? (
            <button
              className="danger-button compact"
              type="button"
              disabled={!canCancel}
              onClick={() => {
                void controller.cancelCurrentRun();
              }}
            >
              取消 Run
            </button>
          ) : null}
          {canDispose ? (
            <button
              className="danger-button compact"
              type="button"
              onClick={() => {
                // Discarding a worktree cannot be undone, so the view forces
                // an explicit confirmation before the controller is called.
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
      {run ? (
        <p className="muted">{run.task}</p>
      ) : (
        <p className="muted">创建或选择一个 Run 后，这里显示它的状态与证据。</p>
      )}
      {run?.failure ? (
        <div className="banner" data-tone="negative" role="alert">
          <span>
            {run.failure.message}（{run.failure.code}）
          </span>
        </div>
      ) : null}
    </section>
  );
}
