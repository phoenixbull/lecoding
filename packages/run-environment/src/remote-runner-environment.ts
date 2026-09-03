/**
 * Remote desktop environment — a `RunEnvironment` implemented over WSS.
 *
 * This adapter is why Phase 4B does not fork the engine. `RunEngine` already
 * depends only on `RunEnvironment`; this module satisfies that interface by
 * forwarding the four calls to a Local Runner on the user's machine. The engine,
 * the approval flow, the event journal and the verifier are all unchanged, and
 * the worker's routed factory picks this adapter per Run.
 *
 * Outcomes returned by the Runner are re-validated here. The Runner is the
 * user's own client rather than an anonymous peer, but it is still a separate
 * process across a network boundary, and a malformed `EnvironmentResult` would
 * otherwise flow straight into the model's tool history.
 */

import type {
  EnvironmentAction,
  EnvironmentHandle,
  EnvironmentReport,
  EnvironmentResult,
  EnvironmentSpec
} from "@lecoding/contracts";
import type { HostSession } from "@lecoding/runner-protocol";
import type { RunEnvironment } from "./index.js";

/**
 * The narrow slice of the Runner gateway this adapter needs.
 *
 * Declared structurally so `run-environment` depends on one method instead of
 * on the Worker's gateway type, and tests can supply a plain object.
 */
export interface RunnerSessionSource {
  /** The live session for a device, or undefined when it is offline. */
  sessionFor(deviceId: string): HostSession | undefined;
}

export interface RemoteRunnerEnvironmentOptions {
  /**
   * Resolved per call rather than once, so a reconnect between two commands is
   * picked up without rebuilding the environment.
   */
  gateway: RunnerSessionSource;
  /** Device that will execute the Run; bound when the Run was created. */
  deviceId: string;
}

/** Raised when the device is not connected, so the Run can be parked offline. */
export class RunnerOfflineError extends Error {
  constructor(deviceId: string) {
    super(`No live Runner session for device ${deviceId}`);
    this.name = "RunnerOfflineError";
  }
}

export function createRemoteRunnerEnvironment(
  options: RemoteRunnerEnvironmentOptions
): RunEnvironment {
  function requireSession(): HostSession {
    const session = options.gateway.sessionFor(options.deviceId);
    if (!session) {
      throw new RunnerOfflineError(options.deviceId);
    }
    return session;
  }

  return {
    async prepare(spec: EnvironmentSpec): Promise<EnvironmentHandle> {
      const value = await requireSession().call("env.prepare", {
        runId: spec.runId,
        projectId: spec.projectId,
        environmentId: spec.environmentId,
        fileAccessScope: spec.fileAccessScope
      });
      return parseHandle(value, spec.environmentId);
    },

    async perform(
      handle: EnvironmentHandle,
      action: EnvironmentAction,
      signal?: AbortSignal
    ): Promise<EnvironmentResult> {
      if (action.type !== "execute") {
        throw new Error(
          `Unsupported action type: ${String((action as { type: string }).type)}`
        );
      }
      return await requireSession().call(
        "env.perform",
        { handleId: handle.id, command: action.command },
        signal
      ).then(parseResult);
    },

    async inspect(handle: EnvironmentHandle): Promise<EnvironmentReport> {
      const value = await requireSession().call("env.inspect", { handleId: handle.id });
      return parseReport(value);
    },

    async dispose(handle: EnvironmentHandle, outcome: "keep" | "discard"): Promise<void> {
      await requireSession().call("env.dispose", { handleId: handle.id, outcome });
    }
  };
}

function parseHandle(value: unknown, environmentId: string): EnvironmentHandle {
  const handleId = requireString(value, "handleId", "env.prepare");
  return { id: handleId, environmentId };
}

function parseReport(value: unknown): EnvironmentReport {
  const record = requireRecord(value, "env.inspect");
  const changedFiles = record["changedFiles"];
  if (!Array.isArray(changedFiles) || changedFiles.some((entry) => typeof entry !== "string")) {
    throw new Error("env.inspect returned an invalid changedFiles array");
  }
  return { changedFiles: changedFiles as string[] };
}

function parseResult(value: unknown): EnvironmentResult {
  const record = requireRecord(value, "env.perform");
  const exitCode = record["exitCode"];
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
    throw new Error("env.perform returned an invalid exitCode");
  }
  const result: EnvironmentResult = {
    exitCode,
    stdout: optionalString(record, "stdout"),
    stderr: optionalString(record, "stderr")
  };
  if (record["stdoutTruncated"] === true) {
    result.stdoutTruncated = true;
  }
  if (record["stderrTruncated"] === true) {
    result.stderrTruncated = true;
  }
  return result;
}

function requireRecord(value: unknown, op: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${op} returned a non-object result`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, key: string, op: string): string {
  const record = requireRecord(value, op);
  const entry = record[key];
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error(`${op} returned an invalid ${key}`);
  }
  return entry;
}

function optionalString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}
