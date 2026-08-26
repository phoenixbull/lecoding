import type {
  EnvironmentHandle,
  EnvironmentReport,
  RunId,
  StartRun,
  VerificationReport
} from "@lecoding/contracts";
import type { RunEnvironment } from "@lecoding/run-environment";

/** Complete immutable Run evidence available at the verification boundary. */
export interface VerificationInput {
  runId: RunId;
  run: StartRun;
  environment: EnvironmentReport;
}

/** Independent authority that alone may produce a successful Run conclusion. */
export interface Verifier {
  /** The caller aborts this signal when the Run is cancelled during verification. */
  verify(
    input: VerificationInput,
    signal?: AbortSignal
  ): Promise<VerificationReport>;
}

/** One administrator-owned command that contributes independent evidence. */
export interface RequiredVerificationCommand {
  name: string;
  /** argv is executed directly by RunEnvironment and is never parsed by a shell. */
  argv: string[];
  /** Exact criteria, or reviewed `*` when this check covers all project tasks. */
  covers: string[];
}

/** Trusted minimum verification set resolved for one project and environment. */
export interface VerificationPlan {
  required: RequiredVerificationCommand[];
}

/**
 * Deployment seam for reviewed project verification configuration.
 * Implementations must select committed/admin-reviewed plans by project identity;
 * they must not turn model suggestions or current user text into required commands.
 */
export interface VerificationPlanProvider {
  load(input: VerificationInput): Promise<VerificationPlan | undefined>;
}

/** Trusted host authority for validating the patch without exposing Git metadata. */
export interface DiffSafetyChecker {
  check(runId: RunId): Promise<boolean>;
}

/** Dependencies for the fail-closed production Verifier. */
export interface ProductionVerifierOptions {
  plans: VerificationPlanProvider;
  /** Independent restricted environment used only for required checks. */
  environment: RunEnvironment;
  /** Revalidates and checks the managed worktree through the host Git boundary. */
  diffSafety: DiffSafetyChecker;
}

/**
 * Creates a Verifier whose success comes only from reviewed required commands.
 * Model-suggested commands are deliberately absent from this trust boundary.
 */
