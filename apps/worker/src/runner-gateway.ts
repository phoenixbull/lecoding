/**
 * Worker-side Runner gateway.
 *
 * Owns everything that must outlive an individual socket:
 *
 * - **Authentication** through the existing `DeviceBindingService`, so a Runner
 *   session is bound to a real user, project and device with no second identity
 *   system.
 * - **The consumed cursor per device.** A reconnect creates a new session, and
 *   carrying this forward is what turns "replay from the beginning" into
 *   "replay from where the server actually stopped".
 * - **Revocation.** `terminateDevice` closes a device's session with close code
 *   4001, which the Runner reads as "the credential is dead, go rebind".
 *
 * A socket is only entered into the routing table from inside `authenticate`,
 * i.e. after the device token has been verified. Until then the connection is
 * live but unreachable, so a Run can never be dispatched to a stranger.
 *
 * Liveness is pumped by one unref'd interval for *all* sessions rather than a
 * timer each, so an idle Worker with a hundred devices connected holds one timer.
 */

import { randomUUID } from "node:crypto";
import type { DeviceBindingService } from "@lecoding/device-binding";
import {
  createHostSession,
  type HostSession,
  type RunnerAuthResult,
  type RunnerErrorCode,
  type RunnerIdentity,
  type RunnerSocket
} from "@lecoding/runner-protocol";

export interface RunnerGatewayOptions {
  devices: DeviceBindingService;
  /** Projects this Worker serves; a device from another project is rejected. */
  projectIds: readonly string[];
  heartbeatIntervalMs?: number;
  /** Receives heartbeat-timer failures without taking down the request path. */
  onBackgroundError?: (error: unknown) => void;
}

export interface RunnerGateway {
  /** Drives one accepted socket until it closes. */
  accept(socket: RunnerSocket): void;
  /** The live session for a device, or undefined when it is offline. */
  sessionFor(deviceId: string): HostSession | undefined;
  /**
   * Closes the device's session with `device_revoked`.
   *
   * Returns how many sessions were terminated. This is immediate for sessions
   * held by *this* Worker process. With more than one Worker, another process'
   * session dies at its next heartbeat revalidation, because revocation is
   * written to the database and is not broadcast on a bus — that bound is a
   * property of the deployment, not of the protocol, and the docs must not
   * claim otherwise.
   */
  terminateDevice(deviceId: string, reason?: string): number;
  /** Sends heartbeats and drops silent peers. Called by the interval. */
  tick(): void;
  /** Stops the interval and closes every session. */
  stop(): void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export function createRunnerGateway(options: RunnerGatewayOptions): RunnerGateway {
  const { devices, projectIds } = options;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  /** At most one live session per device; a reconnect replaces the entry. */
  const sessionsByDevice = new Map<string, HostSession>();
  /** Highest cursor durably consumed per device, carried across reconnects. */
  const consumedByDevice = new Map<string, number>();

  const timer = setInterval(() => {
    gateway.tick();
  }, heartbeatIntervalMs);
  // Heartbeats must never be the reason a Worker cannot exit.
  timer.unref?.();

  async function authenticateDevice(token: string): Promise<RunnerAuthResult> {
    try {
      const device = await devices.authenticate({ accessToken: token });
      if (!projectIds.includes(device.projectId)) {
        return { ok: false, code: "auth_failed" };
      }
      const identity: RunnerIdentity = {
        deviceId: device.deviceId,
        userId: device.userId,
        projectId: device.projectId
      };
      return { ok: true, identity };
    } catch (error) {
      return { ok: false, code: mapDeviceError(error) };
    }
  }

  const gateway: RunnerGateway = {
    accept(socket) {
      let bound: string | undefined;
      let session: HostSession | undefined;

      session = createHostSession({
        socket,
        sessionId: `runner-${randomUUID()}`,

        async authenticate(token) {
          const result = await authenticateDevice(token);
          if (!result.ok || !session) {
            return result;
          }
          // Registration happens here and nowhere else: this is the first point
          // at which the device identity has been proven.
          bound = result.identity.deviceId;
          sessionsByDevice.set(bound, session);
          return result;
        },

        initialConsumedCursor(identity) {
          return consumedByDevice.get(identity.deviceId) ?? 0;
        },

        onConsumedCursor(cursor) {
          if (bound !== undefined) {
            consumedByDevice.set(bound, cursor);
          }
        },

        onClose() {
          // Only clear the entry if it still points at this session, so a
          // superseded session cannot delete its own replacement.
          if (bound !== undefined && sessionsByDevice.get(bound) === session) {
            sessionsByDevice.delete(bound);
          }
        },

        heartbeatIntervalMs
      });
    },

    sessionFor(deviceId) {
      return sessionsByDevice.get(deviceId);
    },

    terminateDevice(deviceId, reason = "device revoked") {
      const session = sessionsByDevice.get(deviceId);
      if (!session) {
        return 0;
      }
      sessionsByDevice.delete(deviceId);
      session.close(4001, reason);
      return 1;
    },

    tick() {
      for (const session of [...sessionsByDevice.values()]) {
        try {
          session.tick();
        } catch (error) {
          options.onBackgroundError?.(error);
        }
      }
    },

    stop() {
      clearInterval(timer);
      for (const session of [...sessionsByDevice.values()]) {
        session.close(4003, "worker shutting down");
      }
      sessionsByDevice.clear();
      consumedByDevice.clear();
    }
  };

  return gateway;
}

/** Maps a device-binding failure onto a code the Runner can act on. */
function mapDeviceError(error: unknown): RunnerErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "device_expired") {
    return "device_expired";
  }
  if (code === "device_revoked") {
    return "device_revoked";
  }
  // `authenticate` reports a revoked device as `device_unknown`, so an unknown
  // token is treated the same way: the credential is dead and the user rebinds.
  return "auth_failed";
}
