import type { DeviceBindingService } from "@lecoding/device-binding";
import type { RunApiAccessControl } from "./api.js";

/** Dependencies for composing browser-session and bound-device authentication. */
export interface DeviceAwareAccessControlOptions {
  sessions: RunApiAccessControl;
  devices: DeviceBindingService;
}

/**
 * Extends the existing session authority with scoped device bearer tokens.
 *
 * Membership resolution remains owned by the session authority; a device only
 * contributes the same user identity its one-time binding code captured.
 */
export function createDeviceAwareAccessControl(
  options: DeviceAwareAccessControlOptions
): RunApiAccessControl {
  return {
    async authenticate(request) {
      const session = await options.sessions.authenticate(request);
      if (session) {
        return session;
      }
      const authorization = request.headers.get("authorization");
      if (!authorization?.startsWith("Bearer ")) {
        return undefined;
      }
      const accessToken = authorization.slice("Bearer ".length);
      try {
        const device = await options.devices.authenticate({ accessToken });
        // Successful use updates the operational device inventory without
        // changing the credential's expiry or authority.
        await options.devices.touchDevice(device.deviceId);
        return { userId: device.userId, email: device.email };
      } catch {
        // Authentication deliberately does not reveal whether a token was a
        // revoked, expired, or unknown device credential.
        return undefined;
      }
    },
    roleFor(userId, projectId) {
      return options.sessions.roleFor(userId, projectId);
    }
  };
}
