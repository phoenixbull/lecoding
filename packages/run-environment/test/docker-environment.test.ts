import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBoundedOutputCapture,
  createDockerRunEnvironment,
  createDockerRunPlan
} from "../src/docker-environment.js";
import type { EnvironmentHandle } from "@lecoding/contracts";

/**
 * 检查 docker daemon 是否可用:用 `docker info` 探活,失败则 skip。
 * 这是 PoC 测试环境的常用守护——避免 daemon 未运行时的失败噪音。
 *
 * The previous version used `child_process.spawn` with a Promise
 * wrapper; on hosts without `docker` the spawn error resolved quickly,
 * but hosts with a stale or hung `docker info` could block the whole
 * suite. `spawnSync` with a 5 s wall-clock cap makes the probe
 * deterministic for both healthy and missing-daemon environments.
 */
function hasDockerDaemon(): boolean {
  const probe = spawnSync("docker", ["info"], {
    stdio: "ignore",
    timeout: 5_000
  });
  return probe.status === 0;
}

/**
 * Resolve once at module load whether `docker` is reachable; the rest of
 * the suite uses this flag to gate end-to-end tests. The previous form
 * called `context.skip()` from inside the test body, which Vitest does
 * not honour and caused the suite to hang for 30 s waiting for `docker
 * info` to time out instead of skipping.
 */
const dockerAvailable = hasDockerDaemon();
const dockerIt = dockerAvailable ? it : it.skip;

