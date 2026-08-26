import { randomUUID } from "node:crypto";
import type { EnvironmentHandle, EnvironmentSpec } from "@lecoding/contracts";
import type { GitWorkspace, WorkspaceHandle } from "@lecoding/workspace";
import type { RunEnvironment } from "./index.js";

/** Creates one environment implementation whose configuration is scoped to a Run. */
export interface RunEnvironmentFactory {
  create(spec: EnvironmentSpec): RunEnvironment | Promise<RunEnvironment>;
}

/** Routes public RunEnvironment calls to the per-Run implementation that prepared them. */
export function createRoutedRunEnvironment(
  factory: RunEnvironmentFactory
): RunEnvironment {
  const routes = new Map<
    string,
    { environment: RunEnvironment; handle: EnvironmentHandle }
  >();
  return {
    async prepare(spec) {
      const environment = await factory.create(spec);
      const handle = await environment.prepare(spec);
      const routedHandle = {
        id: `routed-${randomUUID()}`,
        environmentId: handle.environmentId
      };
      routes.set(routedHandle.id, { environment, handle });
      return routedHandle;
    },
    async perform(handle, action, signal) {
      const route = requireRoute(routes, handle);
      return route.environment.perform(route.handle, action, signal);
    },
    async inspect(handle) {
      const route = requireRoute(routes, handle);
      return route.environment.inspect(route.handle);
    },
    async dispose(handle, outcome) {
      const route = requireRoute(routes, handle);
      try {
        await route.environment.dispose(route.handle, outcome);
      } finally {
        routes.delete(handle.id);
      }
    }
  };
}

/** Options for provisioning a durable Git worktree before Docker starts. */
export interface GitWorktreeRunEnvironmentFactoryOptions {
  workspace: GitWorkspace;
  sourceRepo: string;
  baseRef: string;
  createEnvironment(workspacePath: string): RunEnvironment;
}

/** Creates per-Run environments whose source changes live in isolated Git worktrees. */
export function createGitWorktreeRunEnvironmentFactory(
  options: GitWorktreeRunEnvironmentFactoryOptions
): RunEnvironmentFactory {
  return {
    create(expectedSpec) {
      let workspaceHandle: WorkspaceHandle | undefined;
      let environment: RunEnvironment | undefined;
      return {
        async prepare(spec) {
          if (spec.runId !== expectedSpec.runId) {
            throw new Error("Run environment factory received a mismatched Run ID");
          }
          workspaceHandle = await options.workspace.prepare({
            runId: spec.runId,
            sourceRepo: options.sourceRepo,
            baseRef: options.baseRef
          });
          environment = options.createEnvironment(workspaceHandle.path);
          /*
           * Preserve the worktree when Docker startup fails. RunEngine parks the
           * Run offline, and a later Worker must reopen the same durable changes.
           */
          return await environment.prepare(spec);
        },
        async perform(handle, action, signal) {
          return requirePrepared(environment).perform(handle, action, signal);
        },
        async inspect(_handle) {
          // Docker diff cannot observe bind-mounted files; Git is the evidence authority.
          return options.workspace.inspect(requireWorkspace(workspaceHandle));
        },
        async dispose(handle, outcome) {
          const failures: unknown[] = [];
          try {
            await requirePrepared(environment).dispose(handle, outcome);
          } catch (error) {
            failures.push(error);
          }
          try {
            await options.workspace.dispose(requireWorkspace(workspaceHandle), outcome);
          } catch (error) {
            failures.push(error);
          }
          if (failures.length === 1) {
            throw failures[0];
          }
          if (failures.length > 1) {
            throw new AggregateError(failures, "Run environment disposal failed");
          }
        }
      };
    }
  };
}

function requireRoute(
  routes: Map<string, { environment: RunEnvironment; handle: EnvironmentHandle }>,
  handle: EnvironmentHandle
) {
  const route = routes.get(handle.id);
  if (!route) {
    throw new Error(`Run environment route is not registered: ${handle.id}`);
  }
  return route;
}

function requirePrepared(environment: RunEnvironment | undefined): RunEnvironment {
  if (!environment) {
    throw new Error("Run environment is not prepared");
  }
  return environment;
}

function requireWorkspace(workspace: WorkspaceHandle | undefined): WorkspaceHandle {
  if (!workspace) {
    throw new Error("Run workspace is not prepared");
  }
  return workspace;
}
