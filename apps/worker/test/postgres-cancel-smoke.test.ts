import { describe, expect, it } from "vitest";
import type { PostgresNotifiable } from "@lecoding/run-engine";
import type { PostgresWorkerDatabase } from "../src/postgres-database.js";
import { runPostgresCancelSmoke } from "../src/postgres-cancel-smoke.js";

describe("PostgreSQL cross-Worker cancel smoke", () => {
  it("restores fanout after one owned LISTEN session disconnects", async () => {
    const listeners = new Set<(payload: string) => void>();
    const createDatabase = async (): Promise<PostgresWorkerDatabase> => {
      const ownedListeners = new Set<(payload: string) => void>();
      const disconnectHandlers = new Set<() => void>();
      const notifications: PostgresNotifiable = {
        async query<Row extends Record<string, unknown>>(
          _sql: string,
          parameters?: unknown[]
        ) {
          const payload = parameters?.[1];
          if (typeof payload === "string") {
            for (const listener of listeners) {
              listener(payload);
            }
          }
          return { rows: [] as Row[] };
        },
        async listen(_channel, callback) {
          listeners.add(callback);
          ownedListeners.add(callback);
          return async () => {
            listeners.delete(callback);
            ownedListeners.delete(callback);
          };
        },
        onClientDisconnect(handler) {
          disconnectHandlers.add(handler);
          return () => disconnectHandlers.delete(handler);
        }
      };
      return {
        executor: notifications,
        notifications,
        async disconnectNotifications() {
          for (const listener of ownedListeners) {
            listeners.delete(listener);
          }
          ownedListeners.clear();
          for (const handler of disconnectHandlers) {
            handler();
          }
        },
        async close() {
          for (const listener of ownedListeners) {
            listeners.delete(listener);
          }
        }
      };
    };

    await expect(
      runPostgresCancelSmoke({ environment: {}, createDatabase })
    ).resolves.toEqual({
      status: "passed",
      checks: {
        workerSessions: 2,
        initialFanoutRecipients: 2,
        publisherDirections: 2,
        disconnectedListener: "reconnected",
        postReconnectRecipients: 2
      }
    });
  });
});
