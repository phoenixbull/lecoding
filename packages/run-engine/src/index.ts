import type {
  EnvironmentHandle,
  EnvironmentResult,
  LeaseHeartbeat,
  PendingApproval,
  PendingUserRequest,
  RetryPolicy,
  RunCommand,
  RunEngine,
  RunFailure,
  RunId,
  RunLease,
  RunLeaseAcquire,
  RunLeaseRelease,
  RunLeaseRenew,
  RunLeaseToken,
  RunResumer,
  RunSummary,
  RunStatus,
  RunView,
  StartRun,
  VerificationReport
} from "@lecoding/contracts";
import type { PolicyEngine } from "@lecoding/policy";
import type { RunEnvironment } from "@lecoding/run-environment";
import type { RunEventJournal } from "@lecoding/run-events";
import type { Verifier } from "@lecoding/verifier";
import {
  createInMemoryToolCallLedger,
  type ToolCallLedger
} from "./postgres-tool-call-ledger.js";
import type {
  PersistRunEvent,
  RunTransitionWriter
} from "./postgres-run-transition.js";
import {
  createInMemoryRunSteerMailbox,
  type RunSteerMailbox,
  type RunSteerMessage
} from "./run-steer-mailbox.js";

export type { RetryPolicy, LeaseHeartbeat } from "@lecoding/contracts";
export {
  createPostgresRunStore,
  RUN_STORE_SCHEMA_SQL
} from "./postgres-run-store.js";
export { createPostgresRunTransitionWriter } from "./postgres-run-transition.js";
export type {
  PersistRunEvent,
  PostgresRunTransitionWriterOptions,
  RunTransitionWriter
} from "./postgres-run-transition.js";
export {
  createInMemoryToolCallLedger,
  createPostgresToolCallLedger,
  TOOL_CALL_LEDGER_SCHEMA_SQL
} from "./postgres-tool-call-ledger.js";
export {
  createInMemoryRunSteerMailbox,
  createPostgresRunSteerMailbox,
  RUN_STEER_MAILBOX_SCHEMA_SQL
} from "./run-steer-mailbox.js";
export type {
  EnqueueRunSteer,
  EnqueueRunSteerResult,
  RunSteerMailbox,
  RunSteerMessage
} from "./run-steer-mailbox.js";
export type {
  ToolCallClaim,
  ToolCallClaimInput,
  ToolCallCompleteInput,
  ToolCallLedger
} from "./postgres-tool-call-ledger.js";

/** Worker 进程内的句柄注册表:handle 是运行时资源,不允许进入持久化快照。 */
interface RegisteredHandle {
  handle: EnvironmentHandle;
  environmentId: RunView["environmentId"];
  /**
   * 取消信号源:perform 期间持有,abort() 时通知适配器立即中断副作用。
   * 可选——FakeEnvironment / InMemory 测试实现可不提供;
   * DockerRunEnvironment 等真实实现必须设置以便 cancel 命令生效。
   */
  abort?: AbortController;
}

export interface RunHandleRegistry {
  register(runId: RunId, handle: RegisteredHandle): void;
  release(runId: RunId): RegisteredHandle | undefined;
  /** 取出后再用完归还的临时借用,失败归还以保证下一次 resume 不丢失资源。 */
  borrow(runId: RunId): RegisteredHandle | undefined;
  restore(runId: RunId, entry: RegisteredHandle): void;
  /**
   * 取消进行中的副作用:对持有 AbortController 的 handle 调 abort()。
   * 没有 AbortController 的 handle 是 no-op(兼容 Fake 环境)。
   * 返回触发次数:0/1——便于测试断言。
   */
  abort(runId: RunId): number;
}

interface StoredRun {
  id: RunId;
  input: StartRun;
  status: RunStatus;
  /** 乐观并发令牌:由 save 返回的新版本回填,并发写以版本冲突拒绝。 */
  version: number;
  toolResults: ModelToolResult[];
  pendingApproval?: PendingApproval;
  pendingUserRequest?: PendingUserRequest & { continuationId?: string };
  /** Last mailbox position staged into this durable Run snapshot. */
  steeringCursor?: number;
  /** Messages staged for the next provider call and retained across Worker failure. */
  pendingSteering?: RunSteerMessage[];
  /** Durable receipts let uncertain user-command retries succeed after state advances. */
  userCommandReceipts?: Record<string, UserCommandReceipt>;
  /** Durable markers prevent duplicate tool-start events when another Worker takes over. */
  startedToolCallIds?: string[];
  pendingToolCall?: Extract<AgentModelTurn, { type: "tool_call" }>;
  failure?: RunFailure;
  verification?: VerificationReport;
}
export type { StoredRun };

interface UserCommandReceipt {
  type: "answer" | "steer";
  requestId: string;
  value: string;
}

/**
 * 乐观并发冲突:调用方持有的 Run 快照版本已落后于持久化版本。
 * 调用方必须重新读取状态并基于最新版本决策,禁止盲目覆盖。
 */
export class RunConflictError extends Error {
  constructor(runId: RunId) {
    super(`Run state was modified concurrently: ${runId}`);
    this.name = "RunConflictError";
  }
}

/**
 * 租约丢失:持有 token 的调用方在写入前发现租约已被抢占或过期。
 * 一切后续持久化写入必须放弃,由新 owner 接管;
 * 与 RunConflictError 一样属于预期并发事件,不得记为 Run 自身失败。
 */
export class LeaseLostError extends Error {
  constructor(runId: RunId) {
    super(`Run lease was lost before write: ${runId}`);
    this.name = "LeaseLostError";
  }
}

export { InMemoryRunCancelBus } from "./run-cancel-bus.js";
export type { RunCancelBus } from "./run-cancel-bus.js";
export { createPostgresRunCancelBus } from "./postgres-run-cancel-bus.js";
export type { PostgresNotifiable } from "./postgres-run-cancel-bus.js";
export { wrapPgClient } from "./pg-client-adapter.js";
export type { PgClientLike } from "./pg-client-adapter.js";

/**
 * 因 AbortSignal 触发而 reject 的 perform 错误:
 * RunEngine 收到此 error 后必须走 cancelled 终态(而非 environment_offline),
 * 区分真实 I/O 失败(OOM / daemon unreachable / 网络异常)与用户主动取消。
 * 与 LeaseLostError / RunConflictError 同性质:预期事件,不算 Run 失败。
 */
export class RunCancelledByAbortError extends Error {
  readonly cause?: unknown;
  constructor(runId: RunId, cause?: unknown) {
    super(`Run perform aborted by cancel: ${runId}`);
    this.name = "RunCancelledByAbortError";
    this.cause = cause;
  }
}

export interface RunStore {
  /**
   * 条件保存:仅当 run.version 与已持久化版本一致时写入。
   * 成功时持久化 version + 1 并返回新版本;版本不一致时抛出
   * RunConflictError,由调用方决定是否重新读取后重试。
   */
  save(run: StoredRun): Promise<number>;
  get(runId: RunId): Promise<StoredRun | undefined>;
}

/** Read-only projection for bounded newest-first project Run history. */
export interface RunHistory {
  list(projectId: string, limit: number): Promise<RunSummary[]>;
}

