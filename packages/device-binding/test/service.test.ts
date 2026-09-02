import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryDeviceBindingStore,
  createDeviceBindingService,
  DeviceBindingError,
  type DeviceBindingStore
} from "../src/index.js";

function createStore(): DeviceBindingStore {
  return createInMemoryDeviceBindingStore();
}

/**
 * Mutable clock so a test can advance the wall clock mid-run. A closure
 * pattern is used so the service always reads the *current* value, not the
 * one captured at construction time.
 */
function makeClock(initial: string): {
  now: () => Date;
  setTo: (iso: string) => void;
} {
  let current = new Date(initial);
  return {
    now: () => new Date(current.getTime()),
    setTo: (iso) => {
      current = new Date(iso);
    }
  };
}

describe("DeviceBindingService", () => {
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    clock = makeClock("2026-08-31T10:00:00.000Z");
  });

  afterEach(() => {
    // no fake timers in use; this is a no-op placeholder for symmetry.
  });

  function makeService(store = createStore()) {
    return createDeviceBindingService({ store, now: clock.now });
  }

  it("issues a code that the same user can exchange for a 24-hour device credential", async () => {
    const store = createStore();
    const service = makeService(store);
    const issued = await service.issueCode({
      userId: "user-1",
      email: "alice@example.com",
      projectId: "project-1",
      projectName: "Project One",
      ttlMs: 10 * 60_000
    });
    expect(issued.code).toMatch(/^[A-Z2-9]{9}$/);
    expect(issued.payload).toContain(issued.code);
    expect(issued.expiresAt).toBe("2026-08-31T10:10:00.000Z");

    const exchanged = await service.exchangeCode({
      code: issued.code,
      deviceLabel: "Alice's laptop",
      platform: "darwin"
    });
    expect(exchanged).toMatchObject({
      userId: "user-1",
      email: "alice@example.com",
      projectId: "project-1",
      projectName: "Project One",
      deviceLabel: "Alice's laptop",
      platform: "darwin"
    });
    expect(exchanged.deviceId).toMatch(/^[a-f0-9-]{36}$/);
    expect(exchanged.accessToken).toMatch(/^[a-f0-9]{64}$/);
    expect(exchanged.expiresAt).toBe("2026-09-01T10:00:00.000Z");
  });

  it("refuses to reuse a code after exchange (one-time use)", async () => {
    const service = makeService();
    const issued = await service.issueCode({
      userId: "user-1",
      email: "alice@example.com",
      projectId: "project-1",
      projectName: "Project One",
      ttlMs: 10 * 60_000
    });
    await service.exchangeCode({ code: issued.code });
    await expect(
      service.exchangeCode({ code: issued.code })
    ).rejects.toMatchObject({ code: "code_consumed" });
  });

  it("refuses an unknown or expired code", async () => {
    const service = makeService();
    await expect(
      service.exchangeCode({ code: "NOPE-NOPE" })
    ).rejects.toMatchObject({ code: "code_unknown" });

    const issued = await service.issueCode({
      userId: "user-1",
      email: "alice@example.com",
      projectId: "project-1",
      projectName: "Project One",
      ttlMs: 60_000
    });
    clock.setTo("2026-08-31T10:01:30.000Z");
    await expect(
      service.exchangeCode({ code: issued.code })
    ).rejects.toMatchObject({ code: "code_expired" });
  });

  it("rejects codes submitted with the wrong format before any storage hit", async () => {
    const service = makeService();
    await expect(
      service.exchangeCode({ code: "abc" })
    ).rejects.toMatchObject({ code: "code_unknown" });
  });

  it("lists every active device belonging to a user, ordered by most recently used", async () => {
    const service = makeService();
    const codeA = await service.issueCode({
      userId: "user-1",
      email: "alice@example.com",
      projectId: "project-1",
      projectName: "Project One",
      ttlMs: 60_000
    });
    const codeB = await service.issueCode({
      userId: "user-1",
      email: "alice@example.com",
      projectId: "project-1",
      projectName: "Project One",
      ttlMs: 60_000
    });
    const deviceA = await service.exchangeCode({ code: codeA.code });
    const deviceB = await service.exchangeCode({ code: codeB.code });
    clock.setTo("2026-08-31T10:05:00.000Z");
    await service.touchDevice(deviceB.deviceId);

    const list = await service.listDevicesForUser("user-1");
    expect(list.map((entry) => entry.deviceId)).toEqual([
      deviceB.deviceId,
      deviceA.deviceId
    ]);
    expect(list[0]?.lastUsedAt).toBe("2026-08-31T10:05:00.000Z");
    expect(list[1]?.lastUsedAt).toBe("2026-08-31T10:00:00.000Z");
  });

  it("scopes listDevicesForUser to the caller only", async () => {
    const service = makeService();
    const codeA = await service.issueCode({
      userId: "user-1",
      email: "alice@example.com",
      projectId: "project-1",
      projectName: "Project One",
      ttlMs: 60_000
    });
    const codeB = await service.issueCode({
      userId: "user-2",
      email: "bob@example.com",
      projectId: "project-1",
      projectName: "Project One",
      ttlMs: 60_000
    });
    await service.exchangeCode({ code: codeA.code });
    await service.exchangeCode({ code: codeB.code });

    const aliceDevices = await service.listDevicesForUser("user-1");
    expect(aliceDevices).toHaveLength(1);
    expect(aliceDevices[0]?.email).toBe("alice@example.com");
  });

  it("revokes a device so its access token no longer authenticates", async () => {
    const service = makeService();
    const issued = await service.issueCode({
      userId: "user-1",
      email: "alice@example.com",
      projectId: "project-1",
      projectName: "Project One",
      ttlMs: 60_000
    });
    const exchanged = await service.exchangeCode({ code: issued.code });
    const principal = await service.authenticate({
      accessToken: exchanged.accessToken
    });
    expect(principal).toMatchObject({ userId: "user-1" });

    await service.revokeDevice({
      userId: "user-1",
      deviceId: exchanged.deviceId
    });

    await expect(
      service.authenticate({ accessToken: exchanged.accessToken })
    ).rejects.toMatchObject({ code: "device_unknown" });
    await expect(
      service.listDevicesForUser("user-1")
    ).resolves.toEqual([]);
  });

  it("rejects revokeDevice when the device belongs to a different user", async () => {
    const service = makeService();
    const issued = await service.issueCode({
      userId: "user-1",
      email: "alice@example.com",
      projectId: "project-1",
      projectName: "Project One",
      ttlMs: 60_000
    });
    const exchanged = await service.exchangeCode({ code: issued.code });
    await expect(
      service.revokeDevice({
        userId: "user-2",
        deviceId: exchanged.deviceId
      })
    ).rejects.toMatchObject({ code: "device_unknown" });
  });

  it("rejects unknown or expired access tokens at authenticate", async () => {
    const service = makeService();
    await expect(
      service.authenticate({ accessToken: "x".repeat(64) })
    ).rejects.toMatchObject({ code: "device_unknown" });

    const issued = await service.issueCode({
      userId: "user-1",
      email: "alice@example.com",
      projectId: "project-1",
      projectName: "Project One",
      ttlMs: 60_000
    });
    const exchanged = await service.exchangeCode({ code: issued.code });
    clock.setTo("2026-09-01T11:00:00.000Z");
    await expect(
      service.authenticate({ accessToken: exchanged.accessToken })
    ).rejects.toMatchObject({ code: "device_expired" });
  });

  it("does not let exchangeCode provision a second device if the same code is replayed under a different label", async () => {
    const service = makeService();
    const issued = await service.issueCode({
      userId: "user-1",
      email: "alice@example.com",
      projectId: "project-1",
      projectName: "Project One",
      ttlMs: 60_000
    });
    const device = await service.exchangeCode({
      code: issued.code,
      deviceLabel: "first"
    });
    await expect(
      service.exchangeCode({
        code: issued.code,
        deviceLabel: "second"
      })
    ).rejects.toMatchObject({ code: "code_consumed" });
    const list = await service.listDevicesForUser("user-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.deviceLabel).toBe("first");
    expect(list[0]?.deviceId).toBe(device.deviceId);
  });

  it("sanitises a suspicious device label before storage", async () => {
    const service = makeService();
    const issued = await service.issueCode({
      userId: "user-1",
      email: "alice@example.com",
      projectId: "project-1",
      projectName: "Project One",
      ttlMs: 60_000
    });
    const exchanged = await service.exchangeCode({
      code: issued.code,
      deviceLabel: "   \u0000hax\tlabel   "
    });
    const [stored] = await service.listDevicesForUser("user-1");
    expect(stored?.deviceId).toBe(exchanged.deviceId);
    // control chars are replaced with single spaces and whitespace is collapsed;
    // edge whitespace is trimmed so the label can be safely rendered in HTML.
    expect(stored?.deviceLabel).toBe("hax label");
    expect(stored?.deviceLabel).not.toContain("\u0000");
    expect(stored?.deviceLabel).not.toContain("\t");
  });

  it("bounds the maximum number of live codes per user", async () => {
    const service = createDeviceBindingService({
      store: createStore(),
      now: clock.now,
      maxLiveCodesPerUser: 2
    });
    const issue = () =>
      service.issueCode({
        userId: "user-1",
        email: "alice@example.com",
        projectId: "project-1",
        projectName: "Project One",
        ttlMs: 60_000
      });
    await issue();
    await issue();
    await expect(issue()).rejects.toMatchObject({ code: "too_many_codes" });
  });

  it("exposes the typed DeviceBindingError surface", () => {
    expect(new DeviceBindingError("code_expired", "expired")).toMatchObject({
      code: "code_expired",
      message: "expired"
    });
  });

  it("uses the service-injected clock for live-code expiry rather than wall-clock time", async () => {
    // M0.1: the in-memory store used to read `new Date()` internally, which
    // made the live-code count depend on the host's real time. The injected
    // service clock must be the single source of truth for expiry.
    // Seed the store with a known, already-expired code via the public API.
    const store = createStore();
    const expiredService = createDeviceBindingService({
      store,
      now: () => new Date("1970-01-01T00:00:00.000Z"),
      maxLiveCodesPerUser: 16
    });
    await expiredService.issueCode({
      userId: "user-1",
      email: "alice@example.com",
      projectId: "project-1",
      projectName: "Project One",
      ttlMs: 60_000
    });
    // Now build a service whose clock is fixed in the future; the expired
    // seed record must NOT count toward the budget because the *injected*
    // clock says it expired long ago.
    const service = createDeviceBindingService({
      store,
      now: clock.now,
      maxLiveCodesPerUser: 1
    });
    await expect(
      service.issueCode({
        userId: "user-1",
        email: "alice@example.com",
        projectId: "project-1",
        projectName: "Project One",
        ttlMs: 60_000
      })
    ).resolves.toMatchObject({ code: expect.any(String) });
    // The second issuance must hit the cap because the first is live.
    await expect(
      service.issueCode({
        userId: "user-1",
        email: "alice@example.com",
        projectId: "project-1",
        projectName: "Project One",
        ttlMs: 60_000
      })
    ).rejects.toMatchObject({ code: "too_many_codes" });
  });

  it("never lets concurrent issueCode calls exceed the live-code limit", async () => {
    const service = createDeviceBindingService({
      store: createStore(),
      now: clock.now,
      maxLiveCodesPerUser: 4
    });
    const issue = () =>
      service.issueCode({
        userId: "user-1",
        email: "alice@example.com",
        projectId: "project-1",
        projectName: "Project One",
        ttlMs: 60_000
      });
    // Issue 6 codes concurrently against a limit of 4: exactly 4 must
    // succeed and the rest must surface `too_many_codes` — the previous
    // read-then-insert design could leak up to 2*N-1 codes on contention.
    const results = await Promise.allSettled([
      issue(),
      issue(),
      issue(),
      issue(),
      issue(),
      issue()
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );
    expect(fulfilled).toHaveLength(4);
    expect(rejected).toHaveLength(2);
    for (const rejection of rejected) {
      expect(rejection.reason).toMatchObject({ code: "too_many_codes" });
    }
  });

  it("retries when a randomly generated code collides with an existing one", async () => {
    // Inject a custom store that reports a hash conflict on the first
    // reservation attempt and then succeeds. The service must retry with
    // a freshly generated code and ultimately issue a different value.
    let attempts = 0;
    const seenHashes = new Set<string>();
    const collidingStore: DeviceBindingStore = {
      ...createStore(),
      async reserveCodeSlot(candidate, options) {
        attempts += 1;
        seenHashes.add(candidate.codeHash);
        if (attempts === 1) {
          return { ok: false, reason: "code_hash_conflict" };
        }
        return {
          ok: true,
          reservation: {
            codeHash: candidate.codeHash,
            userId: candidate.userId,
            email: candidate.email,
            projectId: candidate.projectId,
            projectName: candidate.projectName,
            expiresAt: new Date(options.now.getTime() + options.ttlMs).toISOString()
          }
        };
      }
    };
    const service = createDeviceBindingService({
      store: collidingStore,
      now: clock.now,
      maxCodeGenerationRetries: 4
    });
    const issued = await service.issueCode({
      userId: "user-1",
      email: "alice@example.com",
      projectId: "project-1",
      projectName: "Project One",
      ttlMs: 60_000
    });
    expect(attempts).toBe(2);
    expect(seenHashes.size).toBe(2);
    expect(issued.code).toMatch(/^[A-Z2-9]{9}$/);
  });

  it("surfaces a deterministic exhausted-retry error after too many collisions", async () => {
    // A store that *always* reports a hash conflict, no matter what hash
    // the service tries. The service must exhaust its retry budget and
    // surface a `code_collision_exhausted` error.
    const alwaysConflictStore: DeviceBindingStore = {
      ...createStore(),
      async reserveCodeSlot() {
        return { ok: false, reason: "code_hash_conflict" };
      }
    };
    const service = createDeviceBindingService({
      store: alwaysConflictStore,
      now: clock.now,
      maxCodeGenerationRetries: 3
    });
    await expect(
      service.issueCode({
        userId: "user-1",
        email: "alice@example.com",
        projectId: "project-1",
        projectName: "Project One",
        ttlMs: 60_000
      })
    ).rejects.toMatchObject({ code: "code_collision_exhausted" });
  });
});