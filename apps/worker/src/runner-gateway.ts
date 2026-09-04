/**
 * Worker-side Runner gateway.
 *
 * Owns everything that must outlive an individual socket:
 *
 * - **Authentication** through the existing `DeviceBindingService`, so a Runner
 *   session is bound to a real user, project and device with no second identity
 *   system.
 * - **The command-id high-water mark per device.** A reconnect creates a new
 *   session, and the Runner keeps its dedupe table across it. Numbering must
 *   therefore continue from where the device left off, or a new command would
 *   be answered from a stale cache and never run.
 * - **The consumed upward cursor per device**, so a reconnect replays from
 *   where the server stopped rather than from zero. This is in-process only:
 *   it does not survive a Worker restart. See `HostSession.consumedCursor()`.
 * - **Revocation.** `terminateDevice` closes a device's session with close code
 *   4001, which the Runner reads as "the credential is dead, go rebind". A
 *   revocation written by *another* Worker is caught by the per-heartbeat
 *   credential revalidation instead, which is what makes the documented
 *   "within one heartbeat interval" bound true rather than aspirational.
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
  /**
   * The one authority on whether a device token is real, unexpired and
   * un-revoked.
   *
   * Caller obligation: this must be the *same* instance the HTTP device routes
   * use. Handing the gateway a second service would let two code paths disagree
   * about which devices exist, and revocation would stop being observable on
   * this one.
   */
  devices: DeviceBindingService;
  /** Projects this Worker serves; a device from another project is rejected. */
  projectIds: readonly string[];
  /**
   * How often credentials are re-validated and silent peers dropped.
   *
   * This is also the ceiling on how long a revocation written by another
   * Worker takes to reach a session this process holds, so lowering it makes
   * revocation prompt and raising it makes revocation sluggish.
   */
  heartbeatIntervalMs?: number;
  /**
   * Receives heartbeat-timer failures.
   *
   * Caller obligation: must not throw, and must not touch the request path. A
   * rejection here means one tick could not revalidate one device; the next
   * tick retries, so the correct handling is to record and continue.
   */
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
  /**
   * Sessions that have not authenticated yet.
   *
   * They are not in `sessionsByDevice` — their device is unknown — so without
   * tracking them separately `tick()` would never visit them and a silent peer
   * would hold a socket open forever.
   */
  const pendingHello = new Set<HostSession>();
  /**
   * Highest upward cursor consumed per device, carried across reconnects
   * *within this process*. Lost on restart; see `HostSession.consumedCursor()`.
   */
  const consumedByDevice = new Map<string, number>();
  /**
   * Next command id to issue per device.
   *
   * Monotonic for the lifetime of this Worker process, and combined with the
   * Runner's own `lastReceivedCommandId` on every reconnect so the sequence can
   * never go backwards — even if the Runner remembers ids this process has
   * forgotten.
   */
  const nextCommandIdByDevice = new Map<string, number>();

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
      /** Device access token for this connection, held only for revalidation. */
      let heldToken: string | undefined;

      session = createHostSession({
        socket,
        sessionId: `runner-${randomUUID()}`,
        heartbeatIntervalMs,

        async authenticate(token) {
          const result = await authenticateDevice(token);
          if (!result.ok || !session) {
            return result;
          }
          // Held for the session's lifetime only, so the credential can be
          // re-proven on each heartbeat. It is never logged and never leaves
          // this closure; it dies with the socket.
          heldToken = token;
          // Registration happens here and nowhere else: this is the first point
          // at which the device identity has been proven.
          bound = result.identity.deviceId;
          pendingHello.delete(session);
          sessionsByDevice.set(bound, session);
          return result;
        },

        initialConsumedCursor(identity) {
          return consumedByDevice.get(identity.deviceId) ?? 0;
        },

        initialCommandId(identity, lastReceivedCommandId) {
          // The larger of "what I last issued" and "what the Runner last saw".
          // Either alone can be too low: the Runner may remember a command this
          // process never issued (issued by a previous Worker), and this
          // process may have issued commands the Runner never received.
          const issued = nextCommandIdByDevice.get(identity.deviceId) ?? 1;
          return Math.max(issued, lastReceivedCommandId + 1);
        },

        onCommandIdIssued(commandId) {
          if (bound !== undefined) {
            nextCommandIdByDevice.set(bound, commandId + 1);
          }
        },

        async revalidate(identity) {
          // Same evaluation as the initial `hello`, so a device revoked since
          // it connected is dropped on the next tick rather than lingering
          // until its next reconnect.
          if (heldToken === undefined) {
            return { ok: false, code: "auth_failed" };
          }
          try {
            const device = await devices.authenticate({ accessToken: heldToken });
            // Reject if the token now resolves to a *different* device: that
            // means the credential was rotated and this session is stale.
            if (
              !projectIds.includes(device.projectId) ||
              device.deviceId !== identity.deviceId
            ) {
              return { ok: false, code: "device_revoked" };
            }
            return {
              ok: true,
              identity: {
                deviceId: device.deviceId,
                userId: device.userId,
                projectId: device.projectId
              }
            };
          } catch (error) {
            return { ok: false, code: mapDeviceError(error) };
          }
        },

        onConsumedCursor(cursor) {
          if (bound !== undefined) {
            consumedByDevice.set(bound, cursor);
          }
        },

        onClose() {
          if (session) {
            pendingHello.delete(session);
          }
          // Only clear the entry if it still points at this session, so a
          // superseded session cannot delete its own replacement.
          if (bound !== undefined && sessionsByDevice.get(bound) === session) {
            sessionsByDevice.delete(bound);
          }
          // Drop the held credential the moment the connection is gone.
          heldToken = undefined;
        }
      });
      pendingHello.add(session);
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
      // Unauthenticated peers are ticked first and separately: they are not in
      // `sessionsByDevice` yet, so folding them into the loop below would leave
      // them unvisited and unbounded.
      for (const session of [...pendingHello]) {
        try {
          session.tick();
        } catch (error) {
          options.onBackgroundError?.(error);
        }
      }
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
      for (const session of [...pendingHello]) {
        session.close(4003, "worker shutting down");
      }
      pendingHello.clear();
      for (const session of [...sessionsByDevice.values()]) {
        session.close(4003, "worker shutting down");
      }
      sessionsByDevice.clear();
      consumedByDevice.clear();
      nextCommandIdByDevice.clear();
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