describe("createDockerRunEnvironment (PoC)", () => {
  it("bounds streaming command output by bytes without splitting UTF-8", () => {
    const capture = createBoundedOutputCapture(16);

    capture.append(Buffer.from("12345678901234"));
    capture.append(Buffer.from("你好-more-output"));

    const result = capture.finish();
    expect(Buffer.byteLength(result.value)).toBeLessThanOrEqual(16);
    expect(result.value).toBe("12345678901234");
    expect(result.truncated).toBe(true);
  });

  it("builds a non-root, read-only, resource-bounded workspace plan", () => {
    const plan = createDockerRunPlan({
      containerId: "lecoding-run-1",
      spec: {
        runId: "run-1",
        projectId: "project-1",
        environmentId: "sandbox-v1",
        fileAccessScope: "workspace_only"
      },
      limits: {
        image: "lecoding-sandbox:phase0",
        worktreeRoot: "/srv/lecoding/runs",
        workspacePath: "/srv/lecoding/runs/run-1",
        memory: "512m",
        cpus: 1,
        pidsLimit: 128
      }
    });

    expect(plan).toEqual({
      executable: "docker",
      args: [
        "run",
        "-d",
        "--name",
        "lecoding-run-1",
        "--read-only",
        "--user",
        "10001:10001",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "128",
        "--ulimit",
        "nofile=1024:1024",
        "--network",
        "none",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=64m",
        "--mount",
        "type=bind,source=/srv/lecoding/runs/run-1,target=/workspace",
        "--workdir",
        "/workspace",
        "--env",
        "HOME=/tmp",
        "--label",
        "run-id=run-1",
        "--label",
        "project-id=project-1",
        "lecoding-sandbox:phase0",
        "sleep",
        "infinity"
      ]
    });
  });

  it("keeps the sandbox offline even if an untrusted caller requests another network", () => {
    const plan = createDockerRunPlan({
      containerId: "lecoding-network-deny",
      spec: {
        runId: "run-network-deny",
        projectId: "project-1",
        environmentId: "sandbox-v1",
        fileAccessScope: "workspace_only"
      },
      limits: {
        worktreeRoot: "/srv/lecoding/runs",
        workspacePath: "/srv/lecoding/runs/run-network-deny",
        // Exercise the runtime trust boundary despite the intentionally narrow type.
        network: "bridge"
      } as Parameters<typeof createDockerRunPlan>[0]["limits"]
    });

    const networkIndex = plan.args.indexOf("--network");
    expect(plan.args[networkIndex + 1]).toBe("none");
  });

  it("rejects an unbounded memory configuration", () => {
    expect(() =>
      createDockerRunPlan({
        containerId: "lecoding-run-1",
        spec: {
          runId: "run-1",
          projectId: "project-1",
          environmentId: "sandbox-v1",
          fileAccessScope: "workspace_only"
        },
        limits: {
          worktreeRoot: "/srv/lecoding/runs",
          workspacePath: "/srv/lecoding/runs/run-1",
          memory: "0"
        }
      })
    ).toThrow("bounded Docker memory value");
  });

  it("mounts image-prepared dependencies into a nested verification workspace", () => {
    const plan = createDockerRunPlan({
      containerId: "lecoding-verify-1",
      spec: {
        runId: "run-1",
        projectId: "project-1",
        environmentId: "verification-v1",
        fileAccessScope: "workspace_only"
      },
      limits: {
        image: "registry.example/verify@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        worktreeRoot: "/srv/lecoding/runs",
        workspacePath: "/srv/lecoding/runs/run-1",
        containerWorkspacePath: "/workspace/project",
        dependencyVolumePath: "/workspace/project/node_modules"
      }
    });

    expect(plan.args).toContain(
      "type=bind,source=/srv/lecoding/runs/run-1,target=/workspace/project"
    );
    expect(plan.args).toContain(
      "type=volume,target=/workspace/project/node_modules"
    );
    expect(plan.args).toContain("/workspace/project");
  });

  it("rejects a bind mount outside the registered worktree root", () => {
    expect(() =>
      createDockerRunPlan({
        containerId: "lecoding-run-1",
        spec: {
          runId: "run-1",
          projectId: "project-1",
          environmentId: "sandbox-v1",
          fileAccessScope: "workspace_only"
        },
        limits: {
          worktreeRoot: "/srv/lecoding/runs",
          workspacePath: "/etc"
        }
      })
    ).toThrow("outside the registered worktree root");
  });

  it("resolves worktree symlinks before checking the mount boundary", async () => {
    const worktreeRoot = await mkdtemp(join(tmpdir(), "lecoding-worktree-root-"));
    const workspacePath = join(worktreeRoot, "escaped-run");
    await symlink("/etc", workspacePath);
    const env = createDockerRunEnvironment({ worktreeRoot, workspacePath });
    try {
      await expect(
        env.prepare({
          runId: "escaped-run",
          projectId: "project-1",
          environmentId: "sandbox-v1",
          fileAccessScope: "workspace_only"
        })
      ).rejects.toThrow("outside the registered worktree root");
    } finally {
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });

  dockerIt(
    "runs prepare → perform → dispose against the docker daemon",
    async () => {
      /*
       * 端到端 PoC:容器创建 → 简单命令 → 销毁。运行时限制通过
       * docker run --memory/--cpus/--pids-limit/--network 落地,
       * abort 路径在 perform 内部通过 docker kill 触发。
       *
       * 默认镜像是 alpine:latest,本地若不存在会被 docker 自动 pull。
       */
      const workspacePath = await mkdtemp(join(tmpdir(), "lecoding-docker-poc-"));
      // The container's fixed uid must be able to exercise the dedicated test mount.
      await chmod(workspacePath, 0o777);
      const env = createDockerRunEnvironment({
        image: process.env.LECODING_DOCKER_TEST_IMAGE ?? "alpine:latest",
        worktreeRoot: tmpdir(),
        workspacePath,
        memory: "256m",
        cpus: 0.5,
        pidsLimit: 64,
        network: "none"
      });
      let handle: EnvironmentHandle | undefined;
      try {
        handle = await env.prepare({
          runId: "poc-run",
          projectId: "poc-project",
          environmentId: "alpine-env",
          fileAccessScope: "workspace_only"
        });
        const result = await env.perform(handle, {
          type: "execute",
          command: ["echo", "hello"]
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("hello");
        const identity = await env.perform(handle, {
          type: "execute",
          command: ["id", "-u"]
        });
        const rootWrite = await env.perform(handle, {
          type: "execute",
          command: ["sh", "-c", "touch /etc/lecoding-must-fail"]
        });
        const workspaceWrite = await env.perform(handle, {
          type: "execute",
          command: ["sh", "-c", "echo ok > /workspace/probe"]
        });
        const tmpfsWrite = await env.perform(handle, {
          type: "execute",
          command: ["sh", "-c", "echo ok > /tmp/probe"]
        });
        // Observe the security contract through the RunEnvironment public seam.
        expect(identity.stdout.trim()).toBe("10001");
        expect(rootWrite.exitCode).not.toBe(0);
        expect(workspaceWrite.exitCode).toBe(0);
        expect(tmpfsWrite.exitCode).toBe(0);
      } finally {
        try {
          if (handle) {
            await env.dispose(handle, "discard");
          }
        } finally {
          // Only the uniquely-created test worktree is removed.
          await rm(workspacePath, { recursive: true, force: true });
        }
      }
    },
    120_000
  );

  dockerIt(
    "aborts an in-flight perform via AbortSignal (docker kill)",
    async () => {
      /*
       * PoC 取消语义:perform 在 alpine 容器里跑 sleep 30,
       * 100ms 后调 abort,期望 perform reject 在合理时间内(由 docker kill 触发)。
       */
      const workspacePath = await mkdtemp(join(tmpdir(), "lecoding-docker-abort-"));
      await chmod(workspacePath, 0o777);
      const env = createDockerRunEnvironment({
        image: process.env.LECODING_DOCKER_TEST_IMAGE ?? "alpine:latest",
        worktreeRoot: tmpdir(),
        workspacePath,
        network: "none"
      });
      let handle: EnvironmentHandle | undefined;
      try {
        handle = await env.prepare({
          runId: "poc-abort",
          projectId: "poc-project",
          environmentId: "alpine-env",
          fileAccessScope: "workspace_only"
        });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);
        const start = Date.now();
        await expect(
          env.perform(
            handle,
            { type: "execute", command: ["sleep", "30"] },
            controller.signal
          )
        ).rejects.toThrow("perform aborted by signal");
        expect(Date.now() - start).toBeLessThan(15_000);
      } finally {
        try {
          if (handle) {
            await env.dispose(handle, "discard");
          }
        } finally {
          await rm(workspacePath, { recursive: true, force: true });
        }
      }
    },
    30_000
  );
});
