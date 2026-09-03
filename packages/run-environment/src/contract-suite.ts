/**
 * Shared `RunEnvironment` contract suite.
 *
 * M2.4 requires that `DesktopLocalEnvironment` passes the same interface
 * contract tests as `ServerDockerEnvironment`. Duplicating the assertions
 * across three test files is exactly how they drift apart, so the contract
 * lives once here and each adapter invokes it.
 *
 * Only the invariants every adapter must honour are asserted here.
 * Adapter-specific behaviour (Docker image references, sandbox tiers,
 * approval gates) stays in that adapter's own tests: folding those in would
 * either couple the suite to one platform or weaken it to nothing.
 */

import { describe, expect, it } from "vitest";
import type { RunEnvironment } from "./index.js";

/** Behaviour the suite may assert when the adapter documents it. */
export interface RunEnvironmentContractExpectations {
  /**
   * `perform` rejects an action type other than `execute`.
   * True for adapters that validate the action before spawning.
   */
  rejectsUnknownActionType?: boolean;
  /**
   * `perform` rejects an empty command array rather than spawning nothing.
   */
  rejectsEmptyCommand?: boolean;
  /**
   * `perform` resolves with a non-zero exit code instead of throwing, so a
   * failing test command is a Run result rather than an infrastructure error.
   */
  reportsNonZeroExitCode?: boolean;
}

export interface RunEnvironmentContractOptions
  extends RunEnvironmentContractExpectations {
  /** Label used in the describe block, naming the adapter under test. */
  name: string;
  /**
   * Builds a fresh environment bound to one Run id.
   *
   * Called once per test, so each test starts from a clean worktree and a
   * failure in one test cannot leak state into the next.
   */
  create(runId: string): Promise<RunEnvironment>;
  /** True to skip the whole suite (environment gate), with the reason. */
  skip?: string;
  /** Removes anything `create` built. Called after every test. */
  dispose?(): Promise<void>;
}

/**
 * Runs the shared contract suite against an adapter.
 *
 * Call from a test file; it registers its own `describe`/`it` blocks. The
 * suite is deliberately small: it checks the four methods behave and that a
 * disposal is idempotent, which is what lets RunEngine treat every adapter
 * identically.
 */
export function runRunEnvironmentContractSuite(
  options: RunEnvironmentContractOptions
): void {
  const run = options.skip
    ? describe.skip
    : describe;

  run(`RunEnvironment contract: ${options.name}`, () => {
    const RUN_ID = "contract-run-1";

    it("prepares a handle carrying the environment id", async () => {
      const environment = await options.create(RUN_ID);
      try {
        const handle = await environment.prepare({
          runId: RUN_ID,
          projectId: "contract-project",
          environmentId: "contract-env",
          fileAccessScope: "workspace_only"
        });
        expect(typeof handle.id).toBe("string");
        expect(handle.id.length).toBeGreaterThan(0);
        expect(handle.environmentId).toBe("contract-env");
      } finally {
        await options.dispose?.();
      }
    });

    it("performs a command and reports its exit code", async () => {
      const environment = await options.create(RUN_ID);
      try {
        const handle = await environment.prepare({
          runId: RUN_ID,
          projectId: "contract-project",
          environmentId: "contract-env",
          fileAccessScope: "workspace_only"
        });
        const result = await environment.perform(handle, {
          type: "execute",
          command: ["node", "-e", "process.exit(0)"]
        });
        expect(result.exitCode).toBe(0);
      } finally {
        await options.dispose?.();
      }
    });

    if (options.reportsNonZeroExitCode) {
      it("reports a failing command as a non-zero exit code", async () => {
        const environment = await options.create(RUN_ID);
        try {
          const handle = await environment.prepare({
            runId: RUN_ID,
            projectId: "contract-project",
            environmentId: "contract-env",
            fileAccessScope: "workspace_only"
          });
          // A failing command is a Run outcome, not an adapter failure, so the
          // adapter must resolve rather than reject.
          const result = await environment.perform(handle, {
            type: "execute",
            command: ["node", "-e", "process.exit(3)"]
          });
          expect(result.exitCode).toBe(3);
        } finally {
          await options.dispose?.();
        }
      });
    }

    if (options.rejectsUnknownActionType) {
      it("rejects an unsupported action type", async () => {
        const environment = await options.create(RUN_ID);
        try {
          const handle = await environment.prepare({
            runId: RUN_ID,
            projectId: "contract-project",
            environmentId: "contract-env",
            fileAccessScope: "workspace_only"
          });
          await expect(
            environment.perform(handle, {
              type: "teleport"
            } as never)
          ).rejects.toThrow();
        } finally {
          await options.dispose?.();
        }
      });
    }

    if (options.rejectsEmptyCommand) {
      it("rejects an empty command array", async () => {
        const environment = await options.create(RUN_ID);
        try {
          const handle = await environment.prepare({
            runId: RUN_ID,
            projectId: "contract-project",
            environmentId: "contract-env",
            fileAccessScope: "workspace_only"
          });
          await expect(
            environment.perform(handle, { type: "execute", command: [] })
          ).rejects.toThrow();
        } finally {
          await options.dispose?.();
        }
      });
    }

    it("inspects the worktree and reports a changed-files list", async () => {
      const environment = await options.create(RUN_ID);
      try {
        const handle = await environment.prepare({
          runId: RUN_ID,
          projectId: "contract-project",
          environmentId: "contract-env",
          fileAccessScope: "workspace_only"
        });
        const report = await environment.inspect(handle);
        // The shape matters more than the contents: a Run with no changes is
        // legitimate, so the suite asserts a list, not a non-empty one.
        expect(Array.isArray(report.changedFiles)).toBe(true);
      } finally {
        await options.dispose?.();
      }
    });

    it("disposes idempotently for a keep outcome", async () => {
      const environment = await options.create(RUN_ID);
      try {
        const handle = await environment.prepare({
          runId: RUN_ID,
          projectId: "contract-project",
          environmentId: "contract-env",
          fileAccessScope: "workspace_only"
        });
        await environment.dispose(handle, "keep");
        // The server can re-send a resolve after a reconnect. The second call
        // must confirm rather than fail on a worktree that is already gone.
        await expect(environment.dispose(handle, "keep")).resolves.toBeUndefined();
      } finally {
        await options.dispose?.();
      }
    });
  });
}
