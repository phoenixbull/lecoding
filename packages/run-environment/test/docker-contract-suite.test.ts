import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe } from "vitest";
import {
  createDockerRunEnvironment,
  runRunEnvironmentContractSuite
} from "../src/index.js";

/**
 * Shared contract suite, run against the Docker adapter.
 *
 * The probe carries a 5 s wall-clock cap, matching `docker-environment.test.ts`:
 * a Docker Desktop install whose daemon is not running blocks `docker info`
 * indefinitely, and a probe without a timeout hangs the whole run during
 * collection — before a single test is even listed. That was the cause of the
 * full suite never exiting.
 */
function dockerAvailable(): boolean {
  const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    stdio: "ignore",
    timeout: 5_000
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
/**
 * Gate: the Docker contract suite runs only when explicitly enabled.
 *
 * Docker Desktop installs whose daemon is up-but-flaky make `docker` calls
 * hang without failing, which stalls the whole run. A probe cannot tell a
 * healthy daemon from one that is about to hang, so availability alone is not
 * a safe gate — the suite is opt-in, like the installed-app smoke, and runs
 * where Docker is known-reliable (CI). Without the flag it skips with this
 * reason rather than counting as passed.
 */
const dockerContractEnabled =
  process.env["LECODING_DOCKER_CONTRACT"] === "1" && dockerAvailable();

describe.skipIf(!dockerContractEnabled)("docker adapter contract", () => {
  // The Docker adapter canonicalizes the worktree root, so it must exist.
  const worktreeRoot = join(tmpdir(), `lecoding-docker-contract-${process.pid}`);
  mkdirSync(worktreeRoot, { recursive: true });

  runRunEnvironmentContractSuite({
    name: "ServerDockerEnvironment",
    rejectsUnknownActionType: true,
    rejectsEmptyCommand: true,
    reportsNonZeroExitCode: true,
    create: async (runId) => {
      // In production the Git worktree factory creates the per-Run directory
      // before the Docker environment is constructed; the adapter
      // canonicalizes it, so it must exist here too.
      mkdirSync(join(worktreeRoot, runId), { recursive: true });
      return createDockerRunEnvironment({
        // A tiny, widely-cached image keeps the suite fast and network-free.
        image: "docker.io/library/busybox:1.36",
        worktreeRoot,
        workspacePath: join(worktreeRoot, runId),
        containerWorkspacePath: "/workspace/project",
        network: "none"
      });
    },
    dispose: async () => {
      // Container removal is owned by the adapter's dispose; the worktree is
      // managed by the Git worktree factory in production, not here.
    }
  });
});
