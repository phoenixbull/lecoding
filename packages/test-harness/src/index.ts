import type {
  EnvironmentAction,
  EnvironmentHandle,
  EnvironmentReport,
  EnvironmentResult,
  EnvironmentSpec,
  RunEngine,
  RunId,
  RunResumer,
  VerificationOutcome,
  VerificationReport
} from "@lecoding/contracts";
import {
  createDefaultRunLeaseRetryPolicy,
  createInMemoryRunHandleRegistry,
  createInMemoryRunLease,
  createIntervalLeaseHeartbeat,
  createRunEngine,
  RunConflictError,
  type AgentModel,
  type AgentModelInput,
  type AgentModelTurn,
  type ApprovalLedger,
  type ArtifactStore,
  type Engine,
  type LeaseHeartbeat,
  type RetryPolicy,
  type RunStore,
  type ToolCallLedger,
  type ProjectPolicyRules,
  type RunTransitionWriter,
  type RunCancelBus
} from "@lecoding/run-engine";
import type { RunEnvironment } from "@lecoding/run-environment";
import { createPolicyEngine, type PolicyEngine } from "@lecoding/policy";
import {
  createInMemoryRunEventJournal,
  type RunEventJournal
} from "@lecoding/run-events";
import type { VerificationInput, Verifier } from "@lecoding/verifier";

export interface TestHarness {
  engine: Engine;
  /** Public event interface used by Web and future PC client tests. */
  events: RunEventJournal;
}

export async function createTestHarness(options: {
  verificationOutcome?: VerificationOutcome;
  expectedChangedFile?: string;
  expectNoChangedFiles?: boolean;
  modelError?: string;
  modelTurns?: AgentModelTurn[];
  /** 注入自定义模型适配器,用于构造受控时序;缺省时按 modelTurns 脚本回放。 */
  model?: AgentModel;
  /** 注入自定义执行环境适配器,用于构造受控时序;缺省时使用 FakeRunEnvironment。 */
  environment?: RunEnvironment;
  /** 注入自定义租约适配器;缺省时使用互斥行为的默认实现。 */
  lease?: import("@lecoding/contracts").RunLease;
  /** Worker 唯一标识,缺省 "worker-1",跨 Worker 测试时区分 owner。 */
  workerId?: string;
  /** 注入时钟:lease 续约使用;缺省时取当前 UTC 时间。 */
  now?: () => string;
  /** 自定义 lease 时长(毫秒);测试可缩短以触发过期路径。 */
  leaseMilliseconds?: number;
  /** 自定义 acquire 重试策略;缺省为 createDefaultRunLeaseRetryPolicy。 */
  retry?: RetryPolicy;
  /** 自定义长 await 心跳适配器;缺省为 createIntervalLeaseHeartbeat(lease)。 */
  heartbeat?: LeaseHeartbeat;
  /** 自定义 cancelBus;测试跨进程 cancel 时注入,缺省时为 undefined。 */
  cancelBus?: RunCancelBus;
  /** 自定义 verifier;缺省时按 verificationOutcome / expectedChangedFile 装配。 */
  verifier?: Verifier;
  /** 注入共享 RunStore;缺省时 harness 自带独立内存 store。 */
  store?: RunStore;
  /** 注入工具调用幂等账本;跨 Worker 测试可共享 PostgreSQL 实现。 */
  toolCalls?: ToolCallLedger;
  /** 注入审批审计账本；跨 Worker 测试可共享 PostgreSQL 实现。 */
  approvals?: ApprovalLedger;
  /** 注入项目级精确规则写入 seam。 */
  projectRules?: Pick<ProjectPolicyRules, "set">;
  /** Boundary used to verify large-output persistence behavior. */
  artifacts?: ArtifactStore;
  /** Deterministic output redactor used by security tests. */
  redactOutput?: (value: string) => string;
  /** 注入策略以验证 RunEngine 传递的规范化授权上下文。 */
  policy?: PolicyEngine;
  /** 注入状态 + 事件原子 writer;提供时替代 legacy 两步发布路径。 */
  transitions?: RunTransitionWriter;
}): Promise<TestHarness> {
  const store = options.store ?? new InMemoryRunStore();
  const environment = options.environment ?? new FakeRunEnvironment();
  const lease = options.lease ?? createInMemoryRunLease();
  const events = createInMemoryRunEventJournal({
    now: () => "2026-08-19T00:00:00.000Z"
  });
  const verifier =
    options.verifier ??
    (options.expectedChangedFile
      ? new RequiredFileVerifier(options.expectedChangedFile)
      : options.expectNoChangedFiles
        ? new UnchangedWorkspaceVerifier()
        : new FixedVerifier(options.verificationOutcome ?? "passed"));

  const engine = await createRunEngine({
    store,
    environment,
    model:
      options.model ??
      new FakeAgentModel(
        options.modelTurns ?? [
          { type: "completed", summary: "No tool call required" }
        ],
        options.modelError
      ),
    policy: options.policy ?? createPolicyEngine(),
    events,
    verifier,
    handles: createInMemoryRunHandleRegistry(),
    lease,
    ...(options.toolCalls !== undefined ? { toolCalls: options.toolCalls } : {}),
    ...(options.approvals !== undefined ? { approvals: options.approvals } : {}),
    ...(options.projectRules !== undefined
      ? { projectRules: options.projectRules }
      : {}),
    ...(options.artifacts !== undefined ? { artifacts: options.artifacts } : {}),
    ...(options.redactOutput !== undefined
      ? { redactOutput: options.redactOutput }
      : {}),
    ...(options.transitions !== undefined
      ? { transitions: options.transitions }
      : {}),
    heartbeat: options.heartbeat ?? createIntervalLeaseHeartbeat(lease),
    ...(options.cancelBus !== undefined ? { cancelBus: options.cancelBus } : {}),
    workerId: options.workerId ?? "worker-1",
    now: options.now ?? (() => new Date().toISOString()),
    ...(options.leaseMilliseconds !== undefined
      ? { leaseMilliseconds: options.leaseMilliseconds }
      : {}),
    ...(options.retry !== undefined ? { retry: options.retry } : {}),
    createId: () => "run-1"
  });

  return {
    engine,
    events
  };
}

