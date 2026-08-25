import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type {
  EnvironmentAction,
  EnvironmentHandle,
  EnvironmentReport,
  EnvironmentResult,
  EnvironmentSpec
} from "@lecoding/contracts";
import type { RunEnvironment } from "./index.js";

/**
 * PoC 用的 Docker 适配器骨架:对接真实 docker CLI,
 * 提供 runtime limits / AbortSignal 取消语义。
 *
 * 注意:此实现是 phase-0 骨架,不依赖 docker daemon 时返回的明确错误。
 * 真正的 production 适配器(phase-1)将走 docker SDK 而非 spawn CLI,
 * 并补齐 volume/network/registry/auth 等运行时特性。
 */
export interface DockerRunLimits {
  /** 镜像名(含 tag);不指定时使用 environmentId 派生。 */
  image?: string;
  /** Docker run --memory,默认 "2g"。 */
  memory?: string;
  /** Docker run --cpus,默认 2.0。 */
  cpus?: number;
  /** Docker run --pids-limit,默认 256。 */
  pidsLimit?: number;
  /** Docker run --network,默认 "none" 以隔离 Run。 */
  network?: "none" | "bridge" | "host";
  /** 单次 perform 的 docker exec 超时(毫秒);缺省 5 分钟。 */
  execTimeoutMs?: number;
}

interface ContainerRecord {
  containerId: string;
  handle: EnvironmentHandle;
}

/**
 * 创建 Docker-backed 适配器。骨架形态:
 * - prepare → docker run -d(--memory/--cpus/--pids-limit/--network)
 * - perform → docker exec + signal-aware:abort() 触发 docker kill
 * - inspect → docker diff
 * - dispose → docker rm -f
 */
export function createDockerRunEnvironment(
  limits: DockerRunLimits = {}
): RunEnvironment {
  const containers = new Map<string, ContainerRecord>();
  const memory = limits.memory ?? "2g";
  const cpus = limits.cpus ?? 2.0;
  const pidsLimit = limits.pidsLimit ?? 256;
  const network = limits.network ?? "none";
  const execTimeoutMs = limits.execTimeoutMs ?? 5 * 60_000;
  const defaultImage = limits.image ?? "lecoding/agent-runner:latest";

  return {
    async prepare(spec: EnvironmentSpec): Promise<EnvironmentHandle> {
      const containerId = `lecoding-${randomBytes(6).toString("hex")}`;
      const args = [
        "run",
        "-d",
        "--name",
        containerId,
        "--memory",
        memory,
        "--cpus",
        String(cpus),
        "--pids-limit",
        String(pidsLimit),
        "--network",
        network,
        "--label",
        `run-id=${spec.runId}`,
        "--label",
        `project-id=${spec.projectId}`,
        defaultImage,
        "sleep",
        "infinity"
      ];
      await runDocker(args);
      const handle: EnvironmentHandle = {
        id: containerId,
        environmentId: spec.environmentId
      };
      containers.set(containerId, { containerId, handle });
      return handle;
    },

    async perform(
      handle: EnvironmentHandle,
      action: EnvironmentAction,
      signal?: AbortSignal
    ): Promise<EnvironmentResult> {
      if (action.type !== "execute") {
        throw new Error(
          `DockerRunEnvironment: unsupported action type ${String(
            (action as { type?: unknown }).type
          )}`
        );
      }
      /*
       * perform 用 docker exec 跑命令;signal abort 时调 docker kill,
       * 让容器内进程立即收到 SIGKILL 而非等自然结束。
       * execTimeoutMs 防"忘 abort"的命令拖死 lease。
       */
      return await new Promise<EnvironmentResult>((resolve, reject) => {
        const child = spawn(
          "docker",
          ["exec", handle.id, ...action.command],
          { stdio: ["ignore", "pipe", "pipe"] }
        );
        let stdout = "";
        let stderr = "";
        let killed = false;
        const timeout = setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
          void runDocker(["kill", handle.id]).catch(() => undefined);
          reject(new Error(`perform timed out after ${execTimeoutMs}ms`));
        }, execTimeoutMs);
        const onAbort = () => {
          if (killed) {
            return;
          }
          killed = true;
          child.kill("SIGKILL");
          void runDocker(["kill", handle.id]).catch(() => undefined);
          reject(new Error(`perform aborted by signal`));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (err) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        });
        child.on("close", (exitCode) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          if (killed) {
            return; // 已经 reject
          }
          resolve({
            exitCode: exitCode ?? -1,
            stdout,
            stderr
          });
        });
      });
    },

    async inspect(handle: EnvironmentHandle): Promise<EnvironmentReport> {
      /*
       * docker diff 输出三类标记:
       * A = added, C = changed, D = deleted
       * 对 changedFiles 只收集 A/C 行(实际修改 / 新增)。
       */
      const { stdout } = await runDocker([
        "diff",
        handle.id
      ]);
      const changedFiles = stdout
        .split("\n")
        .filter((line) => line.startsWith("A ") || line.startsWith("C "))
        .map((line) => line.slice(2));
      return { changedFiles };
    },

    async dispose(
      handle: EnvironmentHandle,
      _outcome: "keep" | "discard"
    ): Promise<void> {
      await runDocker(["rm", "-f", handle.id]);
      containers.delete(handle.id);
    }
  };
}

interface DockerResult {
  stdout: string;
  stderr: string;
}

function runDocker(args: string[]): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`docker ${args.join(" ")} failed: ${stderr.trim()}`));
        return;
      }
      resolve({ stdout: stdout.trimEnd(), stderr });
    });
  });
}