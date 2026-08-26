import { describe, expect, it, vi } from "vitest";
import type {
  EnvironmentAction,
  EnvironmentHandle,
  EnvironmentResult,
  EnvironmentSpec
} from "@lecoding/contracts";
import type { RunEnvironment } from "@lecoding/run-environment";
import {
  createProductionVerifier as createProductionVerifierImpl,
  type DiffSafetyChecker,
  type ProductionVerifierOptions,
  type VerificationPlanProvider
} from "../src/index.js";

const passingDiffSafety: DiffSafetyChecker = {
  check: vi.fn(async () => true)
};

/** Supplies the trusted host checker unless a scenario needs a specific outcome. */
function createProductionVerifier(
  options: Omit<ProductionVerifierOptions, "diffSafety"> & {
    diffSafety?: DiffSafetyChecker;
  }
) {
  return createProductionVerifierImpl({
    ...options,
    diffSafety: options.diffSafety ?? passingDiffSafety
  });
}

describe("createProductionVerifier", () => {
  it("passes only after every required command and acceptance criterion pass", async () => {
    const calls: string[] = [];
    const environment = createVerificationEnvironment({
      calls,
      results: [
        { exitCode: 0, stdout: "ok", stderr: "" },
        { exitCode: 0, stdout: "", stderr: "" }
      ]
    });
    const plans: VerificationPlanProvider = {
      load: vi.fn(async () => ({
        required: [
          {
            name: "unit tests",
            argv: ["node", "--test"],
            covers: ["Tests pass"]
          }
        ]
      }))
    };
    const verifier = createProductionVerifier({ plans, environment });

    const report = await verifier.verify({
      runId: "run-1",
      run: {
        projectId: "project-1",
        environmentId: "environment-1",
        task: "Fix the regression",
        acceptanceCriteria: ["Tests pass"],
        approvalMode: "auto_review",
        fileAccessScope: "workspace_only"
      },
      environment: { changedFiles: ["src/subject.ts"] }
    });

    expect(report.outcome).toBe("passed");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        {
          name: "required: unit tests",
          outcome: "passed",
          detail: "Exited with code 0"
        },
        {
          name: "acceptance: Tests pass",
          outcome: "passed",
          detail: "Covered by required check: unit tests"
        },
        {
          name: "diff safety",
          outcome: "passed",
          detail: "Managed worktree diff check passed"
        }
      ])
    );
    expect(calls).toEqual([
      "prepare:run-1",
      "perform:node --test",
      "dispose:discard"
    ]);
  });

  it("fails when the trusted host rejects the managed worktree diff", async () => {
    const verifier = createProductionVerifier({
      plans: {
        load: vi.fn(async () => ({
          required: [{ name: "tests", argv: ["pnpm", "test"], covers: ["*"] }]
        }))
      },
      environment: createVerificationEnvironment({
        calls: [],
        results: [{ exitCode: 0, stdout: "", stderr: "" }]
      }),
      diffSafety: { check: vi.fn(async () => false) }
    });

    const report = await verifier.verify({
      runId: "run-unsafe-diff",
      run: {
        projectId: "project-1",
        environmentId: "environment-1",
        task: "Create a file",
        acceptanceCriteria: ["File is valid"],
        approvalMode: "manual",
        fileAccessScope: "workspace_only"
      },
      environment: { changedFiles: ["new.txt"] }
    });

    expect(report.outcome).toBe("failed");
    expect(report.checks).toContainEqual({
      name: "diff safety",
      outcome: "failed",
      detail: "Managed worktree diff check failed"
    });
  });

  it("is inconclusive when reviewed commands do not cover an acceptance criterion", async () => {
    const calls: string[] = [];
    const verifier = createProductionVerifier({
      plans: {
        load: vi.fn(async () => ({
          required: [
            {
              name: "typecheck",
              argv: ["pnpm", "typecheck"],
              covers: ["Types compile"]
            }
          ]
        }))
      },
      environment: createVerificationEnvironment({
        calls,
        results: [
          { exitCode: 0, stdout: "", stderr: "" },
          { exitCode: 0, stdout: "", stderr: "" }
        ]
      })
    });

    const report = await verifier.verify({
      runId: "run-2",
      run: {
        projectId: "project-1",
        environmentId: "environment-1",
        task: "Add an API",
        acceptanceCriteria: ["Types compile", "API behavior is tested"],
        approvalMode: "auto_review",
        fileAccessScope: "workspace_only"
      },
      environment: { changedFiles: ["src/api.ts"] }
    });

    expect(report.outcome).toBe("inconclusive");
    expect(report.checks).toContainEqual({
      name: "acceptance: API behavior is tested",
      outcome: "inconclusive",
      detail: "No required check covers this criterion"
    });
  });

  it("allows an administrator-reviewed wildcard to cover future task criteria", async () => {
    const verifier = createProductionVerifier({
      plans: {
        load: vi.fn(async () => ({
          required: [
            {
              name: "project tests",
              argv: ["pnpm", "test"],
              covers: ["*"]
            }
          ]
        }))
      },
      environment: createVerificationEnvironment({
        calls: [],
        results: [
          { exitCode: 0, stdout: "", stderr: "" },
          { exitCode: 0, stdout: "", stderr: "" }
        ]
      })
    });

    const report = await verifier.verify({
      runId: "run-wildcard",
      run: {
        projectId: "project-1",
        environmentId: "environment-1",
        task: "Add a future capability",
        acceptanceCriteria: ["Future capability behaves correctly"],
        approvalMode: "auto_review",
        fileAccessScope: "workspace_only"
      },
      environment: { changedFiles: ["src/future.ts"] }
    });

    expect(report.outcome).toBe("passed");
    expect(report.checks).toContainEqual({
      name: "acceptance: Future capability behaves correctly",
      outcome: "passed",
      detail: "Covered by required check: project tests"
    });
  });

  it("runs every required command and fails without copying command output", async () => {
    const calls: string[] = [];
    const verifier = createProductionVerifier({
      plans: {
        load: vi.fn(async () => ({
          required: [
            {
              name: "tests",
              argv: ["pnpm", "test"],
              covers: ["Tests and types pass"]
            },
            {
              name: "typecheck",
              argv: ["pnpm", "typecheck"],
              covers: ["Tests and types pass"]
            }
          ]
        }))
      },
      environment: createVerificationEnvironment({
        calls,
        results: [
          { exitCode: 1, stdout: "", stderr: "SECRET failure details" },
          { exitCode: 0, stdout: "clean", stderr: "" },
          { exitCode: 0, stdout: "", stderr: "" }
        ]
      })
    });

    const report = await verifier.verify({
      runId: "run-3",
      run: {
        projectId: "project-1",
        environmentId: "environment-1",
        task: "Fix checks",
        acceptanceCriteria: ["Tests and types pass"],
        approvalMode: "auto_review",
        fileAccessScope: "workspace_only"
      },
      environment: { changedFiles: ["src/check.ts"] }
    });

    expect(report.outcome).toBe("failed");
    expect(calls).toEqual([
      "prepare:run-3",
      "perform:pnpm test",
      "perform:pnpm typecheck",
      "dispose:discard"
    ]);
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });

  it("reports an infrastructure error as inconclusive and still disposes", async () => {
    const calls: string[] = [];
    const verifier = createProductionVerifier({
      plans: {
        load: vi.fn(async () => ({
          required: [
            {
              name: "tests",
              argv: ["node", "--test"],
              covers: ["Tests pass"]
            }
          ]
        }))
      },
      environment: createVerificationEnvironment({
        calls,
        results: [{ exitCode: 0, stdout: "", stderr: "" }],
        performErrorAt: 0
      })
    });

    const report = await verifier.verify({
      runId: "run-4",
      run: {
        projectId: "project-1",
        environmentId: "environment-1",
        task: "Fix tests",
        acceptanceCriteria: ["Tests pass"],
        approvalMode: "auto_review",
        fileAccessScope: "workspace_only"
      },
      environment: { changedFiles: ["src/test.ts"] }
    });

    expect(report.outcome).toBe("inconclusive");
    expect(report.checks).toContainEqual({
      name: "required: tests",
      outcome: "inconclusive",
      detail: "Verification command could not complete"
    });
    expect(calls.at(-1)).toBe("dispose:discard");
  });

  it("fails closed when the reviewed plan cannot be loaded", async () => {
    const calls: string[] = [];
    const verifier = createProductionVerifier({
      plans: {
        load: vi.fn(async () => {
          throw new Error("configuration backend exposed SECRET");
        })
      },
      environment: createVerificationEnvironment({ calls, results: [] })
    });

    const report = await verifier.verify({
      runId: "run-5",
      run: {
        projectId: "project-1",
        environmentId: "environment-1",
        task: "Change behavior",
        acceptanceCriteria: ["Behavior is verified"],
        approvalMode: "manual",
        fileAccessScope: "workspace_only"
      },
      environment: { changedFiles: [] }
    });

    expect(report).toEqual({
      outcome: "inconclusive",
      checks: [
        {
          name: "verification plan",
          outcome: "inconclusive",
          detail: "Reviewed verification plan could not be loaded"
        }
      ]
    });
    expect(calls).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });

  it("rejects a malformed reviewed plan before starting a container", async () => {
    const calls: string[] = [];
    const verifier = createProductionVerifier({
      plans: {
        load: vi.fn(async () => ({
          required: [{ name: "tests", argv: [], covers: ["Tests pass"] }]
        }))
      },
      environment: createVerificationEnvironment({ calls, results: [] })
    });

    const report = await verifier.verify({
      runId: "run-6",
      run: {
        projectId: "project-1",
        environmentId: "environment-1",
        task: "Fix tests",
        acceptanceCriteria: ["Tests pass"],
        approvalMode: "auto_review",
        fileAccessScope: "workspace_only"
      },
      environment: { changedFiles: [] }
    });

    expect(report).toEqual({
      outcome: "inconclusive",
      checks: [
        {
          name: "verification plan",
          outcome: "inconclusive",
          detail: "Reviewed verification plan is invalid"
        }
      ]
    });
    expect(calls).toEqual([]);
  });

  it("reports verification-environment startup failure as inconclusive", async () => {
    const calls: string[] = [];
    const verifier = createProductionVerifier({
      plans: {
        load: vi.fn(async () => ({
          required: [
            {
              name: "tests",
              argv: ["node", "--test"],
              covers: ["Tests pass"]
            }
          ]
        }))
      },
      environment: createVerificationEnvironment({
        calls,
        results: [],
        prepareError: true
      })
    });

    const report = await verifier.verify({
      runId: "run-7",
      run: {
        projectId: "project-1",
        environmentId: "environment-1",
        task: "Fix tests",
        acceptanceCriteria: ["Tests pass"],
        approvalMode: "auto_review",
        fileAccessScope: "workspace_only"
      },
      environment: { changedFiles: [] }
    });

    expect(report).toEqual({
      outcome: "inconclusive",
      checks: [
        {
          name: "verification environment",
          outcome: "inconclusive",
          detail: "Independent verification environment could not start"
        }
      ]
    });
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });

  it("keeps evidence but becomes inconclusive when container cleanup fails", async () => {
    const calls: string[] = [];
    const verifier = createProductionVerifier({
      plans: {
        load: vi.fn(async () => ({
          required: [
            {
              name: "tests",
              argv: ["node", "--test"],
              covers: ["Tests pass"]
            }
          ]
        }))
      },
      environment: createVerificationEnvironment({
        calls,
        results: [
          { exitCode: 0, stdout: "", stderr: "" },
          { exitCode: 0, stdout: "", stderr: "" }
        ],
        disposeError: true
      })
    });

    const report = await verifier.verify({
      runId: "run-8",
      run: {
        projectId: "project-1",
        environmentId: "environment-1",
        task: "Fix tests",
        acceptanceCriteria: ["Tests pass"],
        approvalMode: "auto_review",
        fileAccessScope: "workspace_only"
      },
      environment: { changedFiles: ["src/test.ts"] }
    });

    expect(report.outcome).toBe("inconclusive");
    expect(report.checks).toContainEqual({
      name: "verification cleanup",
      outcome: "inconclusive",
      detail: "Verification environment could not be disposed"
    });
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });

  it("forwards cancellation to an in-flight required command and still disposes", async () => {
    const calls: string[] = [];
    let observedSignal: AbortSignal | undefined;
    const verifier = createProductionVerifier({
      plans: {
        load: vi.fn(async () => ({
          required: [
            { name: "setup", argv: ["node", "prepare.mjs"], covers: ["Setup completes"] },
            { name: "tests", argv: ["pnpm", "test"], covers: ["Checks pass"] }
          ]
        }))
      },
      environment: {
        async prepare() {
          calls.push("prepare");
          return {
            id: "verification-container",
            environmentId: "environment-1"
          };
        },
        async perform(_handle, _action, signal) {
          calls.push("perform");
          observedSignal = signal;
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new Error("verification aborted")),
              { once: true }
            );
          });
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        async inspect() {
          return { changedFiles: [] };
        },
        async dispose() {
          calls.push("dispose");
        }
      }
    });
    const controller = new AbortController();
    const reportPromise = verifier.verify(
      {
        runId: "run-cancel-verification",
        run: {
          projectId: "project-1",
          environmentId: "environment-1",
          task: "Run checks",
          acceptanceCriteria: ["Checks pass"],
          approvalMode: "auto_review",
          fileAccessScope: "workspace_only"
        },
        environment: { changedFiles: [] }
      },
      controller.signal
    );

    await vi.waitFor(() => expect(observedSignal).toBe(controller.signal));
    controller.abort();

    await expect(reportPromise).resolves.toMatchObject({
      outcome: "inconclusive",
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "verification cancellation" }),
        {
          name: "acceptance: Checks pass",
          outcome: "inconclusive",
          detail: "Verification was cancelled before this criterion was established"
        }
      ])
    });
    expect(calls.at(-1)).toBe("dispose");
  });
});

function createVerificationEnvironment(options: {
  calls: string[];
  results: EnvironmentResult[];
  performErrorAt?: number;
  prepareError?: boolean;
  disposeError?: boolean;
}): RunEnvironment {
  let resultIndex = 0;
  let performIndex = 0;
  const handle: EnvironmentHandle = {
    id: "verification-container",
    environmentId: "environment-1"
  };
  return {
    async prepare(spec: EnvironmentSpec) {
      options.calls.push(`prepare:${spec.runId}`);
      if (options.prepareError) {
        throw new Error("Docker startup leaked SECRET");
      }
      return handle;
    },
    async perform(_handle: EnvironmentHandle, action: EnvironmentAction) {
      options.calls.push(`perform:${action.command.join(" ")}`);
      if (performIndex++ === options.performErrorAt) {
        throw new Error("sandbox unavailable: SECRET");
      }
      return options.results[resultIndex++]!;
    },
    async inspect() {
      return { changedFiles: [] };
    },
    async dispose(_handle, outcome) {
      options.calls.push(`dispose:${outcome}`);
      if (options.disposeError) {
        throw new Error("Docker cleanup leaked SECRET");
      }
    }
  };
}
