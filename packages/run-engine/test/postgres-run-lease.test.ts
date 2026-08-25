import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createPostgresRunLease } from "../src/postgres-run-lease.js";
import type { RunLeaseToken } from "@lecoding/contracts";
import { createIntervalRecoveryWorker } from "../src/recovery-worker.js";
import { createTestHarness, InMemoryRunStore } from "@lecoding/test-harness";
import type { RunEnvironment } from "@lecoding/run-environment";

describe("postgres run lease", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
  });

  it("grants the lease to the first acquirer", async () => {
    const lease = await createPostgresRunLease(pg);
    const token = await lease.acquire({
      runId: "run-1",
      ownerId: "worker-A",
      leaseUntil: "2099-01-01T00:00:00.000Z"
    });
    expect(token).toBeDefined();
    expect(token?.runId).toBe("run-1");
    expect(token?.ownerId).toBe("worker-A");
  });

  it("rejects a second acquirer when the lease is held", async () => {
    const lease = await createPostgresRunLease(pg);
    await lease.acquire({
      runId: "run-1",
      ownerId: "worker-A",
      leaseUntil: "2099-01-01T00:00:00.000Z"
    });
    const tokenB = await lease.acquire({
      runId: "run-1",
      ownerId: "worker-B",
      leaseUntil: "2099-01-01T00:00:00.000Z"
    });
    expect(tokenB).toBeUndefined();
  });

  it("renews only for the current owner", async () => {
    const lease = await createPostgresRunLease(pg);
    const token = await lease.acquire({
      runId: "run-1",
      ownerId: "worker-A",
      leaseUntil: "2099-01-01T00:00:00.000Z"
    });
    expect(token).toBeDefined();
    const okA = await lease.renew({
      runId: "run-1",
      ownerId: "worker-A",
      leaseUntil: "2099-01-01T00:00:00.000Z"
    });
    const okB = await lease.renew({
      runId: "run-1",
      ownerId: "worker-B",
      leaseUntil: "2099-01-01T00:00:00.000Z"
    });
    expect(okA).toBe(true);
    expect(okB).toBe(false);
  });

  it("fails to renew after the lease is invalidated", async () => {
    const lease = await createPostgresRunLease(pg);
    const token: RunLeaseToken = (await lease.acquire({
      runId: "run-1",
      ownerId: "worker-A",
      leaseUntil: "2099-01-01T00:00:00.000Z"
    }))!;
    await lease.invalidate({ runId: "run-1", ownerId: "worker-A" });
    const ok = await lease.renew({
      runId: "run-1",
      ownerId: "worker-A",
      leaseUntil: "2099-01-01T00:00:00.000Z",
      generation: token.generation!
    });
    expect(ok).toBe(false);
  });

  it("allows a new owner to acquire after invalidation", async () => {
    const lease = await createPostgresRunLease(pg);
    await lease.acquire({
      runId: "run-1",
      ownerId: "worker-A",
      leaseUntil: "2099-01-01T00:00:00.000Z"
    });
    await lease.invalidate({ runId: "run-1", ownerId: "worker-A" });
    const tokenB = await lease.acquire({
      runId: "run-1",
      ownerId: "worker-B",
      leaseUntil: "2099-01-01T00:00:00.000Z"
    });
    expect(tokenB).toBeDefined();
    expect(tokenB?.ownerId).toBe("worker-B");
  });

  it("rejects renew from a stale token after a takeover", async () => {
    const lease = await createPostgresRunLease(pg);
    const tokenA = await lease.acquire({
      runId: "run-1",
      ownerId: "worker-A",
      leaseUntil: "1999-01-01T00:00:00.000Z"
    });
    expect(tokenA).toBeDefined();
    const tokenB = await lease.acquire({
      runId: "run-1",
      ownerId: "worker-B",
      leaseUntil: "2099-01-01T00:00:00.000Z"
    });
    expect(tokenB).toBeDefined();
    const okA = await lease.renew({
      runId: "run-1",
      ownerId: "worker-A",
      leaseUntil: "2099-01-01T00:00:00.000Z"
    });
    expect(okA).toBe(false);
  });

  it("releases the lease so another worker can acquire", async () => {
    const lease = await createPostgresRunLease(pg);
    await lease.acquire({
      runId: "run-1",
      ownerId: "worker-A",
      leaseUntil: "2099-01-01T00:00:00.000Z"
    });
    await lease.release({ runId: "run-1", ownerId: "worker-A" });
    const tokenB = await lease.acquire({
      runId: "run-1",
      ownerId: "worker-B",
      leaseUntil: "2099-01-01T00:00:00.000Z"
    });
    expect(tokenB).toBeDefined();
    expect(tokenB?.ownerId).toBe("worker-B");
  });
});