export interface RunEngineDependencies {
  store: RunStore;
  environment: RunEnvironment;
  model: AgentModel;
  policy: PolicyEngine;
  events: Pick<RunEventJournal, "publish">;
  verifier: Verifier;
  /** 进程内句柄注册表,handle 由 resume 写入、dispose 移除,绝不进 RunStore。 */
  handles: RunHandleRegistry;
  /** 跨 Worker 互斥租约:resume 期间持有 lease,过期或被抢走即停止驱动。 */
  lease: RunLease;
  /**
   * 工具副作用的 callId 幂等账本。生产必须注入 PostgreSQL 实现;
   * 缺省内存实现仅供单进程开发和既有接口测试。
   */
  toolCalls?: ToolCallLedger;
  /** 原子保存 Run 状态和 RunEvent/outbox;生产 PostgreSQL 组合必须注入。 */
  transitions?: RunTransitionWriter;
  /** Cross-Worker mailbox that accepts steer without contending for the driver lease. */
  steerMailbox?: RunSteerMailbox;
  /**
   * 长 await 心跳守护器:prepare 等真实 I/O 期间按 leaseMilliseconds/2 间隔
   * 持续 renewLease。缺省为 setInterval 实现(详见 createIntervalLeaseHeartbeat)。
   */
  heartbeat: LeaseHeartbeat;
  /**
   * 跨进程 cancel 信号总线:Worker 进程启动时自动 subscribe,
   * 收到 runId 时调本地 handles.abort(runId) 触发 AbortSignal。
   * 可选——未提供时 cancel 命令仅对同进程的 perform 生效(legacy 行为)。
   * 生产配置应注入 PostgresRunCancelBus 以支持跨进程 cancel。
   */
  cancelBus?: import("./run-cancel-bus.js").RunCancelBus;
  /** Worker 唯一标识:lease 持有方需要这个来申请/续约/释放。 */
  workerId: string;
  /** 注入时钟:resume 时给 lease 一个明确的过期时间,可被测试驱动。 */
  now(): string;
  /** 单次 lease 有效期毫秒数,默认 30 秒;测试可缩短以便快进。 */
  leaseMilliseconds?: number;
  /**
   * acquire 重试策略:lease 被其他 Worker 持有时按策略等待再尝试。
   * 缺省为 5 秒封顶指数退避(详见 createDefaultRunLeaseRetryPolicy)。
   * command 路径不重试:用户取消/批准应当立即决定权归属。
   */
  retry?: RetryPolicy;
  createId(): RunId;
}

export interface AgentModelInput {
  runId: RunId;
  run: StartRun;
  toolResults: ModelToolResult[];
  /** User instructions appended after Run creation and delivered at the next safe turn. */
  steeringMessages?: string[];
}

export type AgentModelTurn =
  | {
      type: "tool_call";
      callId: string;
      /** Provider continuation persisted with the tool result for the next model turn. */
      continuationId?: string;
      tool: "execute_command";
      arguments: { argv: string[] };
    }
  | {
      type: "user_request";
      requestId: string;
      continuationId?: string;
      prompt: string;
    }
  | { type: "completed"; summary: string };

export type ModelToolResult =
  | {
      callId: string;
      /** Provider response that issued this call; required for durable API continuation. */
      continuationId?: string;
      status: "executed";
      exitCode: number;
      stdout: string;
      stderr: string;
    }
  | {
      callId: string;
      continuationId?: string;
      status: "denied";
      reason: string;
    }
  | {
      callId: string;
      continuationId?: string;
      status: "answered";
      value: string;
    };

export interface AgentModel {
  next(input: AgentModelInput): Promise<AgentModelTurn>;
}

/**
 * 扩展 RunEngine + RunResumer,加入 worker 生命周期终结点。
 *
 * dispose() 在 worker 关闭时调用:
 * - 取消 cancelBus 订阅,断开 LISTEN 连接(避免 PG listen 客户端泄漏)
 * - 幂等,多次调用安全
 *
 * 没有 cancelBus 时 dispose 是 no-op。
 */
export interface DisposableEngine {
  dispose(): Promise<void>;
}

export type Engine = RunEngine & RunResumer & DisposableEngine;

export async function createRunEngine(
  dependencies: RunEngineDependencies
): Promise<Engine> {
  const engine = new DefaultRunEngine(dependencies);
  await engine.init();
  return engine;
}

class DefaultRunEngine implements RunEngine, RunResumer, DisposableEngine {
  private cancelSubscriptionStop: (() => void | Promise<void>) | undefined;
  private readonly toolCalls: ToolCallLedger;
  private readonly steerMailbox: RunSteerMailbox;

  constructor(private readonly dependencies: RunEngineDependencies) {
    /*
     * 字段在 init() 里赋值——构造期不再 fire-and-forget subscribe,
     * 由 init() 显式 await,确保 createRunEngine 返回的 Promise
     * resolve 后订阅一定生效,worker 可以立即 publish。
     */
    this.toolCalls = dependencies.toolCalls ?? createInMemoryToolCallLedger();
    this.steerMailbox =
      dependencies.steerMailbox ??
      createInMemoryRunSteerMailbox({ events: dependencies.events });
  }

  /*
   * 启动期钩子:订阅 cancelBus。
   *
   * 由 createRunEngine 工厂 await,保证 subscribe 完成才返回——避免
   * "调用方拿到 engine 后立即 publish 时订阅尚未就绪"的 race。
   *
   * cancelBus 缺失时此方法立即 resolve(legacy 兼容)。
   */
  async init(): Promise<void> {
    if (this.dependencies.cancelBus === undefined) {
      return;
    }
    /*
     * subscribe 返回 Promise<() => void> 的 stop 函数;
     * 缓存起来供 dispose() 真正取消订阅——旧实现调一个空闭包,
     * 长时间运行 worker 池会累积 zombie LISTEN 连接。
     */
    this.cancelSubscriptionStop = await this.dependencies.cancelBus.subscribe(
      (runId) => {
        this.dependencies.handles.abort(runId);
      }
    );
  }

  async dispose(): Promise<void> {
    /*
     * 幂等 dispose:即使 cancelSubscriptionStop 未赋值(无 cancelBus 路径)
     * 或被多次调用,也安全——空闭包是 no-op。
     */
    const stop = this.cancelSubscriptionStop;
    this.cancelSubscriptionStop = undefined;
    // Await PostgreSQL UNLISTEN before the Worker closes its dedicated client.
    await stop?.();
  }

  async start(input: StartRun): Promise<RunId> {
    /*
     * 入队语义:start 仅持久化 Run 到 queued 并发事件,立即返回。
     * 环境准备与模型驱动由 Worker 侧 resume() 推进,与 HTTP 请求生命周期解耦,
     * 浏览器断线和进程重启都不会丢失 Run。
     */
    const id = this.dependencies.createId();
    const stored: StoredRun = {
      id,
      input,
      status: "queued",
      version: 0,
      toolResults: []
    };
    await this.transition(stored, "queued");
    return id;
  }

