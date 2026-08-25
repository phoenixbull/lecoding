/**
 * 真实跨 worker 进程 cancel 集成测试骨架(主通路 fanout):
 *
 * 已实测(PGlite 0.5.5):多个独立 PGlite 实例共享同一 dataDir 可同时
 * 打开,但**运行期数据与 NOTIFY 互不互通**——PGlite 是独立 WASM 内核,
 * 无 server/TCP 模式,无法用多实例模拟多 worker 共享同一 PG server。
 *
 * 因此本测试把一个 PGlite 实例当作"PG server",多个 cancelBus 实例
 * 各自注册独立 listen session——语义上等同于"两个 worker 进程共享同一
 * PG server"。PGlite 内多个 listen session 的 NOTIFY fanout 与真实
 * 多进程 PG 等价。
 *
 * 隔离边界的多实例场景见 pglite-multi-instance-cancel.test.ts。
 *
 * 关键可观察面:
 * 1. worker-A publish 后,worker-B 的 listen session 收到 NOTIFY。
 * 2. 多 session 派发互不干扰(一个 stop 后其他仍工作)。
 * 3. 多个 runId 串行 publish,所有 session 各自按序收到。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  createPostgresRunCancelBus,
  wrapPglite,
  type PostgresNotifiable
} from "../src/postgres-run-cancel-bus.js";

describe("PGlite multi-session cancel bus (cross-worker semantics)", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
  });

  afterEach(async () => {
    await pg.close();
  });

  it("delivers published runId to every listen session independently", async () => {
    /*
     * 核心跨 worker 语义:模拟两个 worker 各自 subscribe 同一个 channel,
     * worker-A publish 一个 runId,worker-A 与 worker-B 的 listen session
     * 都应收到——这是 PG NOTIFY 的 fanout 行为。
     *
     * 旧实现从未在多 session 下验证过——单测只覆盖了单一 session。
     */
    const busA = createPostgresRunCancelBus(wrapPglite(pg));
    const busB = createPostgresRunCancelBus(wrapPglite(pg));

    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const stopA = await busA.subscribe((runId) => {
      receivedA.push(runId);
    });
    const stopB = await busB.subscribe((runId) => {
      receivedB.push(runId);
    });

    await busA.publish("run-1");
    await busA.publish("run-2");

    /*
     * PG NOTIFY 派发是异步的——需让出事件循环等所有 session 收到。
     * 与 postgres-run-cancel-bus.test.ts 同样的等待窗口。
     */
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receivedA).toEqual(["run-1", "run-2"]);
    expect(receivedB).toEqual(["run-1", "run-2"]);

    await stopA();
    await stopB();
  });

  it("stopping one session does not affect others", async () => {
    /*
     * 多 worker 隔离语义:worker-A dispose() 后,worker-B 的 listen 仍生效。
     * 对应生产场景:worker-A 进程关闭,worker-B 进程继续接收 cancel。
     */
    const busA = createPostgresRunCancelBus(wrapPglite(pg));
    const busB = createPostgresRunCancelBus(wrapPglite(pg));

    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const stopA = await busA.subscribe((runId) => {
      receivedA.push(runId);
    });
    await busB.subscribe((runId) => {
      receivedB.push(runId);
    });

    await busA.publish("run-before-stopA");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(receivedA).toEqual(["run-before-stopA"]);
    expect(receivedB).toEqual(["run-before-stopA"]);

    await stopA();

    /*
     * worker-A 的 session 已 stop,但 publish 仍触发 NOTIFY;
     * worker-B 的 session 仍应收到。
     * worker-A 不应再收到,因为它的 listen 已 unlisten。
     */
    await busA.publish("run-after-stopA");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(receivedB).toEqual(["run-before-stopA", "run-after-stopA"]);
    expect(receivedA).toEqual(["run-before-stopA"]);
  });

  it("publish from session B reaches session A (双向 fanout)", async () => {
    /*
     * 任意 worker 的 publish 都能 fanout 到所有 worker——对称性。
     * 这是 PG NOTIFY 的"any session"语义,不是 PG client 角色区分。
     */
    const busA = createPostgresRunCancelBus(wrapPglite(pg));
    const busB = createPostgresRunCancelBus(wrapPglite(pg));

    const receivedA: string[] = [];
    const receivedB: string[] = [];
    await busA.subscribe((runId) => {
      receivedA.push(runId);
    });
    await busB.subscribe((runId) => {
      receivedB.push(runId);
    });

    await busB.publish("from-B");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receivedA).toEqual(["from-B"]);
    expect(receivedB).toEqual(["from-B"]);
  });
});