export function createProductionVerifier(
  options: ProductionVerifierOptions
): Verifier {
  return {
    async verify(input, signal) {
      if (signal?.aborted) {
        return cancelledVerificationReport();
      }
      let plan: VerificationPlan | undefined;
      try {
        plan = await options.plans.load(input);
      } catch {
        // Configuration backends are untrusted I/O; never leak their error detail.
        return {
          outcome: "inconclusive",
          checks: [
            {
              name: "verification plan",
              outcome: "inconclusive",
              detail: "Reviewed verification plan could not be loaded"
            }
          ]
        };
      }
      if (!plan) {
        return {
          outcome: "inconclusive",
          checks: [
            {
              name: "verification plan",
              outcome: "inconclusive",
              detail: "No reviewed verification plan is configured"
            }
          ]
        };
      }
      if (!isValidVerificationPlan(plan)) {
        return {
          outcome: "inconclusive",
          checks: [
            {
              name: "verification plan",
              outcome: "inconclusive",
              detail: "Reviewed verification plan is invalid"
            }
          ]
        };
      }

      let handle: EnvironmentHandle;
      try {
        handle = await options.environment.prepare({
          runId: input.runId,
          projectId: input.run.projectId,
          environmentId: input.run.environmentId,
          fileAccessScope: input.run.fileAccessScope
        });
      } catch {
        return {
          outcome: "inconclusive",
          checks: [
            {
              name: "verification environment",
              outcome: "inconclusive",
              detail: "Independent verification environment could not start"
            }
          ]
        };
      }
      const commandOutcomes = new Map<
        string,
        "passed" | "failed" | "inconclusive"
      >();
      const checks: VerificationReport["checks"] = [];
      try {
        if (signal?.aborted) {
          checks.push(cancelledVerificationCheck());
        }
        for (const command of plan.required) {
          if (signal?.aborted) {
            if (!checks.some((check) => check.name === "verification cancellation")) {
              checks.push(cancelledVerificationCheck());
            }
            break;
          }
          try {
            const result = await options.environment.perform(handle, {
              type: "execute",
              command: command.argv
            }, signal);
            const outcome = result.exitCode === 0 ? "passed" : "failed";
            commandOutcomes.set(command.name, outcome);
            checks.push({
              name: `required: ${command.name}`,
              outcome,
              detail: `Exited with code ${result.exitCode}`
            });
          } catch {
            if (signal?.aborted) {
              commandOutcomes.set(command.name, "inconclusive");
              checks.push(cancelledVerificationCheck());
              break;
            }
            // Infrastructure detail may contain credentials; keep only stable evidence.
            commandOutcomes.set(command.name, "inconclusive");
            checks.push({
              name: `required: ${command.name}`,
              outcome: "inconclusive",
              detail: "Verification command could not complete"
            });
          }
        }
        /* This mandatory host check keeps repository metadata out of containers. */
        if (!signal?.aborted) {
          try {
            const safe = await options.diffSafety.check(input.runId);
            checks.push({
              name: "diff safety",
              outcome: safe ? "passed" : "failed",
              detail: safe
                ? "Managed worktree diff check passed"
                : "Managed worktree diff check failed"
            });
          } catch {
            checks.push({
              name: "diff safety",
              outcome: "inconclusive",
              detail: signal?.aborted
                ? "Verification was cancelled"
                : "Diff safety check could not complete"
            });
          }
        }
      } finally {
        // Verification containers never own the worktree and are always disposable.
        try {
          await options.environment.dispose(handle, "discard");
        } catch {
          checks.push({
            name: "verification cleanup",
            outcome: "inconclusive",
            detail: "Verification environment could not be disposed"
          });
        }
      }

      for (const criterion of input.run.acceptanceCriteria) {
        if (signal?.aborted) {
          checks.push({
            name: `acceptance: ${criterion}`,
            outcome: "inconclusive",
            detail: "Verification was cancelled before this criterion was established"
          });
          continue;
        }
        const covering = plan.required.filter((command) =>
          command.covers.includes("*") || command.covers.includes(criterion)
        );
        if (covering.length === 0) {
          checks.push({
            name: `acceptance: ${criterion}`,
            outcome: "inconclusive",
            detail: "No required check covers this criterion"
          });
          continue;
        }
        const evidence = covering.map((command) =>
          commandOutcomes.get(command.name)
        );
        const outcome = evidence.includes("failed")
          ? "failed"
          : evidence.includes("inconclusive")
            ? "inconclusive"
            : "passed";
        checks.push({
          name: `acceptance: ${criterion}`,
          outcome,
          detail: `Covered by required check: ${covering
            .map((command) => command.name)
            .join(", ")}`
        });
      }

      const outcome = checks.some((check) => check.outcome === "failed")
        ? "failed"
        : checks.some((check) => check.outcome === "inconclusive")
          ? "inconclusive"
          : "passed";
      return {
        outcome,
        checks
      };
    }
  };
}

/** Stable redacted evidence emitted whenever the caller cancels verification. */
function cancelledVerificationCheck(): VerificationReport["checks"][number] {
  return {
    name: "verification cancellation",
    outcome: "inconclusive",
    detail: "Verification was cancelled"
  };
}

/** A cancelled verification can never authorize a successful Run. */
function cancelledVerificationReport(): VerificationReport {
  return {
    outcome: "inconclusive",
    checks: [cancelledVerificationCheck()]
  };
}

function isValidVerificationPlan(plan: VerificationPlan): boolean {
  if (!Array.isArray(plan.required) || plan.required.length === 0) {
    return false;
  }
  const names = new Set<string>();
  for (const command of plan.required) {
    if (
      typeof command.name !== "string" ||
      command.name.trim() === "" ||
      names.has(command.name) ||
      !Array.isArray(command.argv) ||
      command.argv.length === 0 ||
      command.argv.some(
        (argument) => typeof argument !== "string" || argument.length === 0
      ) ||
      !Array.isArray(command.covers) ||
      command.covers.some(
        (criterion) => typeof criterion !== "string" || criterion.trim() === ""
      )
    ) {
      return false;
    }
    // Stable unique names prevent evidence from being rebound in the outcome map.
    names.add(command.name);
  }
  return true;
}

export {
  createProjectYamlVerificationPlanProvider,
  type ProjectYamlVerificationPlanProviderOptions
} from "./project-yaml-plan-provider.js";
