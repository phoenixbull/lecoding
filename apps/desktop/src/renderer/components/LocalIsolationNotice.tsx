import type { RunnerStatePush } from "../../shared/ipc-contract.js";

/** Props for the local isolation notice. */
export interface LocalIsolationNoticeProps {
  /** Runner state and sandbox capability projection pushed by Main. */
  runner: RunnerStatePush | undefined;
  /** True when the user dismissed the notice for this session. */
  dismissed: boolean;
  onDismiss(): void;
}

/**
 * Persistent notice that a local Run is not as confined as a server Run.
 *
 * This exists because the difference is invisible: a local Run produces the
 * same timeline, the same diffs and the same verification evidence as a server
 * Run, so without an explicit statement the user would reasonably assume the
 * same isolation behind it. The gaps are stated in words, not as a jargon
 * capability level, and the notice stays until dismissed because it applies to
 * every local Run, not just the first.
 */
export function LocalIsolationNotice({
  runner,
  dismissed,
  onDismiss
}: LocalIsolationNoticeProps) {
  const gaps = runner?.sandbox.isolationGaps ?? [];
  // Nothing to say when local execution is unavailable or already kernel-confined
  // with no gap to report; a permanently empty notice would just be noise.
  if (dismissed || gaps.length === 0 || runner?.state === "unavailable") {
    return null;
  }
  return (
    <div className="banner" data-tone="info" role="status" data-testid="local-isolation-notice">
      <div>
        <strong>本机执行与服务器隔离能力不同</strong>
        <p>
          本 Run 在你的电脑上执行。没有容器，因此服务器沙箱提供的以下保护在本机不生效：
        </p>
        <ul>
          {gaps.map((gap) => (
            <li key={gap}>{gap}</li>
          ))}
        </ul>
      </div>
      <button type="button" onClick={onDismiss} data-testid="local-isolation-dismiss">
        我知道了
      </button>
    </div>
  );
}
