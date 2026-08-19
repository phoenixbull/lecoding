import type {
  EnvironmentAction,
  EnvironmentHandle,
  EnvironmentReport,
  EnvironmentResult,
  EnvironmentSpec
} from "@lecoding/contracts";

export interface RunEnvironment {
  prepare(spec: EnvironmentSpec): Promise<EnvironmentHandle>;
  perform(
    handle: EnvironmentHandle,
    action: EnvironmentAction
  ): Promise<EnvironmentResult>;
  inspect(handle: EnvironmentHandle): Promise<EnvironmentReport>;
  dispose(
    handle: EnvironmentHandle,
    outcome: "keep" | "discard"
  ): Promise<void>;
}
