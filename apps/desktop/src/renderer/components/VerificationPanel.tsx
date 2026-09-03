import { verificationTone } from "@lecoding/presentation";
import type { RunConsoleState } from "@lecoding/run-controller";

export interface VerificationPanelProps {
  state: RunConsoleState;
}

/** Verifier evidence for the selected Run. */
export function VerificationPanel({ state }: VerificationPanelProps) {
  const checks = state.currentRun?.verification?.checks ?? [];
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Verifier</p>
          <h3>验证证据</h3>
        </div>
        {state.currentRun?.verification ? (
          <span
            className="check-card"
            data-tone={verificationTone(state.currentRun.verification.outcome)}
            style={{ borderLeftWidth: 3 }}
          >
            {state.currentRun.verification.outcome}
          </span>
        ) : null}
      </div>
      {checks.length === 0 ? (
        <p className="empty-state">Run 进入验证阶段后，检查结果会显示在这里。</p>
      ) : (
        <div className="evidence-grid">
          {checks.map((check) => (
            <article
              key={check.name}
              className="check-card"
              data-tone={verificationTone(check.outcome)}
            >
              <div>
                <strong>{check.name}</strong>
                <span>{check.outcome}</span>
              </div>
              <p>{check.detail}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
