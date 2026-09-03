import type { DeviceSummary } from "./gateway.js";
import type {
  ApprovalMode,
  ApprovalScope,
  ControlPlaneConfig,
  ProjectId,
  ProjectPolicyRule,
  RunChanges,
  RunEventV1,
  RunId,
  RunSummary,
  RunView
} from "@lecoding/contracts";

/** Top-level console readiness. `needs_auth` and `offline` are both recoverable. */
export type ConsolePhase = "loading" | "needs_auth" | "offline" | "ready";

/** Live event-stream lifecycle for the currently selected Run. */
export type StreamPhase =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "closed"
  | "failed";

/** Backend currently holding the device credential, if the surface reports one. */
export type CredentialBackend = "safeStorage" | "encryptedFile";

/** Non-secret credential health mirrored from the desktop Main process. */
export interface CredentialState {
  backend: CredentialBackend;
  /** True when the OS keychain was unavailable and a weaker backend took over. */
  degraded: boolean;
  reason?: string;
  deviceId?: string;
  expiresAt?: string;
}

/** Unsubmitted Run composer values owned by the controller, not by the view. */
export interface ComposerDraft {
  task: string;
  /** Raw textarea text; split into criteria at create time. */
  acceptanceCriteria: string;
  environmentId: string;
  approvalMode: ApprovalMode;
}

/** Immutable controller snapshot consumed by Web DOM and Desktop React views. */
export interface RunConsoleState {
  phase: ConsolePhase;
  bootstrap?: ControlPlaneConfig;
  selectedProjectId?: ProjectId;
  /** False for viewers and for projects with no permitted approval mode. */
  canCreate: boolean;
  composer: ComposerDraft;
  recentRuns: RunSummary[];
  selectedRunId?: RunId;
  currentRun?: RunView;
  timeline: RunEventV1[];
  changes?: RunChanges;
  /** Explains why no diff is shown (cancelled, discarded, not ready yet). */
  changesMessage: string;
  artifactText?: string;
  stream: { phase: StreamPhase; runId?: RunId };
  pending: {
    creating: boolean;
    cancelling: boolean;
    resolving: boolean;
    approval: boolean;
    userRequest: boolean;
    artifact: boolean;
  };
  /**
   * Draft text for the pending approval's editable capability, keyed by
   * approval id so an SSE refresh never overwrites an in-progress edit.
   */
  approvalDraft?: { approvalId: string; value: string };
  /** Persistence boundary chosen for the next approval decision. */
  approvalScope: ApprovalScope;
  userResponseDraft: string;
  /** Runs whose result the user already discarded; their worktree is gone. */
  discardedRunIds: string[];
  policyRules: ProjectPolicyRule[];
  /** The rules endpoint 404s for non-admins; the surface hides it entirely. */
  policyRulesVisible: boolean;
  /** Devices bound to this installation, newest activity first. */
  devices: DeviceSummary[];
  /** One-time code awaiting exchange, shown verbatim on the binding screen. */
  deviceCode?: { code: string; expiresAt: string };
  binding: boolean;
  credential?: CredentialState;
  error?: string;
}

/** State a controller starts from before its first bootstrap succeeds. */
export function createInitialRunConsoleState(): RunConsoleState {
  return {
    phase: "loading",
    // A viewer cannot create Runs, so the composer starts disabled until the
    // bootstrap proves otherwise.
    canCreate: false,
    composer: {
      task: "",
      acceptanceCriteria: "",
      environmentId: "",
      approvalMode: "manual"
    },
    recentRuns: [],
    timeline: [],
    changesMessage: "选择 Run 后显示其受管工作区变更。",
    stream: { phase: "idle" },
    pending: {
      creating: false,
      cancelling: false,
      resolving: false,
      approval: false,
      userRequest: false,
      artifact: false
    },
    approvalScope: "once",
    userResponseDraft: "",
    discardedRunIds: [],
    policyRules: [],
    policyRulesVisible: false,
    devices: [],
    binding: false
  };
}
