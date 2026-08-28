import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
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
  /** 已解析的单 Run worktree 绝对路径;prepare 前必须提供。 */
  workspacePath?: string;
  /** 管理员注册的 worktree 根目录;workspacePath 必须是其严格子目录。 */
  worktreeRoot?: string;
  /** Container target for the worktree; verification uses a nested project path. */
  containerWorkspacePath?: string;
  /** Anonymous volume target containing dependencies prepared in the image. */
  dependencyVolumePath?: string;
  /** Phase 0 仅允许 none;保留字段用于显式配置和未来受控网络扩展。 */
  network?: "none";
  /** 容器内 /tmp 的 tmpfs 大小,默认 64 MiB。 */
  tmpfsSizeMb?: number;
  /** 进程可打开文件描述符软/硬上限,默认 1024。 */
  nofileLimit?: number;
  /** 单次 perform 的 docker exec 超时(毫秒);缺省 5 分钟。 */
  execTimeoutMs?: number;
  /** 每个 stdout/stderr 流的宿主内存硬上限,默认 8 MiB。 */
  outputBytes?: number;
}

/** Incremental byte-bounded capture used by docker exec pipe consumers. */
export interface BoundedOutputCapture {
  append(chunk: Buffer): void;
  finish(): { value: string; truncated: boolean };
}

/**
 * Creates a capture that never retains more than maximumBytes and emits only
 * valid UTF-8, even when a multi-byte character crosses the hard boundary.
 */
export function createBoundedOutputCapture(
  maximumBytes: number
): BoundedOutputCapture {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Docker output limit must be a positive integer");
  }
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  let truncated = false;
  return {
    append(chunk) {
      const available = maximumBytes - retainedBytes;
      if (available > 0) {
        const retained = chunk.subarray(0, available);
        chunks.push(retained);
        retainedBytes += retained.byteLength;
      }
      if (chunk.byteLength > available) {
        truncated = true;
      }
    },
    finish() {
      const bytes = Buffer.concat(chunks, retainedBytes);
      let end = bytes.byteLength;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      while (end > 0) {
        try {
          return {
            value: decoder.decode(bytes.subarray(0, end)),
            truncated: truncated || end !== bytes.byteLength
          };
        } catch {
          // At most one partial trailing code point is removed at the byte cap.
          end -= 1;
        }
      }
      return { value: "", truncated: truncated || bytes.byteLength > 0 };
    }
  };
}

/** Immutable, auditable Docker CLI plan executed by prepare(). */
export interface DockerRunPlan {
  executable: "docker";
  args: string[];
}

/** Inputs for constructing one security-bounded container creation plan. */
export interface DockerRunPlanInput {
  containerId: string;
  spec: EnvironmentSpec;
  limits: DockerRunLimits;
}

/**
 * Builds the exact Docker creation contract without contacting the daemon.
 * The workspace path must already be canonical and dedicated to this Run.
 */
