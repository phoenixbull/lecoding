import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  RUN_EVENT_SCHEMA_SQL,
  createPostgresRunEventRepository,
  createPostgresRunOperationalActionRecorder,
  createPostgresRunOperationalMetricsReader,
  createRunEventJournal
} from "../src/index.js";

describe("PostgreSQL Run operational metrics", () => {
  it("derives status dwell and tool health from the durable event timeline", async () => {
    const database = new PGlite();
    await database.exec(RUN_EVENT_SCHEMA_SQL);
    await database.exec(`
      CREATE TABLE run_engine_approvals (
        id text PRIMARY KEY,
        run_id text NOT NULL,
        status text NOT NULL,
        decision text,
        decided_at timestamptz,
        created_at timestamptz NOT NULL
      );
      INSERT INTO run_engine_approvals
        (id, run_id, status, decision, decided_at, created_at)
      VALUES
        ('approval-1', 'run-metrics', 'decided', 'allow',
         '2026-08-28T08:00:09.000Z', '2026-08-28T08:00:07.000Z'),
        ('approval-2', 'run-metrics', 'decided', 'deny',
         '2026-08-28T08:00:10.000Z', '2026-08-28T08:00:08.000Z');
    `);
    await createPostgresRunOperationalActionRecorder(database);
    const timestamps = [
      "2026-08-28T08:00:00.000Z",
      "2026-08-28T08:00:01.000Z",
      "2026-08-28T08:00:03.000Z",
      "2026-08-28T08:00:04.000Z",
      "2026-08-28T08:00:06.000Z",
      "2026-08-28T08:00:07.000Z",
      "2026-08-28T08:00:10.000Z"
    ];
    const journal = createRunEventJournal({
      repository: createPostgresRunEventRepository(database),
      now: () => timestamps.shift()!
    });
    for (const event of [
      { type: "status_changed", data: { status: "queued" } },
      { type: "status_changed", data: { status: "preparing" } },
      { type: "status_changed", data: { status: "running" } },
      { type: "tool_started", data: { callId: "call-1", command: "pnpm" } },
      {
        type: "tool_completed",
        data: { callId: "call-1", outcome: "executed", exitCode: 1, outputTruncated: true }
      },
      { type: "status_changed", data: { status: "waiting_approval" } },
      { type: "status_changed", data: { status: "failed" } }
    ] as const) {
      await journal.publish({ runId: "run-metrics", ...event });
    }

    const metrics = await createPostgresRunOperationalMetricsReader(database, {
      now: () => "2026-08-28T08:00:10.000Z"
    }).read("run-metrics");

    expect(metrics).toEqual({
      runId: "run-metrics",
      observedAt: "2026-08-28T08:00:10.000Z",
      statusDwellMs: {
        queued: 1_000,
        preparing: 2_000,
        running: 4_000,
        waiting_approval: 3_000
      },
      tools: {
        total: 1,
        failed: 1,
        totalDurationMs: 2_000,
        outputTruncated: 1
      },
      approvals: {
        requested: 2,
        decided: 2,
        denied: 1,
        totalWaitMs: 4_000
      },
      userActions: { steers: 0, answers: 0, cancellations: 0, keeps: 0, discards: 0 },
      worktree: { created: true, disposition: "unresolved", cleanupFailures: 0 },
      verification: { attempts: 0, passed: 0, failed: 0, inconclusive: 0 },
      failures: {}
    });
    await database.close();
  });

  it("counts user actions and idempotent worktree result decisions", async () => {
    const database = new PGlite();
    await database.exec(RUN_EVENT_SCHEMA_SQL);
    await database.exec(`
      CREATE TABLE run_engine_approvals (
        id text PRIMARY KEY,
        run_id text NOT NULL,
        status text NOT NULL,
        decision text,
        decided_at timestamptz,
        created_at timestamptz NOT NULL
      );
    `);
    const timestamps = [
      "2026-08-28T09:00:00.000Z",
      "2026-08-28T09:00:01.000Z",
      "2026-08-28T09:00:02.000Z",
      "2026-08-28T09:00:03.000Z"
    ];
    const journal = createRunEventJournal({
      repository: createPostgresRunEventRepository(database),
      now: () => timestamps.shift()!
    });
    await journal.publish({
      runId: "run-actions",
      type: "status_changed",
      data: { status: "preparing" }
    });
    await journal.publish({
      runId: "run-actions",
      type: "user_message_submitted",
      data: { mode: "steer" }
    });
    await journal.publish({
      runId: "run-actions",
      type: "user_message_submitted",
      data: { mode: "answer" }
    });
    await journal.publish({
      runId: "run-actions",
      type: "status_changed",
      data: { status: "cancelled" }
    });
    const actions = await createPostgresRunOperationalActionRecorder(database, {
      now: () => "2026-08-28T09:00:04.000Z"
    });
    await actions.recordResultFailure("run-actions", "discard");
    await actions.recordResultFailure("run-actions", "keep");
    await actions.recordResult("run-actions", "discard");
    await actions.recordResult("run-actions", "discard");

    await expect(
      createPostgresRunOperationalMetricsReader(database, {
        now: () => "2026-08-28T09:00:04.000Z"
      }).read("run-actions")
    ).resolves.toMatchObject({
      observedAt: "2026-08-28T09:00:04.000Z",
      userActions: { steers: 1, answers: 1, cancellations: 1, keeps: 0, discards: 1 },
      worktree: { created: true, disposition: "discarded", cleanupFailures: 1 }
    });
    await database.close();
  });

  it("includes live dwell time through the observation clock", async () => {
    const database = new PGlite();
    await database.exec(RUN_EVENT_SCHEMA_SQL);
    await database.exec(`
      CREATE TABLE run_engine_approvals (
        id text PRIMARY KEY,
        run_id text NOT NULL,
        status text NOT NULL,
        decision text,
        decided_at timestamptz,
        created_at timestamptz NOT NULL
      );
    `);
    await createPostgresRunOperationalActionRecorder(database);
    await createRunEventJournal({
      repository: createPostgresRunEventRepository(database),
      now: () => "2026-08-28T10:00:00.000Z"
    }).publish({
      runId: "run-live",
      type: "status_changed",
      data: { status: "running" }
    });

    const metrics = createPostgresRunOperationalMetricsReader(database, {
      now: () => "2026-08-28T10:00:10.000Z"
    });

    await expect(metrics.read("run-live")).resolves.toMatchObject({
      observedAt: "2026-08-28T10:00:10.000Z",
      statusDwellMs: { running: 10_000 }
    });
    await database.close();
  });

  it("derives live dwell from the injected observation clock when no real clock is provided", async () => {
    // M0.3: production callers are expected to inject the observation clock
    // so dwell does not depend on `new Date()`. The previous test asserted
    // that `observedAt` advanced past the seed event without injecting a
    // clock, which made the assertion environment-dependent.
    const database = new PGlite();
    await database.exec(RUN_EVENT_SCHEMA_SQL);
    await database.exec(`
      CREATE TABLE run_engine_approvals (
        id text PRIMARY KEY,
        run_id text NOT NULL,
        status text NOT NULL,
        decision text,
        decided_at timestamptz,
        created_at timestamptz NOT NULL
      );
    `);
    await createPostgresRunOperationalActionRecorder(database);
    await createRunEventJournal({
      repository: createPostgresRunEventRepository(database),
      now: () => "2000-01-01T00:00:00.000Z"
    }).publish({
      runId: "run-live-default-clock",
      type: "status_changed",
      data: { status: "running" }
    });

    const metrics = await createPostgresRunOperationalMetricsReader(database, {
      now: () => "2000-01-01T00:00:42.000Z"
    }).read("run-live-default-clock");

    expect(metrics!.observedAt).toBe("2000-01-01T00:00:42.000Z");
    expect(metrics!.statusDwellMs.running).toBe(42_000);
    await database.close();
  });

  it("classifies verification outcomes and stable Run failure codes", async () => {
    const database = new PGlite();
    await database.exec(RUN_EVENT_SCHEMA_SQL);
    await database.exec(`
      CREATE TABLE run_engine_approvals (
        id text PRIMARY KEY,
        run_id text NOT NULL,
        status text NOT NULL,
        decision text,
        decided_at timestamptz,
        created_at timestamptz NOT NULL
      );
    `);
    await createPostgresRunOperationalActionRecorder(database);
    let second = 0;
    const journal = createRunEventJournal({
      repository: createPostgresRunEventRepository(database),
      now: () => `2026-08-28T11:00:0${second++}.000Z`
    });
    for (const event of [
      { type: "status_changed", data: { status: "verifying" } },
      { type: "verification_completed", data: { outcome: "passed" } },
      { type: "verification_completed", data: { outcome: "failed" } },
      { type: "verification_completed", data: { outcome: "inconclusive" } },
      { type: "run_failed", data: { code: "agent_loop_failed", message: "secret detail" } },
      { type: "status_changed", data: { status: "failed" } }
    ] as const) {
      await journal.publish({ runId: "run-verification", ...event });
    }

    await expect(
      createPostgresRunOperationalMetricsReader(database).read("run-verification")
    ).resolves.toMatchObject({
      verification: { attempts: 3, passed: 1, failed: 1, inconclusive: 1 },
      failures: { agent_loop_failed: 1 }
    });
    await database.close();
  });
});