  async resume(runId: RunId): Promise<void> {
    /*
     * 跨 Worker 互斥:整段 resume 必须持 lease 才能推进。
     * acquire 按 retry 策略等待;返回 undefined 表示预算耗尽仍被持有,
     * 本轮静默返回(可由下次 resume 重新发起)。
     */
    const token = await this.acquireLease(runId, this.dependencies.retry);
    if (!token) {
      return;
    }
    try {
      const stored = await this.requireRun(runId);
      /*
       * 幂等闸门:仅在可驱动状态下推进。非可驱动状态(终态/未排队/已注册句柄)
       * 直接返回,允许调度器无副作用地轮询,且不破坏现有终态。
       */
      if (!isDriverStartable(stored.status)) {
        return;
      }
      // Durable waits must remain paused across Worker replacement until a command resolves them.
      if (stored.status === "waiting_approval" || stored.status === "waiting_user") {
        return;
      }
      const borrowed = this.dependencies.handles.borrow(runId);
      if (borrowed) {
        // 已由本次或历史 Worker 注册过句柄,直接进入运行
        this.dependencies.handles.restore(runId, borrowed);
      } else {
        try {
          await this.prepareAndRun(stored, token);
        } catch (error) {
          /*
           * prepare 抛错联动:镜像拉取失败、workspace 不可达等环境准备错误
           * 必须自动转 environment_offline,与 perform 抛错保持一致。
           * 失租/冲突属预期并发事件,继续由外层 catch 静默处理。
           */
          if (
            error instanceof LeaseLostError ||
            error instanceof RunConflictError
          ) {
            return;
          }
          await this.handlePrepareFailure(stored, token);
          return;
        }
      }

      if (isDriverStartable(stored.status)) {
        try {
          await this.drive(stored, token);
        } catch (error) {
          /*
           * 版本冲突=并发命令已写终态;失租=新 owner 已接管。
           * 两者都是预期并发事件,不是 Run 自身失败,不得记为 agent_loop_failed。
           */
          if (
            error instanceof RunConflictError ||
            error instanceof LeaseLostError
          ) {
            return;
          }
          await this.recordAgentLoopFailure(stored, error, token);
        }
      }
    } catch (error) {
      // prepareAndRun 等外层路径失租同样静默放弃驱动权;其余错误照常上抛
      if (!(error instanceof LeaseLostError)) {
        throw error;
      }
    } finally {
      // 透传 token 中的 generation:内存实现忽略,PG 实现做乐观锁校验。
      // ownerId 与 workerId 等价,但从 token 取更完整——包含世代号。
      await this.dependencies.lease.release({
        runId: token.runId,
        ownerId: token.ownerId,
        ...(token.generation !== undefined ? { generation: token.generation } : {})
      });
    }
  }

  async recoverEnvironment(runId: RunId): Promise<void> {
    /*
     * Worker 内部故障自检入口:不经用户 command 接口独立获取租约,
     * 复用 recover_environment 的既有恢复逻辑(状态迁移 + dispose + 释放句柄)。
     * 其他 Worker 持有有效租约时静默返回--该 Worker 正在驱动,
     * 环境故障会在其自身的驱动边界暴露。
     */
    const token = await this.acquireLease(runId, undefined);
    if (!token) {
      return;
    }
    try {
      const stored = await this.requireRun(runId);
      await this.runCommandWithToken(
        stored,
        {
          type: "recover_environment",
          reason: "worker environment self-check failed"
        },
        token
      );
    } finally {
      await this.dependencies.lease.release({
        runId: token.runId,
        ownerId: token.ownerId,
        ...(token.generation !== undefined ? { generation: token.generation } : {})
      });
    }
  }

  async command(runId: RunId, command: RunCommand): Promise<void> {
    if (command.type === "steer" || command.type === "answer") {
      const current = await this.requireRun(runId);
      validateSteeringCommandId(command.commandId);
      const value = command.type === "answer" ? command.value : command.message;
      validateSteeringMessage(value);
      const receipt = current.userCommandReceipts?.[command.commandId];
      if (receipt) {
        assertMatchingUserCommandReceipt(receipt, command);
        return;
      }
      if (command.type === "steer" && current.status !== "waiting_user") {
        if (!isLiveSteerableStatus(current.status)) {
          const existing = await this.steerMailbox.getByCommandId(
            runId,
            command.commandId
          );
          if (existing) {
            if (existing.message !== command.message) {
              throw new Error(
                "Steering commandId was reused with a different message"
              );
            }
            return;
          }
          throw new Error(`Run cannot accept steering in status: ${current.status}`);
        }
        // Enqueue bypasses the active driver's lease; consumption happens only at
        // a subsequent model boundary and never interrupts an in-flight tool action.
        await this.steerMailbox.enqueue({
          runId,
          commandId: command.commandId,
          message: command.message
        });
        return;
      }
    }
    /*
     * 命令也要求 lease:防止用户取消/批准落入其他 Worker 正在驱动的循环,
     * 与已存在的乐观版本共同把并发写收敛到唯一 owner。
     * 拒批/取消路径必须拿 lease 后才能写终态。
     */
    const token = await this.acquireLease(runId, undefined);
    if (!token) {
      throw new Error(`Run lease held by another worker: ${runId}`);
    }
    try {
      const stored = await this.requireRun(runId);
      await this.runCommandWithToken(stored, command, token);
    } finally {
      await this.dependencies.lease.release({
        runId: token.runId,
        ownerId: token.ownerId,
        ...(token.generation !== undefined ? { generation: token.generation } : {})
      });
    }
  }

