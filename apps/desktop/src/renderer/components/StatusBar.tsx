import type { RunConsoleState } from "@lecoding/run-controller";

export interface StatusBarProps {
  state: RunConsoleState;
  appVersion: string;
  onDismissError: () => void;
}

const STREAM_LABELS: Record<RunConsoleState["stream"]["phase"], string> = {
  idle: "就绪",
  connecting: "连接中",
  live: "实时连接",
  reconnecting: "正在重连",
  closed: "已完成",
  failed: "恢复失败"
};

function streamTone(phase: RunConsoleState["stream"]["phase"]): string {
  if (phase === "live") {
    return "positive";
  }
  if (phase === "failed") {
    return "negative";
  }
  if (phase === "idle" || phase === "closed") {
    return "idle";
  }
  return "warning";
}

/** Bottom bar: stream health, the current error, and the build identity. */
export function StatusBar({
  state,
  appVersion,
  onDismissError
}: StatusBarProps) {
  return (
    <footer className="statusbar">
      <span className="stream-chip" data-tone={streamTone(state.stream.phase)}>
        {STREAM_LABELS[state.stream.phase]}
      </span>
      {state.error ? (
        <span className="stream-chip" data-tone="negative">
          {state.error}
          <button type="button" onClick={onDismissError} aria-label="关闭提示">
            ×
          </button>
        </span>
      ) : null}
      <span className="statusbar-spacer" />
      <span>{state.selectedProjectId ?? "未选择项目"}</span>
      <span className="mono">v{appVersion}</span>
    </footer>
  );
}
