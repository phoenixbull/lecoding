import { describe, expect, it } from "vitest";
import { createBackoff, createHeartbeatMonitor } from "../src/reconnect.js";

describe("createBackoff", () => {
  it("starts at the base delay and grows exponentially", () => {
    // Jitter disabled so the sequence is exactly predictable.
    const backoff = createBackoff({ baseDelayMs: 500, factor: 2, jitter: 0 });
    expect(backoff.delayFor(0)).toBe(500);
    expect(backoff.delayFor(1)).toBe(1_000);
    expect(backoff.delayFor(2)).toBe(2_000);
    expect(backoff.delayFor(3)).toBe(4_000);
  });

  it("never exceeds the maximum delay", () => {
    const backoff = createBackoff({ baseDelayMs: 1_000, maxDelayMs: 5_000, jitter: 0 });
    expect(backoff.delayFor(0)).toBe(1_000);
    expect(backoff.delayFor(10)).toBe(5_000);
    expect(backoff.delayFor(1_000)).toBe(5_000);
  });

  it("applies jitter symmetrically around the computed delay", () => {
    // A fixed random source makes jitter deterministic; 0.5 must be neutral.
    const backoff = createBackoff({ baseDelayMs: 1_000, jitter: 0.2, random: () => 0.5 });
    expect(backoff.delayFor(0)).toBe(1_000);
  });

  it("spreads retries within the jitter band", () => {
    const backoff = createBackoff({ baseDelayMs: 1_000, jitter: 0.2, random: () => 0 });
    expect(backoff.delayFor(0)).toBe(800);

    const high = createBackoff({ baseDelayMs: 1_000, jitter: 0.2, random: () => 1 });
    expect(high.delayFor(0)).toBe(1_200);
  });

  it("keeps jittered delays non-negative and within the cap", () => {
    const backoff = createBackoff({
      baseDelayMs: 1_000,
      maxDelayMs: 2_000,
      jitter: 0.5,
      random: () => 0
    });
    // 1000 * (1 - 0.5) = 500, and the cap must still bind after jitter.
    expect(backoff.delayFor(0)).toBe(500);
    expect(backoff.delayFor(5)).toBeLessThanOrEqual(2_000);
    expect(backoff.delayFor(5)).toBeGreaterThan(0);
  });

  it("rounds to whole milliseconds", () => {
    const backoff = createBackoff({ baseDelayMs: 333, factor: 1.5, jitter: 0.3 });
    const delay = backoff.delayFor(2);
    expect(Number.isInteger(delay)).toBe(true);
  });

  it("treats a negative attempt as the first attempt", () => {
    const backoff = createBackoff({ baseDelayMs: 500, jitter: 0 });
    expect(backoff.delayFor(-3)).toBe(500);
  });

  it("uses a bounded multiplier so the delay cannot overflow at huge attempts", () => {
    const backoff = createBackoff({ baseDelayMs: 1_000, maxDelayMs: 30_000, jitter: 0 });
    expect(backoff.delayFor(1e9)).toBe(30_000);
  });
});

describe("createHeartbeatMonitor", () => {
  const start = 1_000_000;
  const options = { heartbeatIntervalMs: 1_000, timeoutFactor: 2, now: () => start };

  it("is not timed out while the peer is active", () => {
    const monitor = createHeartbeatMonitor(options);
    expect(monitor.isTimedOut()).toBe(false);
    expect(monitor.idleMs()).toBe(0);
  });

  it("times out once the peer has been silent past the timeout window", () => {
    let now = start;
    const monitor = createHeartbeatMonitor({ ...options, now: () => now });

    now += 1_999;
    expect(monitor.isTimedOut()).toBe(false);

    // Timeout is 2x the interval: one missed heartbeat is tolerated, two are not.
    now += 2;
    expect(monitor.idleMs()).toBe(2_001);
    expect(monitor.isTimedOut()).toBe(true);
  });

  it("treats any inbound frame as liveness, not just heartbeats", () => {
    // A busy Runner sending results is obviously alive; requiring heartbeat
    // frames specifically would add traffic for no signal.
    let now = start;
    const monitor = createHeartbeatMonitor({ ...options, now: () => now });

    now += 1_500;
    monitor.noteActivity();
    expect(monitor.idleMs()).toBe(0);
    expect(monitor.isTimedOut()).toBe(false);
  });

  it("reports when the next heartbeat is due", () => {
    let now = start;
    const monitor = createHeartbeatMonitor({ ...options, now: () => now });

    expect(monitor.msUntilNextHeartbeat()).toBe(1_000);
    now += 400;
    expect(monitor.msUntilNextHeartbeat()).toBe(600);
    now += 600;
    expect(monitor.msUntilNextHeartbeat()).toBe(0);
  });

  it("reschedules the next heartbeat after sending one", () => {
    let now = start;
    const monitor = createHeartbeatMonitor({ ...options, now: () => now });

    now += 900;
    monitor.noteHeartbeatSent();
    expect(monitor.msUntilNextHeartbeat()).toBe(1_000);
  });

  it("keeps the heartbeat due time stable when inbound frames arrive", () => {
    // Inbound activity must not delay our own outbound heartbeat, or a quiet
    // peer could keep pushing it back and liveness would go untested.
    let now = start;
    const monitor = createHeartbeatMonitor({ ...options, now: () => now });

    now += 500;
    monitor.noteActivity();
    expect(monitor.msUntilNextHeartbeat()).toBe(500);
  });

  it("defaults to a 15s interval and a 2x timeout", () => {
    let now = start;
    const monitor = createHeartbeatMonitor({ now: () => now });
    expect(monitor.msUntilNextHeartbeat()).toBe(15_000);

    now += 29_999;
    expect(monitor.isTimedOut()).toBe(false);
    now += 2;
    expect(monitor.isTimedOut()).toBe(true);
  });
});
