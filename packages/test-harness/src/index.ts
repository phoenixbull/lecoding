import type {
  EnvironmentAction,
  EnvironmentHandle,
  EnvironmentReport,
  EnvironmentResult,
  EnvironmentSpec,
  RunEngine,
  RunId,
  VerificationOutcome,
  VerificationReport
} from "@lecoding/contracts";
import {
  createRunEngine,
  type AgentModel,
  type AgentModelInput,
  type AgentModelTurn,
  type RunStore
} from "@lecoding/run-engine";
import { createPolicyEngine } from "@lecoding/policy";
import type { RunEnvironment } from "@lecoding/run-environment";
import {
  createInMemoryRunEventJournal,
  type RunEventJournal
} from "@lecoding/run-events";
import type { VerificationInput, Verifier } from "@lecoding/verifier";

export interface TestHarness {
  engine: RunEngine;
  /** Public event interface used by Web and future PC client tests. */
  events: RunEventJournal;
}

export function createTestHarness(options: {
  verificationOutcome?: VerificationOutcome;
  expectedChangedFile?: string;
  expectNoChangedFiles?: boolean;
  modelError?: string;
  modelTurns?: AgentModelTurn[];
}): TestHarness {
  const store = new InMemoryRunStore();
  const environment = new FakeRunEnvironment();
  const events = createInMemoryRunEventJournal({
    now: () => "2026-08-19T00:00:00.000Z"
  });
  const verifier = options.expectedChangedFile
    ? new RequiredFileVerifier(options.expectedChangedFile)
    : options.expectNoChangedFiles
      ? new UnchangedWorkspaceVerifier()
      : new FixedVerifier(options.verificationOutcome ?? "passed");

  return {
    engine: createRunEngine({
      store,
      environment,
      model: new FakeAgentModel(
        options.modelTurns ?? [
          { type: "completed", summary: "No tool call required" }
        ],
        options.modelError
      ),
      policy: createPolicyEngine(),
      events,
      verifier,
      createId: () => "run-1"
    }),
    events
  };
}

class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<RunId, Parameters<RunStore["save"]>[0]>();

  async save(run: Parameters<RunStore["save"]>[0]): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
  }

  async get(runId: RunId): ReturnType<RunStore["get"]> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }
}

class FakeRunEnvironment implements RunEnvironment {
  private readonly changedFiles: string[] = [];

  async prepare(spec: EnvironmentSpec): Promise<EnvironmentHandle> {
    return { id: `handle-${spec.runId}`, environmentId: spec.environmentId };
  }

  async perform(
    _handle: EnvironmentHandle,
    _action: EnvironmentAction
  ): Promise<EnvironmentResult> {
    this.changedFiles.push("src/generated.ts");
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async inspect(_handle: EnvironmentHandle): Promise<EnvironmentReport> {
    return { changedFiles: [...this.changedFiles] };
  }

  async dispose(
    _handle: EnvironmentHandle,
    _outcome: "keep" | "discard"
  ): Promise<void> {}
}

class FakeAgentModel implements AgentModel {
  private turnIndex = 0;

  constructor(
    private readonly turns: AgentModelTurn[],
    private readonly error?: string
  ) {}

  async next(_input: AgentModelInput): Promise<AgentModelTurn> {
    if (this.error) {
      throw new Error(this.error);
    }
    const turn = this.turns[this.turnIndex++];
    if (!turn) {
      throw new Error("FakeAgentModel has no programmed turn remaining");
    }
    return turn;
  }
}

class FixedVerifier implements Verifier {
  constructor(private readonly outcome: VerificationOutcome) {}

  async verify(_input: VerificationInput): Promise<VerificationReport> {
    return {
      outcome: this.outcome,
      checks: [
        {
          name: "configured verification",
          outcome: this.outcome,
          detail: "Controlled by the Phase 0 test harness"
        }
      ]
    };
  }
}

class RequiredFileVerifier implements Verifier {
  constructor(private readonly requiredFile: string) {}

  async verify(input: VerificationInput): Promise<VerificationReport> {
    const passed = input.environment.changedFiles.includes(this.requiredFile);
    return {
      outcome: passed ? "passed" : "failed",
      checks: [
        {
          name: "required file",
          outcome: passed ? "passed" : "failed",
          detail: this.requiredFile
        }
      ]
    };
  }
}

class UnchangedWorkspaceVerifier implements Verifier {
  async verify(input: VerificationInput): Promise<VerificationReport> {
    const passed = input.environment.changedFiles.length === 0;
    return {
      outcome: passed ? "passed" : "failed",
      checks: [
        {
          name: "unchanged workspace",
          outcome: passed ? "passed" : "failed",
          detail: passed ? "No files changed" : "Workspace contains changes"
        }
      ]
    };
  }
}
