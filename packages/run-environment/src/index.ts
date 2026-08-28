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
    action: EnvironmentAction,
    /**
     * 取消信号:RunEngine 在 cancel 命令进入时调 controller.abort(),
     * 适配器必须立即放弃正在执行的副作用(例如 docker kill 容器),
     * 抛出任意错误作为终止语义。缺省/未提供时不强制监听,
     * 但生产实现必须支持以保证 cancel 命令对 perform 期间生效。
     */
    signal?: AbortSignal
  ): Promise<EnvironmentResult>;
  inspect(handle: EnvironmentHandle): Promise<EnvironmentReport>;
  dispose(
    handle: EnvironmentHandle,
    outcome: "keep" | "discard"
  ): Promise<void>;
}

export {
  FakeDockerRunEnvironment,
  type FakeDockerLimits
} from "./fake-docker-environment.js";

export {
  createBoundedOutputCapture,
  createDockerRunEnvironment,
  createDockerRunPlan,
  type DockerRunLimits,
  type BoundedOutputCapture,
  type DockerRunPlan,
  type DockerRunPlanInput
} from "./docker-environment.js";

export {
  createGitWorktreeRunEnvironmentFactory,
  createRoutedRunEnvironment,
  type GitWorktreeRunEnvironmentFactoryOptions,
  type RunEnvironmentFactory
} from "./run-environment-factory.js";