  private async runCommandWithToken(
    stored: StoredRun,
    command: RunCommand,
    token: RunLeaseToken
  ): Promise<void> {
    if (command.type === "recover_environment") {
      /*
       * 终态防复活闸门:恢复只对仍可驱动的 Run 有意义。
       * 已终态(succeeded/failed/cancelled)的 Run 不允许被拉回
       * environment_offline 重新驱动;cancelling/verifying 期间状态所有权
       * 在取消/校验流程手中,恢复同样无效。一律静默 no-op。
       */
      if (!isDriverStartable(stored.status)) {
        return;
      }
      /*
       * Worker 主动放弃当前环境:仅在已注册句柄的运行态下有效。
       * 状态先于持久化写入,避免 dispose 失败留下半挂句柄。
       * 后续 resume() 检测 environment_offline 会重新 prepare。
       */
      const borrowed = this.dependencies.handles.borrow(stored.id);
      if (borrowed) {
        await this.transition(stored, "environment_offline", token);
        try {
          await this.dependencies.environment.dispose(
            borrowed.handle,
            "discard"
          );
        } finally {
          this.dependencies.handles.release(stored.id);
        }
      } else {
        await this.transition(stored, "environment_offline", token);
      }
      return;
    }
    if (command.type === "cancel") {
      // cancel 立即通知适配器中断进行中的副作用:abort 优先于
      // transition("cancelling") 以最小化 cancel 命令到 perform 终止的窗口。
      // 没有 AbortController 的 handle(Fake 环境)是 no-op。
      this.dependencies.handles.abort(stored.id);
      /*
       * 跨进程 cancel 信号:publish 让持有该 runId 的其他 worker 进程
       * 也立即中断 perform。在 cancelBus 缺失时跳过(legacy 行为)。
       */
      if (this.dependencies.cancelBus !== undefined) {
        await this.dependencies.cancelBus.publish(stored.id);
      }
      await this.transition(stored, "cancelling", token);
      const borrowed = this.dependencies.handles.borrow(stored.id);
      if (borrowed) {
        try {
          await this.dependencies.environment.dispose(borrowed.handle, "discard");
        } finally {
          this.dependencies.handles.release(stored.id);
        }
      }
      delete stored.pendingApproval;
      delete stored.pendingToolCall;
      delete stored.pendingUserRequest;
      // dispose 期间租约可能被抢占,终态写入前由 token 校验兜底
      await this.transition(stored, "cancelled", token);
      return;
    }
    if (command.type === "steer" || command.type === "answer") {
      const existingReceipt = stored.userCommandReceipts?.[command.commandId];
      if (existingReceipt) {
        assertMatchingUserCommandReceipt(existingReceipt, command);
        return;
      }
      const request = stored.pendingUserRequest;
      if (
        stored.status !== "waiting_user" ||
        !request ||
        (command.type === "answer" && request.id !== command.requestId)
      ) {
        throw new Error("Run is not waiting for matching user input");
      }
      const value = command.type === "answer" ? command.value : command.message;
      validateSteeringMessage(value);
      validateSteeringCommandId(command.commandId);
      if (Object.keys(stored.userCommandReceipts ?? {}).length >= 100) {
        throw new Error("Run user-command receipt limit exceeded");
      }
      stored.toolResults.push({
        callId: request.id,
        ...(request.continuationId
          ? { continuationId: request.continuationId }
          : {}),
        status: "answered",
        value
      });
      delete stored.pendingUserRequest;
      stored.userCommandReceipts = {
        ...(stored.userCommandReceipts ?? {}),
        [command.commandId]: {
          type: command.type,
          requestId: request.id,
          value
        }
      };
      const messageId = `${command.type}:${command.commandId}`;
      const conversationEvents: PersistRunEvent[] = [
        {
          type: "user_message_submitted",
          data: {
            messageId,
            commandId: command.commandId,
            mode: command.type,
            message: value
          }
        },
        {
          type: "user_message_delivered",
          data: { messageIds: [messageId] }
        }
      ];
      const borrowed = this.dependencies.handles.borrow(stored.id);
      if (borrowed) {
        this.dependencies.handles.restore(stored.id, borrowed);
        stored.status = "running";
        await this.persistEvents(
          stored,
          [
            { type: "status_changed", data: { status: "running" } },
            ...conversationEvents
          ],
          token
        );
      } else {
        // A replacement Worker recreates the environment only after input arrives.
        stored.status = "preparing";
        await this.persistEvents(
          stored,
          [
            { type: "status_changed", data: { status: "preparing" } },
            ...conversationEvents
          ],
          token
        );
        await this.prepareAndRun(stored, token, true);
      }
      await this.drive(stored, token);
      return;
    }
    if (
      stored.status !== "waiting_approval" ||
      stored.pendingApproval?.id !== command.approvalId ||
      !stored.pendingToolCall
    ) {
      throw new Error(`Approval is not pending: ${command.approvalId}`);
    }

    const toolCall = stored.pendingToolCall;
    delete stored.pendingApproval;
    await this.transition(stored, "running", token);

    const borrowed = this.dependencies.handles.borrow(stored.id);
    if (!borrowed) {
      throw new Error(`Run environment is not prepared: ${stored.id}`);
    }
    try {
      if (command.type === "reject") {
        stored.toolResults.push({
          callId: toolCall.callId,
          ...(toolCall.continuationId
            ? { continuationId: toolCall.continuationId }
            : {}),
          status: "denied",
          reason: "User rejected the tool call"
        });
        // The denied result is now the durable continuation; the pending call is consumed.
        delete stored.pendingToolCall;
        await this.persistEvents(
          stored,
          [
            {
              type: "tool_completed",
              data: { callId: toolCall.callId, outcome: "denied" }
            }
          ],
          token
        );
      } else {
        await this.performWith(stored, toolCall, borrowed, token);
      }
    } finally {
      this.dependencies.handles.restore(stored.id, borrowed);
    }

    if (isDriverStartable(stored.status)) {
      try {
        await this.drive(stored, token);
      } catch (error) {
        // 与 resume 相同:冲突/失租都是预期并发事件,不记为 Run 失败
        if (
          error instanceof RunConflictError ||
          error instanceof LeaseLostError
        ) {
          return;
        }
        await this.recordAgentLoopFailure(stored, error, token);
      }
    }
  }

  async inspect(runId: RunId): Promise<RunView> {
    const run = await this.requireRun(runId);

    return {
      id: run.id,
      projectId: run.input.projectId,
      environmentId: run.input.environmentId,
      task: run.input.task,
      status: run.status,
      ...(run.pendingApproval
        ? { pendingApproval: run.pendingApproval }
        : {}),
      ...(run.pendingUserRequest
        ? {
            pendingUserRequest: {
              id: run.pendingUserRequest.id,
              prompt: run.pendingUserRequest.prompt
            }
          }
        : {}),
      ...(run.failure ? { failure: run.failure } : {}),
      ...(run.verification ? { verification: run.verification } : {})
    };
  }

  /*
   * 内部自动恢复入口:perform/prepare 抛错时把 Run 转为 environment_offline
   * 并释放本地句柄,与 recover_environment 命令分支语义对齐。
   * 状态先于 dispose 持久化,避免 dispose 失败留下半挂句柄。
   * 终态/非可驱动状态下不应到达这里,故不重复 isDriverStartable 闸门。
   */
  private async markEnvironmentOffline(
    stored: StoredRun,
    handle: EnvironmentHandle,
    token: RunLeaseToken
  ): Promise<void> {
    try {
      await this.transition(stored, "environment_offline", token);
    } catch (transitionError) {
      /*
       * LeaseLostError / RunConflictError 表示对手已写过终态或 lease 已抢占,
       * 上抛让 caller 的 catch 守卫决定是否继续——但本地 handle 仍需释放,
       * 否则会留下半挂句柄给下次 resume 复用。
       * 这里把异常存起来,先 dispose + release,再上抛,保证 handle 一定释放。
       */
      if (
        !(transitionError instanceof LeaseLostError) &&
        !(transitionError instanceof RunConflictError)
      ) {
        throw transitionError;
      }
      try {
        await this.dependencies.environment.dispose(handle, "discard");
      } finally {
        this.dependencies.handles.release(stored.id);
      }
      throw transitionError;
    }
    try {
      await this.dependencies.environment.dispose(handle, "discard");
    } finally {
      this.dependencies.handles.release(stored.id);
    }
  }

  /*
   * prepare 抛错的离线恢复:prepare 失败时还没有 EnvironmentHandle
   * (注册发生在 prepare 成功后),因此仅做状态迁移,不 dispose、不释放注册表。
   * 与 recover_environment 命令分支的"无句柄"分支语义对齐。
   */
  private async handlePrepareFailure(
    stored: StoredRun,
    token: RunLeaseToken
  ): Promise<void> {
    await this.transition(stored, "environment_offline", token);
  }

  /*
   * 因 AbortSignal 触发的取消终态化:drive 收到 RunCancelledByAbortError 后
   * 走此路径,把 Run 转为 cancelled + dispose 环境 + 释放句柄。
   * 区别于 markEnvironmentOffline:不写入 failure code,不转 environment_offline,
   * 不期望下次 resume 重 prepare——取消是用户主动语义,不应重试。
   *
   * RunConflictError(版本冲突)表示对手已写终态——典型场景是 cancel 命令
   * 路径已经写过 cancelled,本路径直接吞掉返回,不重复写。
   */
  private async markRunCancelled(
    stored: StoredRun,
    handle: EnvironmentHandle,
    token: RunLeaseToken
  ): Promise<void> {
    try {
      await this.transition(stored, "cancelled", token);
    } catch (transitionError) {
      /*
       * LeaseLostError / RunConflictError 表示对手已写过终态或 lease 已抢占,
       * 但本地 handle 仍需释放——否则会留下半挂句柄给下次 resume 复用。
       * 其他错误上抛给上层守卫处理。
       */
      if (
        !(transitionError instanceof LeaseLostError) &&
        !(transitionError instanceof RunConflictError)
      ) {
        throw transitionError;
      }
    }
    /*
     * 无条件 dispose + release:即便 transition 被对手写完或 lease 已丢,
     * 本地 handle 仍是唯一持有者(对手在另一进程,registry 不共享),
     * 必须清理。重复 dispose 在 FakeDocker / DockerRunEnvironment 中幂等,
     * 真实 Docker 实现也必须 tolerate duplicate dispose。
     */
    try {
      await this.dependencies.environment.dispose(handle, "discard");
    } finally {
      this.dependencies.handles.release(stored.id);
    }
  }