/** 内存 store 实现,供跨 harness 共享同一持久化快照(用于多 Worker 接管测试)。 */
export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<RunId, Parameters<RunStore["save"]>[0]>();

  async save(run: Parameters<RunStore["save"]>[0]): Promise<number> {
    const existing = this.runs.get(run.id);
    // 乐观锁:版本不一致说明存在并发写入,拒绝覆盖
    if (existing && existing.version !== run.version) {
      throw new RunConflictError(run.id);
    }
    const version = run.version + 1;
    this.runs.set(run.id, structuredClone({ ...run, version }));
    return version;
  }

  async get(runId: RunId): ReturnType<RunStore["get"]> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }
}

class FakeRunEnvironment implements RunEnvironment {
  private readonly changedFiles: string[] = [];

  async prepare(spec: EnvironmentSpec): Promise<EnvironmentHandle> {
    return { id: `handle-${spec.runId}`, environmentId: spec.environmentId };
  }

  async perform(
    _handle: EnvironmentHandle,
    _action: EnvironmentAction
  ): Promise<EnvironmentResult> {
    this.changedFiles.push("src/generated.ts");
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async inspect(_handle: EnvironmentHandle): Promise<EnvironmentReport> {
    return { changedFiles: [...this.changedFiles] };
  }

  async dispose(
    _handle: EnvironmentHandle,
    _outcome: "keep" | "discard"
  ): Promise<void> {}
}

class FakeAgentModel implements AgentModel {
  private turnIndex = 0;

  constructor(
    private readonly turns: AgentModelTurn[],
    private readonly error?: string
  ) {}

  async next(_input: AgentModelInput): Promise<AgentModelTurn> {
    if (this.error) {
      throw new Error(this.error);
    }
    const turn = this.turns[this.turnIndex++];
    if (!turn) {
      throw new Error("FakeAgentModel has no programmed turn remaining");
    }
    return turn;
  }
}

class FixedVerifier implements Verifier {
  constructor(private readonly outcome: VerificationOutcome) {}

  async verify(_input: VerificationInput): Promise<VerificationReport> {
    return {
      outcome: this.outcome,
      checks: [
        {
          name: "configured verification",
          outcome: this.outcome,
          detail: "Controlled by the Phase 0 test harness"
        }
      ]
    };
  }
}

class RequiredFileVerifier implements Verifier {
  constructor(private readonly requiredFile: string) {}

  async verify(input: VerificationInput): Promise<VerificationReport> {
    const passed = input.environment.changedFiles.includes(this.requiredFile);
    return {
      outcome: passed ? "passed" : "failed",
      checks: [
        {
          name: "required file",
          outcome: passed ? "passed" : "failed",
          detail: this.requiredFile
        }
      ]
    };
  }
}

class UnchangedWorkspaceVerifier implements Verifier {
  async verify(input: VerificationInput): Promise<VerificationReport> {
    const passed = input.environment.changedFiles.length === 0;
    return {
      outcome: passed ? "passed" : "failed",
      checks: [
        {
          name: "unchanged workspace",
          outcome: passed ? "passed" : "failed",
          detail: passed ? "No files changed" : "Workspace contains changes"
        }
      ]
    };
  }
}

function createPolicyEnginePlaceholder() {
  // 占位,真正的 PolicyEngine 见 @lecoding/policy。
}
