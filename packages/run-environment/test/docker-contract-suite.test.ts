import { spawnSync } from "node:child_process";
import { describe } from "vitest";
import {
  createDockerRunEnvironment,
  runRunEnvironmentContractSuite
} from "../src/index.js";

/** Shared contract suite, run against the Docker adapter. */
function dockerAvailable(): boolean {
  const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    stdio: "ignore"
  });
  return result.status === 0;
}

/**
 * Mirrors `docker-environment.test.ts`'s daemon gate: without a daemon the
 * suite is skipped with an explicit reason, never counted as a pass.
 *
 * The Run id is fixed because `prepare` derives the container workspace path
 * from it; the Docker environment cleans its own container on dispose.
 */
describe.skipIf(!dockerAvailable())("docker adapter contract", () => {
  runRunEnvironmentContractSuite({
    name: "ServerDockerEnvironment",
    rejectsUnknownActionType: true,
    rejectsEmptyCommand: true,
    reportsNonZeroExitCode: true,
    create: async (runId) =>
      createDockerRunEnvironment({
        // A tiny, widely-cached image keeps the suite fast and network-free.
        image: "docker.io/library/busybox:1.36",
        worktreeRoot: "/tmp/lecoding-docker-contract",
        workspacePath: `/tmp/lecoding-docker-contract/${runId}`,
        containerWorkspacePath: "/workspace/project",
        network: "none"
      }),
    dispose: async () => {
      // Container removal is owned by the adapter's dispose; the worktree is
      // managed by the Git worktree factory in production, not here.
    }
  });
});
