import { randomUUID } from "node:crypto";
import type { RunId } from "@lecoding/contracts";
import type { ModelEnvironment } from "@lecoding/openai-model";
import { createPostgresRunCancelBus } from "@lecoding/run-engine";
import {
  createPostgresWorkerDatabase,
  type PostgresWorkerDatabase
} from "./postgres-database.js";

/** Secret-free evidence for real cross-Worker cancel fanout and reconnect. */
export interface PostgresCancelSmokeReport {
  status: "passed";
  checks: {
    workerSessions: 2;
    initialFanoutRecipients: 2;
    publisherDirections: 2;
    disconnectedListener: "reconnected";
    postReconnectRecipients: 2;
  };
}

/** Database creation seam shared by the real command and contract test. */
export interface PostgresCancelSmokeOptions {
  environment: ModelEnvironment;
  createDatabase?: (
    environment: ModelEnvironment
  ) => Promise<PostgresWorkerDatabase>;
}

/**
 * Proves bidirectional NOTIFY fanout, then ends one owned LISTEN session and
 * proves the cancel bus re-LISTENs without restarting its query Pool.
 */
export async function runPostgresCancelSmoke(
  options: PostgresCancelSmokeOptions
): Promise<PostgresCancelSmokeReport> {
  const backgroundErrors: unknown[] = [];
  const createDatabase =
    options.createDatabase ??
    ((environment: ModelEnvironment) =>
      createPostgresWorkerDatabase({
        environment,
        onUnexpectedError: (error) => backgroundErrors.push(error)
      }));
  const databases: PostgresWorkerDatabase[] = [];
  const stopSubscriptions: Array<() => void | Promise<void>> = [];
  const received = [new Set<RunId>(), new Set<RunId>()];
  let report: PostgresCancelSmokeReport | undefined;
  let operationError: unknown;

  try {
    databases.push(await createDatabase(options.environment));
    databases.push(await createDatabase(options.environment));
    const buses = databases.map((database) =>
      createPostgresRunCancelBus(database.notifications)
    );
    for (const [index, bus] of buses.entries()) {
      stopSubscriptions.push(
        await bus.subscribe((runId) => {
          received[index]!.add(runId);
        })
      );
    }

    const beforeDisconnect = smokeRunId("before");
    await buses[0]!.publish(beforeDisconnect);
    await waitForRecipients(received, beforeDisconnect, 2);

    // End only Worker A's dedicated listener; its Pool and Worker B stay online.
    await databases[0]!.disconnectNotifications();
    const afterReconnect = smokeRunId("after");
    await publishUntilRecipients(buses[1]!, received, afterReconnect, 2);
    if (backgroundErrors.length > 0) {
      throw new Error("PostgreSQL cancel smoke observed a background failure");
    }
    report = {
      status: "passed",
      checks: {
        workerSessions: 2,
        initialFanoutRecipients: 2,
        publisherDirections: 2,
        disconnectedListener: "reconnected",
        postReconnectRecipients: 2
      }
    };
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  for (const stop of stopSubscriptions) {
    await Promise.resolve(stop()).catch((error) => cleanupErrors.push(error));
  }
  for (const database of databases) {
    await database.close().catch((error) => cleanupErrors.push(error));
  }
  if (operationError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      "PostgreSQL cancel smoke and cleanup failed"
    );
  }
  if (operationError) {
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "PostgreSQL cancel smoke cleanup failed");
  }
  return report!;
}

function smokeRunId(stage: "before" | "after"): RunId {
  return `smoke_cancel_${stage}_${randomUUID().replaceAll("-", "")}`;
}

async function publishUntilRecipients(
  bus: ReturnType<typeof createPostgresRunCancelBus>,
  received: ReadonlyArray<ReadonlySet<RunId>>,
  runId: RunId,
  expected: number
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (countRecipients(received, runId) < expected && Date.now() < deadline) {
    /* NOTIFY sent before re-LISTEN is intentionally lost, so retry the smoke ID. */
    await bus.publish(runId);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  await waitForRecipients(received, runId, expected);
}

async function waitForRecipients(
  received: ReadonlyArray<ReadonlySet<RunId>>,
  runId: RunId,
  expected: number
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (countRecipients(received, runId) < expected && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  if (countRecipients(received, runId) !== expected) {
    throw new Error("PostgreSQL cancel signal did not reach every Worker session");
  }
}

function countRecipients(
  received: ReadonlyArray<ReadonlySet<RunId>>,
  runId: RunId
): number {
  return received.filter((runIds) => runIds.has(runId)).length;
}