  private async prepareAndRun(
    stored: StoredRun,
    token: RunLeaseToken,
    alreadyPreparing = false
  ): Promise<void> {
    if (!alreadyPreparing) {
      await this.transition(stored, "preparing", token);
    }
    /*
     * prepare 是真实环境的长 await(镜像拉取可达数分钟),
     * 必须用 heartbeat 在 leaseMilliseconds/2 间隔持续 renewLease,
     * 避免租约过期被新 Worker 接管。失租立即抛 LeaseLostError。
     */
    const handle = await this.dependencies.heartbeat.withHeartbeat(
      token,
      this.heartbeatIntervalMs(),
      () =>
        this.dependencies.environment.prepare({
          runId: stored.id,
          projectId: stored.input.projectId,
          environmentId: stored.input.environmentId,
          fileAccessScope: stored.input.fileAccessScope
        })
    );
    this.dependencies.handles.register(stored.id, {
      handle,
      environmentId: stored.input.environmentId,
      abort: new AbortController()
    });
    // prepare 是长 await 边界,写入 running 前必须确认租约仍在手中
    await this.transition(stored, "running", token);
  }

  private heartbeatIntervalMs(): number {
    const lease = this.dependencies.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS;
    return Math.max(1, Math.floor(lease / 2));
  }

  private async drive(stored: StoredRun, token: RunLeaseToken): Promise<void> {
    /*
     * 仅推进 running 状态的 Run;waiting_approval / environment_offline 等
     * 可驱动但非运行中状态由各自入口(command/recovery)处理,
     * 进入 drive 前必须先转到 running。Worker 崩溃恢复时,
     * resume 到 waiting_approval 直接 return,不会重复调用模型——
     * 这是 durable continuation 的关键:挂起状态就是持久化的续跑点。
     */
    if (stored.status !== "running") {
      return;
    }
    for (;;) {
      /*
       * 每个 await 边界续约一次 lease;续约失败(被其他 Worker 抢走或过期)
       * 则立即放弃驱动,避免覆盖新 owner 的写入。
       */
      if (!(await this.renewLease(token))) {
        return;
      }

      /*
       * 模型调用前的状态检查:取消/批准等并发命令可能已改变状态。
       * 若状态已不是 running,不得再调用模型——
       * 既避免浪费推理资源,也避免把已挂起的 continuation 当作新 turn 处理。
       */
      const current = await this.requireRun(stored.id);
      if (current.status !== "running") {
        return;
      }
      stored = current;

      let turn: Extract<AgentModelTurn, { type: "tool_call" }>;
      if (stored.pendingToolCall) {
        // A replacement Worker resumes the exact provider call instead of minting a new callId.
        turn = stored.pendingToolCall;
      } else {
        stored = await this.stageSteering(stored, token);
        const modelTurn = await this.dependencies.model.next({
          runId: stored.id,
          run: stored.input,
          toolResults: stored.toolResults,
          steeringMessages: (stored.pendingSteering ?? []).map(
            (entry) => entry.message
          )
        });

        if (modelTurn.type === "completed") {
          if (stored.pendingSteering?.length) {
            delete stored.pendingSteering;
            stored.version = await this.dependencies.store.save(stored);
          }
          break;
        }
        if (modelTurn.type === "user_request") {
          delete stored.pendingSteering;
          stored.pendingUserRequest = {
            id: modelTurn.requestId,
            prompt: modelTurn.prompt,
            ...(modelTurn.continuationId
              ? { continuationId: modelTurn.continuationId }
              : {})
          };
          await this.transition(stored, "waiting_user", token, [
            {
              type: "agent_question",
              data: {
                requestId: modelTurn.requestId,
                prompt: modelTurn.prompt
              }
            }
          ]);
          return;
        }
        turn = modelTurn;
        /*
         * Persist the provider call before policy evaluation or any side effect. If this
         * Worker dies after perform, a replacement reuses callId + continuationId and the
         * tool ledger can recover the same claim without invoking the model again.
         */
        stored.pendingToolCall = turn;
        delete stored.pendingSteering;
        stored.version = await this.dependencies.store.save(stored);
      }

      const decision = await this.dependencies.policy.authorize({
        approvalMode: stored.input.approvalMode,
        fileAccessScope: stored.input.fileAccessScope,
        ...(stored.input.deniedCommands
          ? { deniedCommands: stored.input.deniedCommands }
          : {}),
        capability: {
          type: "command_exec",
          argv: turn.arguments.argv,
          cwd: "."
        }
      });
      if (decision.decision === "ask") {
        stored.pendingToolCall = turn;
        stored.pendingApproval = {
          id: `approval-${turn.callId}`,
          callId: turn.callId,
          summary: `Run ${turn.arguments.argv.join(" ")}`
        };
        await this.transition(stored, "waiting_approval", token, [
          {
            type: "approval_requested",
            data: {
              approvalId: stored.pendingApproval.id,
              callId: stored.pendingApproval.callId,
              summary: stored.pendingApproval.summary
            }
          }
        ]);
        return;
      }
      if (decision.decision === "deny") {
        stored.failure = {
          code: "policy_denied",
          message: decision.reason
        };
        await this.transition(stored, "failed", token, [
          this.runFailureEvent(stored.failure)
        ]);
        return;
      }

      const borrowed = this.dependencies.handles.borrow(stored.id);
      if (!borrowed) {
        throw new Error(`Run environment is not prepared: ${stored.id}`);
      }
      /*
       * 工具执行前再次续约:model 调用与 perform 之间的 await 窗口也可能
       * 失租,若继续执行会让失主 Worker 写入副作用。
       */
      if (!(await this.renewLease(token))) {
        this.dependencies.handles.restore(stored.id, borrowed);
        return;
      }
      try {
        await this.performWith(stored, turn, borrowed, token);
      } catch (error) {
        /*
         * 错误分类:
         * - LeaseLostError / RunConflictError:预期并发事件,守卫上抛
         * - RunCancelledByAbortError:用户主动取消,直接转 cancelled 终态,
         *   不得绕路 environment_offline(避免误判为环境错误触发重 prepare)
         * - 其他 perform 抛错:真实 I/O 失败,转 environment_offline 等下次 resume 重试
         */
        if (error instanceof LeaseLostError || error instanceof RunConflictError) {
          this.dependencies.handles.restore(stored.id, borrowed);
          throw error;
        }
        if (error instanceof RunCancelledByAbortError) {
          this.dependencies.handles.restore(stored.id, borrowed);
          await this.markRunCancelled(stored, borrowed.handle, token);
          return;
        }
        await this.markEnvironmentOffline(stored, borrowed.handle, token);
        return;
      } finally {
        this.dependencies.handles.restore(stored.id, borrowed);
      }
    }

    // completed turn 之后的 verify 是最长的 await 边界,终态写入前必须重新确认租约
    await this.transition(stored, "verifying", token);

    const borrowed = this.dependencies.handles.borrow(stored.id);
    if (!borrowed) {
      throw new Error(`Run environment is not prepared: ${stored.id}`);
    }
    /*
     * inspect 也是远端报告服务的 await 边界(可达数秒),
     * 与 verify 一同进入 heartbeat 守护,避免被新 Worker 抢占。
     */
    const reportEnvironment = await this.dependencies.heartbeat.withHeartbeat(
      token,
      this.heartbeatIntervalMs(),
      () => this.dependencies.environment.inspect(borrowed.handle)
    );
    this.dependencies.handles.restore(stored.id, borrowed);

    /*
     * verify 是最长的远端 await 边界(可达数十秒),
     * 必须用 heartbeat 守护,verify 期间持续持有 lease。
     */
    let verification = await this.dependencies.heartbeat.withHeartbeat(
      token,
      this.heartbeatIntervalMs(),
      () =>
        this.dependencies.verifier.verify({
          runId: stored.id,
          run: stored.input,
          environment: reportEnvironment
        }, borrowed.abort?.signal)
    );

    /*
     * Terminal evidence lives in the managed worktree, not the runtime container.
     * Dispose with "keep" removes the container and dependency volume while the
     * Git workspace adapter retains the patch for API inspection.
    */
    try {
      await this.dependencies.heartbeat.withHeartbeat(
        token,
        this.heartbeatIntervalMs(),
        () => this.dependencies.environment.dispose(borrowed.handle, "keep")
      );
    } catch {
      verification = {
        outcome: verification.outcome === "failed" ? "failed" : "inconclusive",
        checks: [
          ...verification.checks,
          {
            name: "runtime cleanup",
            outcome: "inconclusive",
            detail: "Run environment could not be disposed"
          }
        ]
      };
    } finally {
      this.dependencies.handles.release(stored.id);
    }

    stored.verification = verification;
    await this.transition(
      stored,
      verification.outcome === "passed" ? "succeeded" : "failed",
      token,
      [
        {
          type: "verification_completed",
          data: {
            outcome: verification.outcome,
            checkCount: verification.checks.length
          }
        }
      ]
    );
  }