describe("recovery worker (postgres-backed)", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    await createPostgresRunLease(pg);
  });

  it("resumes a run whose lease has expired (simulated worker crash)", async () => {
    // pg-boss recovery tracer bullet:Worker A 驱动到 perform 中途"崩溃"
    // (perform 长 await 无心跳续约,lease 过期),Worker B 的 recovery worker
    // 通过扫描过期 lease 发现该 Run,调用 resumer.resume 接管。
    // 接管后 B 走 environment_offline 自动恢复 + 重新 prepare,完成 Run。
    const sharedStore = new InMemoryRunStore();
    const lease = await createPostgresRunLease(pg);
    let resolvePerform!: () => void;
    let performCount = 0;
    const environment: RunEnvironment = {
      prepare: async (spec) => ({
        id: `handle-${spec.runId}`,
        environmentId: spec.environmentId
      }),
      perform: async () => {
        performCount += 1;
        await new Promise<void>((resolve) => {
          resolvePerform = () => resolve();
        });
        return { exitCode: 0, stdout: "done", stderr: "" };
      },
      inspect: async () => ({ changedFiles: ["src/fix.ts"] }),
      dispose: async () => {}
    };
    const modelA = {
      next: async () => ({
        type: "tool_call" as const,
        callId: "call-1",
        tool: "execute_command" as const,
        arguments: { argv: ["echo", "hello"] }
      })
    };
    const modelB = {
      next: async () => ({
        type: "completed" as const,
        summary: "B took over and finished"
      })
    };

    const harnessA = await createTestHarness({
      lease,
      model: modelA,
      environment,
      workerId: "worker-A",
      leaseMilliseconds: 20,
      store: sharedStore,
      verificationOutcome: "passed",
      // 模拟 worker-A "进程崩溃":其 heartbeat 不再续约。
      // 此时 perform 挂起在长 await 上,lease 于 20ms 后自然过期,
      // recovery worker 就能扫描到并交给 B 接管。
      heartbeat: {
        withHeartbeat: async (_token, _intervalMs, fn) => fn()
      }
    });
    const harnessB = await createTestHarness({
      lease,
      model: modelB,
      environment,
      workerId: "worker-B",
      store: sharedStore,
      verificationOutcome: "passed"
    });

    const runId = await harnessA.engine.start({
      projectId: "project-1",
      environmentId: "environment-1",
      task: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      approvalMode: "full_access",
      fileAccessScope: "workspace_only"
    });

    // A 启动 resume,挂在 perform 上
    const resumeA = harnessA.engine.resume(runId);
    // 等 perform 进入(已过 prepare / running / tool_call turn 启动)
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(performCount).toBe(1);

    // 不 resolve perform——模拟 A 崩溃在 perform 上
    // (harnessA 心跳不续约,lease 自然过期)
    await new Promise<void>((resolve) => setTimeout(resolve, 80));

    // B 的 recovery worker 每 20ms 扫一次
    const worker = createIntervalRecoveryWorker({
      executor: pg,
      resumer: harnessB.engine,
      intervalMs: 20
    });
    worker.start();

    // 等待 recovery worker 检测到过期 lease 并触发 resume,
    // 最终 Run 走到终态
    const deadline = Date.now() + 2000;
    let finalStatus = "";
    while (Date.now() < deadline) {
      const view = await harnessB.engine.inspect(runId);
      if (view.status === "succeeded" || view.status === "failed") {
        finalStatus = view.status;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    }
    await worker.stop();

    expect(finalStatus).toBe("succeeded");

    // 让 A 的 perform 完成,使其能从 await 中退出(验证失租后静默放弃)
    resolvePerform();
    await expect(resumeA).resolves.not.toThrow();

    expect(performCount).toBe(1); // A 一次 perform,B 走 completed 模型无 perform
  });
});
