import type {
  EnvironmentHandle,
  PendingApproval,
  RunCommand,
  RunEngine,
  RunFailure,
  RunId,
  RunStatus,
  RunView,
  StartRun,
  VerificationReport
} from "@lecoding/contracts";
import type { PolicyEngine } from "@lecoding/policy";
import type { RunEnvironment } from "@lecoding/run-environment";
import type { RunEventJournal } from "@lecoding/run-events";
import type { Verifier } from "@lecoding/verifier";

interface StoredRun {
  id: RunId;
  input: StartRun;
  status: RunStatus;
  handle?: EnvironmentHandle;
  toolResults: ModelToolResult[];
  pendingApproval?: PendingApproval;
  pendingToolCall?: Extract<AgentModelTurn, { type: "tool_call" }>;
  failure?: RunFailure;
  verification?: VerificationReport;
}

export interface RunStore {
  save(run: StoredRun): Promise<void>;
  get(runId: RunId): Promise<StoredRun | undefined>;
}

export interface RunEngineDependencies {
  store: RunStore;
  environment: RunEnvironment;
  model: AgentModel;
  policy: PolicyEngine;
  events: Pick<RunEventJournal, "publish">;
  verifier: Verifier;
  createId(): RunId;
}

export interface AgentModelInput {
  runId: RunId;
  run: StartRun;
  toolResults: ModelToolResult[];
}

export type AgentModelTurn =
  | {
      type: "tool_call";
      callId: string;
      tool: "execute_command";
      arguments: { argv: string[] };
    }
  | { type: "completed"; summary: string };

export type ModelToolResult =
  | {
      callId: string;
      status: "executed";
      exitCode: number;
      stdout: string;
      stderr: string;
    }
  | { callId: string; status: "denied"; reason: string };

export interface AgentModel {
  next(input: AgentModelInput): Promise<AgentModelTurn>;
}

export function createRunEngine(dependencies: RunEngineDependencies): RunEngine {
  return new DefaultRunEngine(dependencies);
}

class DefaultRunEngine implements RunEngine {
  constructor(private readonly dependencies: RunEngineDependencies) {}

  async start(input: StartRun): Promise<RunId> {
    const id = this.dependencies.createId();
    const stored: StoredRun = { id, input, status: "queued", toolResults: [] };
    await this.transition(stored, "queued");

    await this.transition(stored, "preparing");

    stored.handle = await this.dependencies.environment.prepare({
      runId: id,
      projectId: input.projectId,
      environmentId: input.environmentId,
      fileAccessScope: input.fileAccessScope
    });

    await this.transition(stored, "running");

    try {
      await this.drive(stored);
    } catch (error) {
      await this.recordAgentLoopFailure(stored, error);
    }
    return id;
  }

  async command(runId: RunId, command: RunCommand): Promise<void> {
    const stored = await this.requireRun(runId);
    if (command.type === "cancel") {
      await this.transition(stored, "cancelling");
      if (stored.handle) {
        await this.dependencies.environment.dispose(stored.handle, "discard");
      }
      delete stored.pendingApproval;
      delete stored.pendingToolCall;
      await this.transition(stored, "cancelled");
      return;
    }
    if (command.type !== "approve" && command.type !== "reject") {
      throw new Error(`Run command is not implemented: ${command.type}`);
    }
    if (
      stored.status !== "waiting_approval" ||
      stored.pendingApproval?.id !== command.approvalId ||
      !stored.pendingToolCall ||
      !stored.handle
    ) {
      throw new Error(`Approval is not pending: ${command.approvalId}`);
    }

    const toolCall = stored.pendingToolCall;
    delete stored.pendingApproval;
    delete stored.pendingToolCall;
    await this.transition(stored, "running");
    if (command.type === "reject") {
      stored.toolResults.push({
        callId: toolCall.callId,
        status: "denied",
        reason: "User rejected the tool call"
      });
      await this.dependencies.store.save(stored);
      await this.drive(stored);
      return;
    }

    await this.perform(stored, toolCall);
    await this.drive(stored);
  }

  async inspect(runId: RunId): Promise<RunView> {
    const run = await this.requireRun(runId);

    return {
      id: run.id,
      projectId: run.input.projectId,
      environmentId: run.input.environmentId,
      task: run.input.task,
      status: run.status,
      ...(run.pendingApproval
        ? { pendingApproval: run.pendingApproval }
        : {}),
      ...(run.failure ? { failure: run.failure } : {}),
      ...(run.verification ? { verification: run.verification } : {})
    };
  }

  private async drive(stored: StoredRun): Promise<void> {
    if (!stored.handle) {
      throw new Error(`Run environment is not prepared: ${stored.id}`);
    }

    for (;;) {
      const turn = await this.dependencies.model.next({
        runId: stored.id,
        run: stored.input,
        toolResults: stored.toolResults
      });
      if (turn.type === "completed") {
        break;
      }

      const decision = await this.dependencies.policy.authorize({
        approvalMode: stored.input.approvalMode,
        fileAccessScope: stored.input.fileAccessScope,
        capability: {
          type: "command_exec",
          argv: turn.arguments.argv,
          cwd: "."
        }
      });
      if (decision.decision === "ask") {
        stored.pendingToolCall = turn;
        stored.pendingApproval = {
          id: `approval-${turn.callId}`,
          callId: turn.callId,
          summary: `Run ${turn.arguments.argv.join(" ")}`
        };
        await this.transition(stored, "waiting_approval");
        return;
      }
      if (decision.decision === "deny") {
        stored.failure = {
          code: "policy_denied",
          message: decision.reason
        };
        await this.transition(stored, "failed");
        return;
      }

      await this.perform(stored, turn);
    }

    await this.transition(stored, "verifying");

    const environment = await this.dependencies.environment.inspect(stored.handle);
    const verification = await this.dependencies.verifier.verify({
      runId: stored.id,
      run: stored.input,
      environment
    });

    stored.verification = verification;
    await this.transition(
      stored,
      verification.outcome === "passed" ? "succeeded" : "failed"
    );
  }

  private async perform(
    stored: StoredRun,
    turn: Extract<AgentModelTurn, { type: "tool_call" }>
  ): Promise<void> {
    if (!stored.handle) {
      throw new Error(`Run environment is not prepared: ${stored.id}`);
    }
    const result = await this.dependencies.environment.perform(stored.handle, {
      type: "execute",
      command: turn.arguments.argv
    });
    stored.toolResults.push({
      callId: turn.callId,
      status: "executed",
      ...result
    });
    await this.dependencies.store.save(stored);
  }

  private async requireRun(runId: RunId): Promise<StoredRun> {
    const run = await this.dependencies.store.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
  }

  /**
   * Persists state before publishing it so an SSE client can immediately inspect
   * the state named by an event. A database outbox will make both writes atomic.
   */
  private async transition(stored: StoredRun, status: RunStatus): Promise<void> {
    stored.status = status;
    await this.dependencies.store.save(stored);
    await this.dependencies.events.publish({
      runId: stored.id,
      type: "status_changed",
      data: { status }
    });
  }

  private async recordAgentLoopFailure(
    stored: StoredRun,
    error: unknown
  ): Promise<void> {
    stored.failure = {
      code: "agent_loop_failed",
      message: error instanceof Error ? error.message : "Agent loop failed"
    };
    await this.transition(stored, "failed");
  }
}