export function createDockerRunPlan(input: DockerRunPlanInput): DockerRunPlan {
  const memory = input.limits.memory ?? "2g";
  const cpus = input.limits.cpus ?? 2;
  const pidsLimit = input.limits.pidsLimit ?? 256;
  const tmpfsSizeMb = input.limits.tmpfsSizeMb ?? 64;
  const nofileLimit = input.limits.nofileLimit ?? 1024;
  const image = input.limits.image ?? "lecoding/agent-runner:latest";
  const workspacePath = input.limits.workspacePath;
  const worktreeRoot = input.limits.worktreeRoot;
  const containerWorkspacePath =
    input.limits.containerWorkspacePath ?? "/workspace";
  const dependencyVolumePath = input.limits.dependencyVolumePath;

  if (!workspacePath || !worktreeRoot) {
    throw new Error(
      "DockerRunEnvironment requires worktreeRoot and a dedicated workspacePath"
    );
  }
  if (
    !isAbsolute(workspacePath) ||
    resolve(workspacePath) !== workspacePath ||
    workspacePath.includes(",") ||
    workspacePath.includes("\n") ||
    !isAbsolute(worktreeRoot) ||
    resolve(worktreeRoot) !== worktreeRoot ||
    worktreeRoot.includes(",") ||
    worktreeRoot.includes("\n")
  ) {
    throw new Error("Docker worktree paths must be canonical absolute paths");
  }
  const workspaceWithinRoot = relative(worktreeRoot, workspacePath);
  if (
    workspaceWithinRoot === "" ||
    workspaceWithinRoot === ".." ||
    workspaceWithinRoot.startsWith(`..${sep}`) ||
    isAbsolute(workspaceWithinRoot)
  ) {
    throw new Error("Docker workspacePath is outside the registered worktree root");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(input.containerId)) {
    throw new Error("Docker containerId contains unsupported characters");
  }
  if (!/^[1-9][0-9]*(?:b|k|m|g)$/i.test(memory)) {
    throw new Error("DockerRunEnvironment requires a bounded Docker memory value");
  }
  if (!Number.isFinite(cpus) || cpus <= 0) {
    throw new Error("Docker CPU limit must be positive");
  }
  if (!Number.isSafeInteger(pidsLimit) || pidsLimit < 1) {
    throw new Error("Docker PID limit must be a positive integer");
  }
  if (!Number.isSafeInteger(tmpfsSizeMb) || tmpfsSizeMb < 1) {
    throw new Error("Docker tmpfs limit must be a positive integer");
  }
  if (!Number.isSafeInteger(nofileLimit) || nofileLimit < 1) {
    throw new Error("Docker nofile limit must be a positive integer");
  }
  if (input.spec.fileAccessScope !== "workspace_only") {
    throw new Error("Server Docker runs only support workspace_only access");
  }
  if (
    containerWorkspacePath !== "/workspace" &&
    !/^\/workspace\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerWorkspacePath)
  ) {
    throw new Error("Docker containerWorkspacePath must stay below /workspace");
  }
  if (
    dependencyVolumePath !== undefined &&
    dependencyVolumePath !== `${containerWorkspacePath}/node_modules`
  ) {
    throw new Error(
      "Docker dependencyVolumePath must be the workspace node_modules path"
    );
  }

  const mounts = [
    "--mount",
    `type=bind,source=${workspacePath},target=${containerWorkspacePath}`
  ];
  if (dependencyVolumePath !== undefined) {
    /* The nested volume exposes immutable image-built dependencies above the bind. */
    mounts.push("--mount", `type=volume,target=${dependencyVolumePath}`);
  }

  return {
    executable: "docker",
    args: [
      "run",
      "-d",
      "--name",
      input.containerId,
      "--read-only",
      "--user",
      "10001:10001",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      memory,
      "--cpus",
      String(cpus),
      "--pids-limit",
      String(pidsLimit),
      "--ulimit",
      `nofile=${nofileLimit}:${nofileLimit}`,
      "--network",
      "none",
      "--tmpfs",
      `/tmp:rw,noexec,nosuid,nodev,size=${tmpfsSizeMb}m`,
      ...mounts,
      "--workdir",
      containerWorkspacePath,
      "--env",
      "HOME=/tmp",
      "--label",
      `run-id=${input.spec.runId}`,
      "--label",
      `project-id=${input.spec.projectId}`,
      image,
      "sleep",
      "infinity"
    ]
  };
}

interface ContainerRecord {
  containerId: string;
  handle: EnvironmentHandle;
}

/**
 * 创建 Docker-backed 适配器。骨架形态:
 * - prepare → 执行 createDockerRunPlan 的固定安全契约
 * - perform → docker exec + signal-aware:abort() 触发 docker kill
 * - inspect → docker diff
 * - dispose → docker rm -f
 */
export function createDockerRunEnvironment(
  limits: DockerRunLimits = {}
): RunEnvironment {
  const containers = new Map<string, ContainerRecord>();
  const execTimeoutMs = limits.execTimeoutMs ?? 5 * 60_000;
  const outputBytes = limits.outputBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(outputBytes) || outputBytes < 16_384) {
    throw new Error("Docker output limit must be at least 16384 bytes");
  }

  return {
    async prepare(spec: EnvironmentSpec): Promise<EnvironmentHandle> {
      const containerId = `lecoding-${randomBytes(6).toString("hex")}`;
      let planLimits = limits;
      if (limits.worktreeRoot && limits.workspacePath) {
        /*
         * Resolve both identities before containment checks so a symlink below the
         * registered root cannot redirect Docker to another host directory.
         */
        const [worktreeRoot, workspacePath] = await Promise.all([
          realpath(limits.worktreeRoot),
          realpath(limits.workspacePath)
        ]);
        planLimits = { ...limits, worktreeRoot, workspacePath };
      }
      const plan = createDockerRunPlan({ containerId, spec, limits: planLimits });
      await runDocker(plan.args);
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
        const stdout = createBoundedOutputCapture(outputBytes);
        const stderr = createBoundedOutputCapture(outputBytes);
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
          stdout.append(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr.append(chunk);
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
          const stdoutResult = stdout.finish();
          const stderrResult = stderr.finish();
          resolve({
            exitCode: exitCode ?? -1,
            stdout: stdoutResult.value,
            stderr: stderrResult.value,
            ...(stdoutResult.truncated ? { stdoutTruncated: true } : {}),
            ...(stderrResult.truncated ? { stderrTruncated: true } : {})
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
      // -v removes the anonymous dependency volume together with the disposable Run.
      await runDocker(["rm", "-f", "-v", handle.id]);
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
