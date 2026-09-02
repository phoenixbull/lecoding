import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  DEVICE_BINDING_SCHEMA_SQL,
  createPostgresDeviceBindingStore
} from "../src/postgres.js";

/**
 * These tests pin down the Postgres adapter's behaviour for the
 * `reserveCodeSlot` seam introduced in M0.1: the budget check and insert
 * must happen atomically, a hash collision must surface as a deterministic
 * reason rather than a thrown constraint error, and the in-flight code row
 * must use the service-supplied `now` rather than the database clock.
 */
describe("PostgreSQL device binding store", () => {
  async function freshStore() {
    const database = new PGlite();
    await database.exec(DEVICE_BINDING_SCHEMA_SQL);
    const store = createPostgresDeviceBindingStore(database);
    return { store, database };
  }

  it("reserves a slot using the caller-supplied now, not the database clock", async () => {
    const { store } = await freshStore();
    // Force a future expiry that the DB clock (2026-08-31) could not
    // produce on its own; if the store uses `now()` from PostgreSQL the
    // expiry would differ.
    const suppliedNow = new Date("2026-01-01T00:00:00.000Z");
    const result = await store.reserveCodeSlot(
      {
        codeHash: "hash-1",
        userId: "user-1",
        email: "alice@example.com",
        projectId: "project-1",
        projectName: "Project One"
      },
      {
        maxLiveCodesPerUser: 4,
        now: suppliedNow,
        ttlMs: 60_000
      }
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reservation.expiresAt).toBe(
        "2026-01-01T00:01:00.000Z"
      );
    }
  });

  it("surfaces too_many_codes when the user is at the live-code cap", async () => {
    const { store } = await freshStore();
    const suppliedNow = new Date("2026-08-31T10:00:00.000Z");
    for (let index = 0; index < 3; index += 1) {
      const ok = await store.reserveCodeSlot(
        {
          codeHash: `hash-${index}`,
          userId: "user-1",
          email: "alice@example.com",
          projectId: "project-1",
          projectName: "Project One"
        },
        { maxLiveCodesPerUser: 3, now: suppliedNow, ttlMs: 60_000 }
      );
      expect(ok.ok).toBe(true);
    }
    const over = await store.reserveCodeSlot(
      {
        codeHash: "hash-overflow",
        userId: "user-1",
        email: "alice@example.com",
        projectId: "project-1",
        projectName: "Project One"
      },
      { maxLiveCodesPerUser: 3, now: suppliedNow, ttlMs: 60_000 }
    );
    expect(over).toEqual({ ok: false, reason: "too_many_codes" });
  });

  it("surfaces code_hash_conflict when the candidate hash already exists", async () => {
    const { store } = await freshStore();
    const suppliedNow = new Date("2026-08-31T10:00:00.000Z");
    const first = await store.reserveCodeSlot(
      {
        codeHash: "duplicate-hash",
        userId: "user-1",
        email: "alice@example.com",
        projectId: "project-1",
        projectName: "Project One"
      },
      { maxLiveCodesPerUser: 4, now: suppliedNow, ttlMs: 60_000 }
    );
    expect(first.ok).toBe(true);
    const second = await store.reserveCodeSlot(
      {
        codeHash: "duplicate-hash",
        userId: "user-1",
        email: "alice@example.com",
        projectId: "project-1",
        projectName: "Project One"
      },
      { maxLiveCodesPerUser: 4, now: suppliedNow, ttlMs: 60_000 }
    );
    expect(second).toEqual({ ok: false, reason: "code_hash_conflict" });
  });

  it("treats expired rows as not counting toward the live budget", async () => {
    const { store } = await freshStore();
    const oldNow = new Date("2020-01-01T00:00:00.000Z");
    await store.reserveCodeSlot(
      {
        codeHash: "expired-hash",
        userId: "user-1",
        email: "alice@example.com",
        projectId: "project-1",
        projectName: "Project One"
      },
      { maxLiveCodesPerUser: 1, now: oldNow, ttlMs: 60_000 }
    );
    // Advance the injected clock well past the seed row's expiry; the
    // next reservation must succeed because the seed is no longer live.
    const newNow = new Date("2030-01-01T00:00:00.000Z");
    const result = await store.reserveCodeSlot(
      {
        codeHash: "fresh-hash",
        userId: "user-1",
        email: "alice@example.com",
        projectId: "project-1",
        projectName: "Project One"
      },
      { maxLiveCodesPerUser: 1, now: newNow, ttlMs: 60_000 }
    );
    expect(result.ok).toBe(true);
  });
});