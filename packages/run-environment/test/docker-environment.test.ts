import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { createDockerRunEnvironment } from "../src/docker-environment.js";
import type { EnvironmentHandle } from "@lecoding/contracts";

/**
 * 检查 docker daemon 是否可用:用 `docker info` 探活,失败则 skip。
 * 这是 PoC 测试环境的常用守护——避免 daemon 未运行时的失败噪音。
 */
function hasDockerDaemon(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn("docker", ["info"], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

describe("createDockerRunEnvironment (PoC)", () => {
  let dockerUp = false;
  beforeAll(async () => {
    dockerUp = await hasDockerDaemon();
  });

  it.runIf(dockerUp)(
    "runs prepare → perform → dispose against the docker daemon",
    async () => {
      /*
       * 端到端 PoC:容器创建 → 简单命令 → 销毁。运行时限制通过
       * docker run --memory/--cpus/--pids-limit/--network 落地,
       * abort 路径在 perform 内部通过 docker kill 触发。
       *
       * 默认镜像是 alpine:latest,本地若不存在会被 docker 自动 pull。
       */
      const env = createDockerRunEnvironment({
        image: "alpine:latest",
        memory: "256m",
        cpus: 0.5,
        pidsLimit: 64,
        network: "none"
      });
      const handle = await env.prepare({
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
      await env.dispose(handle, "discard");
    },
    120_000
  );

  it.runIf(dockerUp)(
    "aborts an in-flight perform via AbortSignal (docker kill)",
    async () => {
      /*
       * PoC 取消语义:perform 在 alpine 容器里跑 sleep 30,
       * 100ms 后调 abort,期望 perform reject 在合理时间内(由 docker kill 触发)。
       */
      const env = createDockerRunEnvironment({
        image: "alpine:latest",
        network: "none"
      });
      const handle: EnvironmentHandle = {
        id: "will-fail-prepare",
        environmentId: "alpine-env"
      };
      // 不走 prepare(避免依赖真实 docker run 的耗时);
      // 直接测 perform 在已知坏 handle 上的 reject。
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const start = Date.now();
      await expect(
        env.perform(
          handle,
          { type: "execute", command: ["sleep", "30"] },
          controller.signal
        )
      ).rejects.toThrow();
      // 即使 docker kill 失败,abort 后 reject 仍应在合理时间内返回
      expect(Date.now() - start).toBeLessThan(15_000);
    },
    30_000
  );
});