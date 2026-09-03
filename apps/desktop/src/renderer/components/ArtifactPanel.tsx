import type { RunConsoleController, RunConsoleState } from "@lecoding/run-controller";

export interface ArtifactPanelProps {
  controller: RunConsoleController;
  state: RunConsoleState;
}

/**
 * Retained command output that exceeded the model context limit.
 *
 * Content is fetched per artifact on demand so a large output never enters the
 * event stream or the Renderer's memory until the operator asks for it.
 */
export function ArtifactPanel({ controller, state }: ArtifactPanelProps) {
  const artifacts = state.currentRun?.artifacts ?? [];
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Retained output</p>
          <h3>脱敏输出 Artifact</h3>
        </div>
      </div>
      {artifacts.length === 0 ? (
        <p className="empty-state">当前 Run 没有超限命令输出。</p>
      ) : (
        <div className="stack">
          <div className="changed-files">
            {artifacts.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                className="changed-file"
                disabled={state.pending.artifact}
                onClick={() => {
                  void controller.loadArtifact(artifact.id);
                }}
              >
                {artifact.kind === "command_stdout" ? "stdout" : "stderr"} ·{" "}
                {artifact.byteSize} bytes · {artifact.contentHash.slice(0, 12)}
              </button>
            ))}
          </div>
          <pre className="diff-output">{state.artifactText ?? ""}</pre>
        </div>
      )}
    </section>
  );
}
