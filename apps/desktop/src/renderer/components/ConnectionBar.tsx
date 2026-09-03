import type { RunConsoleState } from "@lecoding/run-controller";

export interface ConnectionBarProps {
  state: RunConsoleState;
  serverUrl: string;
}

/** Maps the console phase onto the fixed top-bar indicator tone. */
function toneFor(phase: RunConsoleState["phase"]): string {
  if (phase === "ready") {
    return "positive";
  }
  if (phase === "needs_auth") {
    return "negative";
  }
  return "warning";
}

function labelFor(phase: RunConsoleState["phase"]): string {
  switch (phase) {
    case "ready":
      return "已连接";
    case "needs_auth":
      return "需要认证";
    case "offline":
      return "控制面离线";
    default:
      return "连接中";
  }
}

/**
 * Always-visible connection identity.
 *
 * The operator must be able to answer "which server, which device, is my
 * credential protected?" without opening a settings screen.
 */
export function ConnectionBar({ state, serverUrl }: ConnectionBarProps) {
  const credential = state.credential;
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">L</div>
        <div className="brand-text">
          <strong>LeCoding</strong>
          <span>Run Console · Desktop</span>
        </div>
      </div>

      <div className="topbar-meta">
        <span className="status-dot" data-tone={toneFor(state.phase)} />
        <span>{labelFor(state.phase)}</span>
        {serverUrl ? <code title={serverUrl}>{serverUrl}</code> : null}
      </div>

      <div className="topbar-spacer" />

      <div className="topbar-meta">
        {credential ? (
          <span className="chip">
            {credential.backend === "safeStorage" ? "系统钥匙串" : "加密文件（降级）"}
          </span>
        ) : null}
        {credential?.deviceId ? (
          <span className="chip mono">{credential.deviceId}</span>
        ) : null}
      </div>
    </header>
  );
}
