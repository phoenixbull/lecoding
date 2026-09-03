/**
 * Local-environment identity parsing.
 *
 * Environment ids of the form `local:<deviceId>` route a Run to that device's
 * Local Runner instead of this Worker's Docker sandbox. Routing on
 * `environmentId` rather than adding a field to `StartRun` keeps
 * `packages/run-engine` untouched: the engine already passes `environmentId`
 * through to `EnvironmentSpec`, so Phase 4B adds no new engine concept.
 *
 * It lives in its own module because both the HTTP layer (which gates Run
 * creation) and the composition root (which builds environments) need it, and
 * neither should import the other.
 */

/** Prefix marking an environment as executed on a bound desktop device. */
export const LOCAL_ENVIRONMENT_PREFIX = "local:";

/** Returns the device id for a local environment id, or undefined for server runs. */
export function localRunnerDeviceId(environmentId: string): string | undefined {
  return environmentId.startsWith(LOCAL_ENVIRONMENT_PREFIX)
    ? environmentId.slice(LOCAL_ENVIRONMENT_PREFIX.length)
    : undefined;
}

/** True when the environment id targets a desktop Local Runner. */
export function isLocalEnvironmentId(environmentId: string): boolean {
  return localRunnerDeviceId(environmentId) !== undefined;
}