  /** Stages ordered mailbox rows into the Run snapshot before a provider call. */
  private async stageSteering(
    stored: StoredRun,
    token: RunLeaseToken
  ): Promise<StoredRun> {
    const messages = await this.steerMailbox.readAfter(
      stored.id,
      stored.steeringCursor ?? 0,
      20
    );
    if (messages.length === 0) {
      return stored;
    }
    if (!(await this.renewLease(token))) {
      throw new LeaseLostError(stored.id);
    }
    stored.pendingSteering = [
      ...(stored.pendingSteering ?? []),
      ...messages
    ];
    stored.steeringCursor = messages.at(-1)!.sequence;
    await this.persistEvents(
      stored,
      [
        {
          type: "user_message_delivered",
          data: {
            messageIds: messages.map((message) => `steer:${message.sequence}`)
          }
        }
      ],
      token
    );
    return stored;
  }

  private async performWith(
    stored: StoredRun,
    turn: Extract<AgentModelTurn, { type: "tool_call" }>,
    borrowed: RegisteredHandle,
    token: RunLeaseToken
  ): Promise<void> {
    let result: EnvironmentResult;
    const action = {
      type: "execute" as const,
      command: turn.arguments.argv
    };
    if (!(stored.startedToolCallIds ?? []).includes(turn.callId)) {
      stored.startedToolCallIds = [
        ...(stored.startedToolCallIds ?? []),
        turn.callId
      ];
      /* Only the executable name and argument count enter the event stream; raw
       * arguments may contain credentials and remain inside the protected action. */
      await this.persistEvents(
        stored,
        [
          {
            type: "tool_started",
            data: {
              callId: turn.callId,
              command: turn.arguments.argv[0] ?? "unknown",
              argumentCount: turn.arguments.argv.length
            }
          }
        ],
        token
      );
    }
    /*
     * claim 必须先于环境调用落库。若已有未完成 claim,说明前任 Worker
     * 可能已经产生副作用,此时宁可停止并要求核对,也不能自动重放。
     */
    const claim = await this.toolCalls.claim({
      runId: stored.id,
      callId: turn.callId,
      action
    });
    if (claim.status === "outcome_unknown") {
      stored.failure = {
        code: "tool_call_outcome_unknown",
        message: `Tool call outcome requires reconciliation: ${turn.callId}`
      };
      await this.transition(stored, "failed", token, [
        this.runFailureEvent(stored.failure)
      ]);
      return;
    }
    if (claim.status === "completed") {
      // A prior Worker completed the side effect; only recover its durable result.
      result = claim.result;
    } else {
      try {
        /*
         * 用 heartbeat 守护 perform 的长 await 边界:
         * - renewLease 每 heartbeatIntervalMs/2 持续续约,避免 perform 期间被抢占
         * - onTick 兜底检测:PG LISTEN/NOTIFY 漏派(cancelBus 消费者断线)
         *   时,每次 tick 查 store——若 run 已被 cancel 命令写成终态
         *   (cancelled),直接调 handles.abort 触发 AbortSignal,
         *   perform reject → RunCancelledByAbortError → markRunCancelled。
         *   这把 cancel 从"依赖 NOTIFY 广播"降级为"依赖最终一致性 store
         *   检查",任何 cancel 命令写入一定被 perform 在下个 tick 观察到。
         */
        result = await this.dependencies.heartbeat.withHeartbeat(
          token,
          this.heartbeatIntervalMs(),
          () =>
            this.dependencies.environment.perform(
              borrowed.handle,
              action,
              borrowed.abort?.signal
            ),
          () => this.tickCancellationFallback(stored)
        );
      } catch (error) {
        /*
         * 区分 cancel 触发的 error 与真实 I/O 失败:
         * cancel 命令调 handles.abort() 后 AbortSignal.aborted === true,
         * perform reject 通常来自适配器内部(例如 docker kill)——
         * 这种情况下不是环境损坏,Run 不应走 environment_offline 重 prepare,
         * 而应直接走 cancelled 终态。
         * 真实 I/O 错误(OOM、daemon unreachable 等)信号未被 abort,
         * 继续上抛由 drive catch 走 markEnvironmentOffline。
         */
        if (borrowed.abort?.signal.aborted === true) {
          throw new RunCancelledByAbortError(stored.id, error);
        }
        throw error;
      }
      /*
       * 先完成幂等账本、再保存 Run 快照。若随后崩溃,接管 Worker 会复用
       * completed 结果;若在此之前崩溃,executing claim 会阻止副作用重放。
       */
      await this.toolCalls.complete({
        runId: stored.id,
        callId: turn.callId,
        result
      });
    }
    /*
     * perform 是真实 I/O 的 await 边界,期间租约可能被抢占。
     * 工具副作用已实际发生,但结果写入必须先确认租约仍在手中:
     * 失租时丢弃结果,由接管轮次基于干净快照重新决策,
     * 避免旧 owner 用旧快照污染新 owner 的模型输入。
     */
    if (!(await this.renewLease(token))) {
      throw new LeaseLostError(stored.id);
    }
    stored.toolResults.push({
      callId: turn.callId,
      ...(turn.continuationId
        ? { continuationId: turn.continuationId }
        : {}),
      status: "executed",
      ...result
    });
    // Result and pending-call consumption land in the same optimistic snapshot save.
    delete stored.pendingToolCall;
    // Completed calls no longer need a takeover marker; unresolved calls retain it.
    stored.startedToolCallIds = (stored.startedToolCallIds ?? []).filter(
      (callId) => callId !== turn.callId
    );
    if (stored.startedToolCallIds.length === 0) {
      delete stored.startedToolCallIds;
    }
    // Result consumption and completion evidence share one optimistic write.
    await this.persistEvents(
      stored,
      [
        {
          type: "tool_completed",
          data: {
            callId: turn.callId,
            outcome: "executed",
            exitCode: result.exitCode,
            recovered: claim.status === "completed"
          }
        }
      ],
      token
    );
  }

  private async requireRun(runId: RunId): Promise<StoredRun> {
    const run = await this.dependencies.store.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
  }

