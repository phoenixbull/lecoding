import { statusLabel } from "@lecoding/presentation";
import type { RunConsoleController, RunConsoleState } from "@lecoding/run-controller";

export interface RunHistoryListProps {
  controller: RunConsoleController;
  state: RunConsoleState;
}

/** Recent Runs for the selected project, newest first. */
export function RunHistoryList({ controller, state }: RunHistoryListProps) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Recent runs</p>
          <h3>运行历史</h3>
        </div>
      </div>
      {state.recentRuns.length === 0 ? (
        <p className="empty-state">
          {state.phase === "loading" ? "正在加载最近 Run…" : "还没有 Run；创建后可在这里恢复。"}
        </p>
      ) : (
        <div className="history-list">
          {state.recentRuns.map((run) => (
            <button
              key={run.id}
              type="button"
              className="history-item"
              data-active={run.id === state.selectedRunId}
              onClick={() => {
                void controller.selectRun(run.id);
              }}
            >
              <strong>{run.task}</strong>
              <span>
                {statusLabel(run.status)} ·{" "}
                {new Date(run.updatedAt).toLocaleString("zh-CN", { hour12: false })}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
