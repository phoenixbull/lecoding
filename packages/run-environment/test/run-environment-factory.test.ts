import { describe, expect, it, vi } from "vitest";
import type {
  EnvironmentHandle,
  EnvironmentSpec
} from "@lecoding/contracts";
import type { GitWorkspace } from "@lecoding/workspace";
import {
  createGitWorktreeRunEnvironmentFactory,
  createRoutedRunEnvironment
} from "../src/index.js";

describe("createRoutedRunEnvironment", () => {
  it("creates and routes an isolated environment for each Run", async () => {
    const created: string[] = [];
    const environment = createRoutedRunEnvironment({
      create(spec) {
        created.push(spec.runId);
        return recordingEnvironment(spec.runId);
      }
    });
    const first = await environment.prepare(environmentSpec("run-1"));
    const second = await environment.prepare(environmentSpec("run-2"));

    await expect(
      environment.perform(first, { type: "execute", command: ["pwd"] })
    ).resolves.toMatchObject({ stdout: "run-1" });
    await expect(
      environment.perform(second, { type: "execute", command: ["pwd"] })
    ).resolves.toMatchObject({ stdout: "run-2" });
    expect(created).toEqual(["run-1", "run-2"]);
  });
});

describe("createGitWorktreeRunEnvironmentFactory", () => {
  it("prepares a dedicated worktree and preserves it when environment startup fails", async () => {
    const dispose = vi.fn(async () => undefined);
    const workspace: GitWorkspace = {
      prepare: vi.fn(async (input) => ({
        runId: input.runId,
        sourceRepo: input.sourceRepo,
        path: `/runs/${input.runId}`
      })),
      apply: vi.fn(),
      inspect: vi.fn(),
      dispose
    };
    const factory = createGitWorktreeRunEnvironmentFactory({
      workspace,
      sourceRepo: "/source/project",
      baseRef: "HEAD",
      createEnvironment: () => ({
        async prepare() {
          throw new Error("docker unavailable");
        },
        async perform() {
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        async inspect() {
          return { changedFiles: [] };
        },
        async dispose() {}
      })
    });
    const environment = factory.create(environmentSpec("run-1"));

    await expect(
      environment.prepare(environmentSpec("run-1"))
    ).rejects.toThrow("docker unavailable");
    expect(workspace.prepare).toHaveBeenCalledWith({
      runId: "run-1",
      sourceRepo: "/source/project",
      baseRef: "HEAD"
    });
    // RunEngine parks the Run offline; the same durable worktree is reopened on retry.
    expect(dispose).not.toHaveBeenCalled();
  });
});

function environmentSpec(runId: string): EnvironmentSpec {
  return {
    runId,
    projectId: "project-1",
    environmentId: "sandbox-v1",
    fileAccessScope: "workspace_only"
  };
}

function recordingEnvironment(runId: string) {
  return {
    async prepare(spec: EnvironmentSpec): Promise<EnvironmentHandle> {
      return { id: `handle-${runId}`, environmentId: spec.environmentId };
    },
    async perform() {
      return { exitCode: 0, stdout: runId, stderr: "" };
    },
    async inspect() {
      return { changedFiles: [] };
    },
    async dispose() {}
  };
}