  /**
   * 心跳兜底取消检测:PG LISTEN/NOTIFY 漏派时(订阅断线/消息丢失),
   * cancel 命令已经把 run 写成终态 "cancelled",worker 通过 store 在下一个
   * heartbeat tick 必然观察到。这里把 AbortSignal 拉起,让 perform reject,
   * 与 cancelBus 广播路径走同一条 markRunCancelled 终态化。
   *
   * 幂等:handles.abort 对未注册的 runId 返回 0,重复 abort 无害。
   * 错误隔离:store 读失败直接返回,不打断 perform(tick 抛错被 heartbeat 吞)。
   */
  private async tickCancellationFallback(stored: StoredRun): Promise<void> {
    const current = await this.dependencies.store.get(stored.id);
    if (!current || current.status !== "cancelled") {
      return;
    }
    this.dependencies.handles.abort(stored.id);
  }

  /**
   * Persists state before publishing it so an SSE client can immediately inspect
   * the state named by an event. Production injects RunTransitionWriter to commit
   * the snapshot, event, and outbox atomically; the fallback preserves test adapters.
   *
   * 写入边界租约校验:持 token 的调用方在持久化前必须仍持有有效租约。
   * 失租说明新 owner 已(或即将)接管,这里必须抛 LeaseLostError 中止写入,
   * 而不是静默跳过--静默会让调用方继续用旧快照推进后续步骤。
   * start() 入队不持租约,因此 token 缺省时不校验。
   */
  private async transition(
    stored: StoredRun,
    status: RunStatus,
    token?: RunLeaseToken,
    beforeStatusEvents: PersistRunEvent[] = []
  ): Promise<void> {
    if (token && !(await this.renewLease(token))) {
      throw new LeaseLostError(stored.id);
    }
    stored.status = status;
    if (beforeStatusEvents.length > 0) {
      /* Detail events precede the status delimiter so terminal SSE replay includes
       * the evidence before clients intentionally stop at the terminal status. */
      const events = [
        ...beforeStatusEvents,
        { type: "status_changed" as const, data: { status } }
      ];
      if (this.dependencies.transitions) {
        stored.version = await this.dependencies.transitions.persistEvents(
          stored,
          events
        );
      } else {
        stored.version = await this.dependencies.store.save(stored);
        for (const event of events) {
          await this.dependencies.events.publish({ runId: stored.id, ...event });
        }
      }
      return;
    }
    if (this.dependencies.transitions) {
      // PostgreSQL writer owns both writes, preventing a crash between state and event.
      stored.version = await this.dependencies.transitions.persist(stored, status);
    } else {
      // Compatibility path for in-memory tests and non-production adapters.
      stored.version = await this.dependencies.store.save(stored);
      await this.dependencies.events.publish({
        runId: stored.id,
        type: "status_changed",
        data: { status }
      });
    }
  }

  /** Persists snapshot mutations with one or more non-derived events atomically in production. */
  private async persistEvents(
    stored: StoredRun,
    events: PersistRunEvent[],
    token: RunLeaseToken
  ): Promise<void> {
    if (!(await this.renewLease(token))) {
      throw new LeaseLostError(stored.id);
    }
    if (this.dependencies.transitions) {
      stored.version = await this.dependencies.transitions.persistEvents(
        stored,
        events
      );
      return;
    }
    // Compatibility path is atomic within deterministic in-memory adapters.
    stored.version = await this.dependencies.store.save(stored);
    for (const event of events) {
      await this.dependencies.events.publish({ runId: stored.id, ...event });
    }
  }

  private async recordAgentLoopFailure(
    stored: StoredRun,
    error: unknown,
    token?: RunLeaseToken
  ): Promise<void> {
    stored.failure = {
      code: "agent_loop_failed",
      message: error instanceof Error ? error.message : "Agent loop failed"
    };
    try {
      await this.transition(stored, "failed", token, [
        this.runFailureEvent(stored.failure)
      ]);
    } catch (transitionError) {
      /*
       * 冲突说明并发命令已写入终态(如 cancelled),失租说明新 owner 已接管:
       * 两种情况都保留对方结果;其他错误继续上抛。
       */
      if (
        transitionError instanceof RunConflictError ||
        transitionError instanceof LeaseLostError
      ) {
        return;
      }
      throw transitionError;
    }
  }

  /** Converts a durable failure into the bounded public timeline payload. */
  private runFailureEvent(failure: RunFailure): PersistRunEvent {
    return {
      type: "run_failed",
      data: { code: failure.code, message: failure.message }
    };
  }

  private async acquireLease(
    runId: RunId,
    retry: RetryPolicy | undefined
  ): Promise<RunLeaseToken | undefined> {
    /*
     * 重试队列:lease 被其他 Worker 持有时,按 retry 策略等待再尝试,
     * 直至预算耗尽或 acquire 成功。retry 缺省为 5 秒封顶指数退避。
     * command 路径传 undefined,保持原"立即决策权归属"行为。
     */
    const startedAt = Date.now();
    let attempt = 0;
    while (true) {
      attempt += 1;
      const token = await this.dependencies.lease.acquire({
        runId,
        ownerId: this.dependencies.workerId,
        leaseUntil: this.computeLeaseUntil()
      });
      if (token) {
        return token;
      }
      if (!retry) {
        return undefined;
      }
      const elapsedMs = Date.now() - startedAt;
      if (!retry.shouldRetry({ attempt, elapsedMs })) {
        return undefined;
      }
      await retry.wait({ attempt, elapsedMs });
    }
  }

  private async renewLease(token: RunLeaseToken): Promise<boolean> {
    return this.dependencies.lease.renew({
      runId: token.runId,
      ownerId: token.ownerId,
      leaseUntil: this.computeLeaseUntil(),
      // 透传乐观锁世代号:内存实现忽略,PG 等持久化实现消费。
      // token 是 opaque,RunEngine 不读此字段。
      ...(token.generation !== undefined ? { generation: token.generation } : {})
    });
  }

  private computeLeaseUntil(): string {
    const milliseconds =
      this.dependencies.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS;
    const now = Date.parse(this.dependencies.now());
    if (!Number.isFinite(now)) {
      throw new Error("RunEngine clock must return a canonical UTC timestamp");
    }
    return new Date(now + milliseconds).toISOString();
  }
}

const DEFAULT_LEASE_MILLISECONDS = 30_000;
const DEFAULT_RETRY_BUDGET_MS = 5_000;
const DEFAULT_RETRY_BACKOFF_MS = 25;

/**
 * 默认 lease 重试策略:5 秒封顶,25ms 起指数退避(封顶 200ms)。
 * 测试可通过 deps.retry 注入自定义策略。
 */
