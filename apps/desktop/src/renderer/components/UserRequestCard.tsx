import { canSteerRun } from "@lecoding/presentation";
import type { RunConsoleController, RunConsoleState } from "@lecoding/run-controller";

export interface UserRequestCardProps {
  controller: RunConsoleController;
  state: RunConsoleState;
}

/** Answer an Agent question, or steer a Run that is still executing. */
export function UserRequestCard({ controller, state }: UserRequestCardProps) {
  const run = state.currentRun;
  const request =
    run?.status === "waiting_user" ? run.pendingUserRequest : undefined;
  const steeringAllowed = run !== undefined && canSteerRun(run.status);
  if (!request && !steeringAllowed) {
    return null;
  }
  const busy = state.pending.userRequest;
  const value = state.userResponseDraft;
  const tooLong = value.length > 4_000;
  const empty = value.trim() === "";

  return (
    <section className="user-request-card" aria-live="polite" aria-label="用户输入">
      <div>
        <p className="eyebrow">Agent conversation</p>
        <strong>
          {request?.prompt ?? "可追加约束；Agent 会在下一个安全模型回合读取。"}
        </strong>
      </div>
      <textarea
        aria-label="回答或追加指令"
        value={value}
        disabled={busy}
        maxLength={4_000}
        placeholder={
          request
            ? "回答问题，或作为追加约束继续本次 Run。"
            : "例如：保持旧版错误结构，不要修改公开 API。"
        }
        onChange={(event) => {
          controller.setUserResponseDraft(event.target.value);
        }}
      />
      <div className="approval-actions">
        <span className="muted">{value.length} / 4000</span>
        <button
          className="secondary-button"
          type="button"
          disabled={busy || empty || tooLong}
          onClick={() => {
            void controller.resolveUserRequest("steer");
          }}
        >
          作为追加指令
        </button>
        {request ? (
          <button
            className="primary-button"
            type="button"
            disabled={busy || empty || tooLong}
            onClick={() => {
              void controller.resolveUserRequest("answer");
            }}
          >
            回答并继续
          </button>
        ) : null}
      </div>
    </section>
  );
}
