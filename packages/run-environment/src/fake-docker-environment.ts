import type {
  EnvironmentAction,
  EnvironmentHandle,
  EnvironmentReport,
  EnvironmentResult,
  EnvironmentSpec
} from "@lecoding/contracts";
import type { RunEnvironment } from "./index.js";

/**
 * PoC 用的 Docker-like 测试环境:模拟 runtime limits 与 AbortSignal 行为,
 * 端到端验证 cancel / resource exhaustion 的语义路径。
 *
 * 与 FakeRunEnvironment(立即返回)不同,本类支持:
 * - commandDurationMs:perform 在指定时间内挂起(等待外部 abort 或自然完成)
 * - memoryLimitBytes:模拟 Docker cgroup 内存上限,抛 "memory_exceeded" 错误
 * - cpuLimit / pidsLimit / networkMode:Docker 容器运行参数占位,
 *   当前仅做语义记录,不参与运行时模拟
 * - AbortSignal:与 RunEngine cancel 命令联动,立即中断挂起的 perform
 */
export interface FakeDockerLimits {
  /**
   * Docker 容器内存上限(字节);触达后 perform 抛错,
   * 模拟 cgroup OOM kill。0 表示不限制。
   */
  memoryLimitBytes?: number;
  /**
   * CPU 限制(纳秒/微秒);仅作占位,当前不模拟节流。
   */
  cpuLimit?: number;
  /**
   * 进程数上限;仅作占位。
   */
  pidsLimit?: number;
  /**
   * 网络模式;仅作占位,影响未来 inspect 报告。
   */
  networkMode?: "none" | "bridge";
  /**
   * perform 挂起的最大时长(毫秒);0 表示立即返回。
   * AbortSignal 触发时立即 reject,不等到 commandDurationMs。
   */
  commandDurationMs?: number;
  /**
   * 设置后下一次 perform 抛指定错误,模拟 runtime 资源超限场景。
   * 用毕即清空——同一环境上同一错误只触发一次。
   */
  failNextCommand?:
    | "memory_exceeded"
    | "cpu_throttled"
    | "pids_exhausted"
    | "timeout";
}

export class FakeDockerRunEnvironment implements RunEnvironment {
  private readonly changedFiles: string[] = [];
  private readonly handles = new Map<string, EnvironmentHandle>();
  /** 测试用:持有 perform 期间正在监听的 AbortController,供外部直接触发 abort。 */
  private readonly externalAborters = new Map<string, AbortController>();

  constructor(private readonly limits: FakeDockerLimits = {}) {}

  /** 暴露给测试代码:获取 perform 正在监听的 AbortController,直接调 abort()。 */
  getAbortController(handleId: string): AbortController | undefined {
    return this.externalAborters.get(handleId);
  }

  async prepare(spec: EnvironmentSpec): Promise<EnvironmentHandle> {
    const handle: EnvironmentHandle = {
      id: `handle-${spec.runId}`,
      environmentId: spec.environmentId
    };
    this.handles.set(handle.id, handle);
    return handle;
  }

  async perform(
    handle: EnvironmentHandle,
    _action: EnvironmentAction,
    signal?: AbortSignal
  ): Promise<EnvironmentResult> {
    const fail = this.limits.failNextCommand;
    if (fail !== undefined) {
      delete (this.limits as { failNextCommand?: string }).failNextCommand;
      throw new Error(runtimeErrorMessage(fail));
    }
    const duration = this.limits.commandDurationMs ?? 0;
    if (duration === 0) {
      this.changedFiles.push("src/generated.ts");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return new Promise<EnvironmentResult>((resolve, reject) => {
      const controller = new AbortController();
      this.externalAborters.set(handle.id, controller);
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        this.externalAborters.delete(handle.id);
        this.changedFiles.push("src/generated.ts");
        resolve({ exitCode: 0, stdout: "", stderr: "" });
      }, duration);
      const onAbort = () => {
        clearTimeout(timer);
        this.externalAborters.delete(handle.id);
        const reason =
          signal?.reason instanceof Error
            ? signal.reason.message
            : "aborted";
        reject(new Error(`perform aborted: ${reason}`));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      // 同步外部 controller 的 abort:若外部调 controller.abort(),
      // 也触发同一 reject 路径,与 RunEngine 的 cancel 命令共用语义。
      controller.signal.addEventListener(
        "abort",
        () => {
          onAbort();
        },
        { once: true }
      );
    });
  }

  async inspect(_handle: EnvironmentHandle): Promise<EnvironmentReport> {
    return { changedFiles: [...this.changedFiles] };
  }

  async dispose(
    _handle: EnvironmentHandle,
    _outcome: "keep" | "discard"
  ): Promise<void> {
    // dispose 通常由 RunEngine 在 cancel / recover_environment 时调;
    // 这里仅清理本地索引,真实 Docker 实现会调 docker rm。
  }
}

function runtimeErrorMessage(kind: NonNullable<FakeDockerLimits["failNextCommand"]>): string {
  switch (kind) {
    case "memory_exceeded":
      return "container killed: memory exceeded cgroup limit";
    case "cpu_throttled":
      return "container throttled: cpu quota exceeded";
    case "pids_exhausted":
      return "container rejected: pids limit exhausted";
    case "timeout":
      return "command timed out: docker exec deadline exceeded";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}