export function createDefaultRunLeaseRetryPolicy(): RetryPolicy {
  const startedAt = Date.now();
  return {
    shouldRetry({ elapsedMs }) {
      return elapsedMs < DEFAULT_RETRY_BUDGET_MS;
    },
    async wait({ attempt }) {
      // attempt 从 1 起:25, 50, 100, 200, 200, ...
      const delay = Math.min(
        DEFAULT_RETRY_BACKOFF_MS * 2 ** Math.max(attempt - 1, 0),
        200
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      // 跨重载的运行时;budget 用最新 now 折算
      void startedAt;
      return Date.now() - startedAt;
    }
  };
}

/**
 * setInterval 心跳守护:在长 await 期间按 intervalMs 间隔
 * 通过 deps.lease.renew 续约 token;fn 完成或失租时清除守护并终止。
 * 续约失败时主动 invalidate 当前 lease,让其他 Worker 立即接管
 * (而不是等 lease 自然过期,跨进程场景下本地 leaseMilliseconds 不可靠)。
 * 不可跨进程:生产用 PG 心跳/外部 watchdog 替换,需保证 invalidate
 * 在新 Worker 接管前到达(否则会与正常续约竞争 lease)。
 */
export function createIntervalLeaseHeartbeat(lease: RunLease): LeaseHeartbeat {
  return {
    async withHeartbeat<T>(
      token: RunLeaseToken,
      intervalMs: number,
      fn: () => Promise<T>,
      onTick?: () => Promise<void>
    ): Promise<T> {
      let lost = false;
      const renew = async () => {
        const until = new Date(Date.now() + 30_000).toISOString();
        const ok = await lease.renew({
          runId: token.runId,
          ownerId: token.ownerId,
          leaseUntil: until
        });
        if (!ok) {
          lost = true;
          // 跨进程旁路:主动作废当前 lease,让接管者立即获权。
          // 同进程内 idempotent:重复 invalidate 是 no-op。
          await lease.invalidate({
            runId: token.runId,
            ownerId: token.ownerId,
            ...(token.generation !== undefined ? { generation: token.generation } : {})
          });
        }
      };
      /*
       * tick 主循环:每次 renewLease 后调 onTick(若提供)。
       * onTick 是"额外观察"——PG NOTIFY 漏派时,它通过 store 兜底检测终态取消
       * 并调 handles.abort,迫使 perform reject。
       * onTick 抛错被吞,不污染 fn 主路径。
       */
      const tick = async (): Promise<void> => {
        if (lost) {
          return;
        }
        await renew();
        if (onTick !== undefined && !lost) {
          try {
            await onTick();
          } catch {
            // 隔离 onTick 错误,不污染主路径 fn
          }
        }
      };
      const timer = setInterval(() => {
        void tick();
      }, intervalMs);
      try {
        const result = await fn();
        if (lost) {
          throw new LeaseLostError(token.runId);
        }
        return result;
      } finally {
        clearInterval(timer);
      }
    }
  };
}

/** 内存句柄注册表,默认实现;生产可替换为支持跨进程租约的实现。 */
export function createInMemoryRunHandleRegistry(): RunHandleRegistry {
  return new InMemoryRunHandleRegistry();
}

/**
 * 进程内 lease:acquire 在没有未过期 lease 时拿到 token;否则返回 undefined。
 * invalidate 把当前 lease 立即置为过期,模拟"被其他 Worker 抢走"。
 * 不可跨进程:生产用 PostgreSQL/pg-boss 等支持 SKIP LOCKED 的实现替换。
 */
export function createInMemoryRunLease(): RunLease {
  return new InMemoryRunLease();
}

export {
  createPostgresRunLease
} from "./postgres-run-lease.js";
export type { PostgresExecutor } from "./postgres-run-lease.js";
export {
  createPgBossRecoveryWorker,
  createIntervalRecoveryWorker
} from "./recovery-worker.js";
export type {
  PgBossRecoveryWorkerOptions,
  RecoveryJobQueue,
  RecoveryQueueOptions,
  RecoverySendOptions,
  RecoveryWorkOptions,
  RunRecoveryWorker,
  IntervalRecoveryWorkerOptions
} from "./recovery-worker.js";

class InMemoryRunLease implements RunLease {
  private readonly entries = new Map<RunId, { ownerId: string; leaseUntil: string }>();

  async acquire(input: RunLeaseAcquire): Promise<RunLeaseToken | undefined> {
    const existing = this.entries.get(input.runId);
    if (existing && !this.isExpired(existing.leaseUntil) && existing.ownerId !== input.ownerId) {
      return undefined;
    }
    this.entries.set(input.runId, {
      ownerId: input.ownerId,
      leaseUntil: input.leaseUntil
    });
    return { runId: input.runId, ownerId: input.ownerId };
  }

  async renew(input: RunLeaseRenew): Promise<boolean> {
    const existing = this.entries.get(input.runId);
    if (!existing || existing.ownerId !== input.ownerId || this.isExpired(existing.leaseUntil)) {
      return false;
    }
    existing.leaseUntil = input.leaseUntil;
    return true;
  }

  async release(input: RunLeaseRelease): Promise<void> {
    const existing = this.entries.get(input.runId);
    if (existing && existing.ownerId === input.ownerId) {
      this.entries.delete(input.runId);
    }
  }

  async invalidate(input: RunLeaseRelease): Promise<void> {
    const existing = this.entries.get(input.runId);
    if (existing && existing.ownerId === input.ownerId) {
      // 把 lease 置为已过期:用最小可表示时间戳,任何续约都会失败
      existing.leaseUntil = "1970-01-01T00:00:00.000Z";
    }
  }

  private isExpired(leaseUntil: string): boolean {
    return Date.parse(leaseUntil) <= Date.parse(new Date().toISOString());
  }
}

class InMemoryRunHandleRegistry implements RunHandleRegistry {
  private readonly entries = new Map<RunId, RegisteredHandle>();

  register(runId: RunId, entry: RegisteredHandle): void {
    this.entries.set(runId, entry);
  }

  release(runId: RunId): RegisteredHandle | undefined {
    const entry = this.entries.get(runId);
    this.entries.delete(runId);
    return entry;
  }

  borrow(runId: RunId): RegisteredHandle | undefined {
    return this.entries.get(runId);
  }

  restore(runId: RunId, entry: RegisteredHandle): void {
    // 仅在原位置仍持有同一份引用时归还,避免覆盖已被释放的位置
    const existing = this.entries.get(runId);
    if (existing === entry) {
      this.entries.set(runId, entry);
    }
  }

  abort(runId: RunId): number {
    const entry = this.entries.get(runId);
    if (entry?.abort === undefined) {
      return 0;
    }
    entry.abort.abort();
    return 1;
  }
}

/**
 * 驱动启动状态:表示 Worker 应当从该状态继续推进 Run。
 * 终态(succeeded/failed/cancelled)和 transitioning(cancelling)不进入此集合。
 */
function isDriverStartable(status: RunStatus): boolean {
  switch (status) {
    case "queued":
    case "preparing":
    case "running":
    case "waiting_approval":
    case "waiting_user":
    case "environment_offline":
      return true;
    case "verifying":
    case "succeeded":
    case "failed":
    case "cancelling":
    case "cancelled":
      return false;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** Statuses where a mailbox instruction can still reach a future model boundary. */
function isLiveSteerableStatus(status: RunStatus): boolean {
  return (
    status === "queued" ||
    status === "preparing" ||
    status === "running" ||
    status === "environment_offline"
  );
}

/** Bounds durable user-authored mailbox content before any adapter persists it. */
function validateSteeringMessage(message: string): void {
  const length = message.trim().length;
  if (length < 1 || length > 4_000) {
    throw new Error("User input must contain between 1 and 4000 characters");
  }
}

/** Bounds the client-generated idempotency identity before persistence. */
function validateSteeringCommandId(commandId: string): void {
  if (commandId.trim() === "" || commandId.length > 128) {
    throw new Error("Steering commandId must contain between 1 and 128 characters");
  }
}

/** Exact command retries succeed; an idempotency-key payload change fails closed. */
function assertMatchingUserCommandReceipt(
  receipt: UserCommandReceipt,
  command: Extract<RunCommand, { type: "answer" | "steer" }>
): void {
  const value = command.type === "answer" ? command.value : command.message;
  const requestMatches =
    command.type === "steer" || receipt.requestId === command.requestId;
  if (
    receipt.type !== command.type ||
    receipt.value !== value ||
    !requestMatches
  ) {
    throw new Error("User commandId was reused with a different payload");
  }
}
