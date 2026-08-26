import { describe, expect, it, vi } from "vitest";
import type {
  EnvironmentAction,
  EnvironmentHandle,
  EnvironmentResult,
  EnvironmentSpec
} from "@lecoding/contracts";
import type { RunEnvironment } from "@lecoding/run-environment";
import {
  createProductionVerifier,
  type VerificationPlanProvider
} from "../src/index.js";

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
          detail: "git diff --check exited with code 0"
        }
      ])
    );
    expect(calls).toEqual([
      "prepare:run-1",
      "perform:node --test",
      "perform:git diff --check HEAD --",
      "dispose:discard"
    ]);
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
      "perform:git diff --check HEAD --",
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
