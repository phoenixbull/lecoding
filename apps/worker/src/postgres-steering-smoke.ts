import { randomUUID } from "node:crypto";
import type { ModelEnvironment } from "@lecoding/openai-model";
import { createPostgresRunSteerMailbox } from "@lecoding/run-engine";
import type { WorkerDatabase } from "./index.js";
import { createPostgresWorkerDatabase } from "./postgres-database.js";

/** Secret-free evidence for durable cross-Worker steering delivery. */
export interface PostgresSteeringSmokeReport {
  status: "passed";
  checks: {
    workerAdapters: 2;
    insertedMessages: 2;
    idempotentRetries: 1;
    replacementReadMessages: 2;
    cursorRemainingMessages: 1;
    durableSubmittedEvents: 2;
    isolatedFixtureCleanup: "complete";
  };
}

/** Database creation seam shared by the real command and compatible test. */
export interface PostgresSteeringSmokeOptions {
  environment: ModelEnvironment;
  createDatabase?: (environment: ModelEnvironment) => Promise<WorkerDatabase>;
}

/**
 * Writes through one mailbox adapter and reads through another, including the
 * command-id retry and event/outbox transaction, then removes the exact fixture.
 */
export async function runPostgresSteeringSmoke(
  options: PostgresSteeringSmokeOptions
): Promise<PostgresSteeringSmokeReport> {
  const backgroundErrors: unknown[] = [];
  const createDatabase =
    options.createDatabase ??
    ((environment: ModelEnvironment) =>
      createPostgresWorkerDatabase({
        environment,
        onUnexpectedError: (error) => backgroundErrors.push(error)
      }));
  const token = randomUUID().replaceAll("-", "");
  const runId = `smoke_steering_${token}`;
  const firstCommandId = `smoke-steering-first-${token}`;
  const secondCommandId = `smoke-steering-second-${token}`;
  const databases: WorkerDatabase[] = [];
  let fixtureCreated = false;
  let report: PostgresSteeringSmokeReport | undefined;
  let operationError: unknown;

  try {
    databases.push(await createDatabase(options.environment));
    databases.push(await createDatabase(options.environment));
    const now = () => new Date().toISOString();
    const writer = await createPostgresRunSteerMailbox({
      database: databases[0]!.executor,
      now
    });
    const replacement = await createPostgresRunSteerMailbox({
      database: databases[1]!.executor,
      now
    });

    const first = await writer.enqueue({
      runId,
      commandId: firstCommandId,
      message: "smoke-first"
    });
    fixtureCreated = true;
    const second = await writer.enqueue({
      runId,
      commandId: secondCommandId,
      message: "smoke-second"
    });
    const retry = await writer.enqueue({
      runId,
      commandId: firstCommandId,
      message: "smoke-first"
    });
    const byCommand = await replacement.getByCommandId(runId, firstCommandId);
    const allMessages = await replacement.readAfter(runId, 0, 20);
    const afterCursor = await replacement.readAfter(runId, first.sequence, 20);
    const durableEvents = await countDurableSubmittedEvents(
      databases[1]!,
      runId
    );

    if (
      !first.inserted ||
      !second.inserted ||
      second.sequence <= first.sequence ||
      retry.inserted ||
      retry.sequence !== first.sequence ||
      byCommand?.sequence !== first.sequence ||
      byCommand.message !== "smoke-first" ||
      allMessages.length !== 2 ||
      allMessages[0]?.message !== "smoke-first" ||
      allMessages[1]?.message !== "smoke-second" ||
      afterCursor.length !== 1 ||
      afterCursor[0]?.sequence !== second.sequence ||
      durableEvents !== 2 ||
      backgroundErrors.length > 0
    ) {
      throw new Error("PostgreSQL steering smoke invariants were not satisfied");
    }
    report = {
      status: "passed",
      checks: {
        workerAdapters: 2,
        insertedMessages: 2,
        idempotentRetries: 1,
        replacementReadMessages: 2,
        cursorRemainingMessages: 1,
        durableSubmittedEvents: 2,
        isolatedFixtureCleanup: "complete"
      }
    };
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors = await cleanupSteeringFixture(
    databases,
    runId,
    fixtureCreated
  );
  if (operationError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      "PostgreSQL steering smoke and cleanup failed"
    );
  }
  if (operationError) {
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "PostgreSQL steering cleanup failed");
  }
  return report!;
}

async function countDurableSubmittedEvents(
  database: WorkerDatabase,
  runId: string
): Promise<number> {
  const result = await database.executor.query<{ count: string | number }>(
    `
    SELECT COUNT(*)::integer AS count
    FROM run_events AS event
    INNER JOIN run_event_outbox AS outbox
      ON outbox.run_id = event.run_id
     AND outbox.event_sequence = event.sequence
    WHERE event.run_id = $1::text
      AND event.event_type = 'user_message_submitted';
    `,
    [runId]
  );
  return Number(result.rows[0]?.count);
}

async function cleanupSteeringFixture(
  databases: WorkerDatabase[],
  runId: string,
  fixtureCreated: boolean
): Promise<unknown[]> {
  const errors: unknown[] = [];
  const database = databases[0];
  if (database && fixtureCreated) {
    // Event deletion cascades to outbox before its per-Run counter is removed.
    for (const sql of [
      "DELETE FROM run_engine_steering_messages WHERE run_id = $1::text;",
      "DELETE FROM run_events WHERE run_id = $1::text;",
      "DELETE FROM run_event_counters WHERE run_id = $1::text;"
    ]) {
      await database.executor
        .query(sql, [runId])
        .catch((error) => errors.push(error));
    }
  }
  if (database && fixtureCreated && errors.length === 0) {
    const residue = await database.executor
      .query<{ remains: boolean }>(
        `
        SELECT
          EXISTS (
            SELECT 1 FROM run_engine_steering_messages WHERE run_id = $1::text
          ) OR EXISTS (
            SELECT 1 FROM run_events WHERE run_id = $1::text
          ) OR EXISTS (
            SELECT 1 FROM run_event_outbox WHERE run_id = $1::text
          ) OR EXISTS (
            SELECT 1 FROM run_event_counters WHERE run_id = $1::text
          ) AS remains;
        `,
        [runId]
      )
      .catch((error) => {
        errors.push(error);
        return undefined;
      });
    if (residue?.rows[0]?.remains) {
      errors.push(new Error("PostgreSQL steering smoke cleanup left residue"));
    }
  }
  for (const owned of databases) {
    await owned.close().catch((error) => errors.push(error));
  }
  return errors;
}
