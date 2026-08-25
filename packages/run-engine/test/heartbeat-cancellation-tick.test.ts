/**
 * Phase-0 risk 1 收尾:心跳兜底检测终态取消。
 *
 * PG LISTEN/NOTIFY 是低延迟触发器——但连接断开或 NOTIFY 漏派期间,
 * worker 不应等到 lease 过期才发现 run 已 cancelled。
 * heartbeat 在每次 renewLease 间隔调 onTick,RunEngine 内部把
 * "查 store + 调 handles.abort"装进 onTick——任何 store 写入 cancelled
 * 都会在 leaseMilliseconds/2 间隔内被检出。
 *
 * 关键可观察面:
 * 1. heartbeat 在 tick 间隔调 onTick
 * 2. fn 完成后不再调 onTick
 * 3. onTick 抛错不应影响 fn 结果(隔离 errors)
 *
 * 测试针对 LeaseHeartbeat seam:把 onTick 暴露成可选参数,
 * createIntervalLeaseHeartbeat 实现应支持。
 */
import { describe, it, expect } from "vitest";
import { createIntervalLeaseHeartbeat } from "../src/index.js";
import type { RunLease, RunLeaseToken } from "@lecoding/contracts";

function createStubLease(): RunLease {
  return {
    async acquire() {
      return undefined;
    },
    async renew() {
      return true;
    },
    async release() {},
    async invalidate() {}
  };
}

describe("LeaseHeartbeat with onTick cancellation check", () => {
  it("invokes onTick at every renew interval during fn execution", async () => {
    /*
     * 关键可观察面:fn 在 await 期间,heartbeat 每隔 intervalMs 调一次 onTick。
     * 这正是 PG NOTIFY 丢失的兜底机制——store 状态变更后,
     * 最迟 leaseMilliseconds/2 内被 onTick 检出。
     */
    const lease = createStubLease();
    const heartbeat = createIntervalLeaseHeartbeat(lease);
    const token = {} as RunLeaseToken;
    const tickCalls: number[] = [];
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });

    const fnPromise = heartbeat.withHeartbeat(
      token,
      50, // 50ms tick interval
      async () => {
        start();
        // 等待足够多的 tick
        await new Promise((resolve) => setTimeout(resolve, 230));
        return "done";
      },
      async () => {
        tickCalls.push(Date.now());
      }
    );

    await started;
    const result = await fnPromise;

    expect(result).toBe("done");
    /*
     * 230ms / 50ms = 4-5 个 tick——允许 ±1 抖动
     */
    expect(tickCalls.length).toBeGreaterThanOrEqual(3);
    expect(tickCalls.length).toBeLessThanOrEqual(6);
  });

  it("does not invoke onTick after fn resolves", async () => {
    /*
     * 关闭语义:fn 完成后,onTick 不应再被调——避免 zombie tick。
     */
    const lease = createStubLease();
    const heartbeat = createIntervalLeaseHeartbeat(lease);
    const token = {} as RunLeaseToken;
    let tickCount = 0;
    await heartbeat.withHeartbeat(
      token,
      30,
      async () => {
        // fn 立即 resolve
        return "fast";
      },
      async () => {
        tickCount += 1;
      }
    );
    /*
     * 等一个 tick 间隔,确保没有残留 tick
     */
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(tickCount).toBe(0);
  });

  it("isolates onTick errors from fn result", async () => {
    /*
     * 错误隔离:onTick 抛错不应让 fn reject——onTick 是"额外观察",
     * 失败应被吞,不污染主路径。
     */
    const lease = createStubLease();
    const heartbeat = createIntervalLeaseHeartbeat(lease);
    const token = {} as RunLeaseToken;
    let tickCount = 0;
    const result = await heartbeat.withHeartbeat(
      token,
      30,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return "success";
      },
      async () => {
        tickCount += 1;
        throw new Error("tick failure (simulated)");
      }
    );
    expect(result).toBe("success");
    expect(tickCount).toBeGreaterThanOrEqual(2);
  });

  it("absent onTick does not change heartbeat behavior", async () => {
    /*
     * 向后兼容:不传 onTick 时心跳守护器仍正常工作(renewLease 持续到 fn 完成)。
     */
    const lease = createStubLease();
    const heartbeat = createIntervalLeaseHeartbeat(lease);
    const token = {} as RunLeaseToken;
    const result = await heartbeat.withHeartbeat(token, 30, async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return "ok";
    });
    expect(result).toBe("ok");
  });
});