/**
 * Bridges the Runner session's environment handlers to the Local Runner.
 *
 * This is the module that makes local execution real rather than test-only:
 * it is where an `env.perform` frame arriving over WSS becomes a process
 * created on the user's machine, inside a worktree, under the sandbox that the
 * `FileAccessGrant` authorizes.
 *
 * Two responsibilities live here and nowhere else:
 *
 * - **Grant resolution.** A command may only run under a grant the user issued
 *   through an OS dialog for that specific Run. There is no default grant and
 *   no implicit workspace-only fallback: an ungranted Run is refused, because
 *   guessing a scope would be the sandbox enforcing a decision nobody made.
 * - **Effect accounting.** Every command is journalled before it runs and
 *   settled when it finishes, so an interrupted command is provably never
 *   re-executed on a reconnect.
 */

import type { FileAccessScope, JsonValue } from "@lecoding/contracts";
import {
  createLocalRunEnvironment,
  type LocalRunEnvironmentOptions
} from "@lecoding/local-runner";
import type {
  FileAccessGrant,
  HostSandbox,
  PathViolation
} from "@lecoding/host-sandbox";
import { createAccessAuditLog } from "@lecoding/host-sandbox";
import type { RunnerEnvironmentHandlers } from "@lecoding/runner-protocol";
import type { LocalRunnerHost } from "./local-runner-host.js";

/** Audited refusal of a command whose paths fall outside the grant. */
interface AccessViolation {
  runId: string;
  executable: string;
  violations: PathViolation[];
}

export interface LocalRunnerHandlerOptions {
  sandbox: HostSandbox;
  /** Effects ledger and recovery state. */
  host: LocalRunnerHost;
  /**
   * Resolves the Run's grant, issuing one through an OS dialog if needed.
   *
   * Asynchronous by necessity: for `selected_directories` and `host_full` the
   * grant cannot exist until the user has answered a real OS prompt. Returning
   * undefined means the user declined or the dialog was unavailable, and the
   * command is refused rather than run under an inferred scope.
   */
  resolveGrant(input: {
    runId: string;
    scope: FileAccessScope;
    worktreePath: string;
  }): Promise<FileAccessGrant | undefined>;
  /** Absolute path of the project source repository. */
  sourceRepo: string;
  /** Absolute path all Run worktrees are created under. */
  worktreeRoot: string;
  /** Absolute path of the append-only host-access audit log. */
  auditLogPath: string;
  /** Absolute worktree the Run will be prepared into; named in the grant. */
  worktreePathFor(runId: string): string;
  now(): string;
  /** Bounds `perform` when the caller does not supply one. */
  limits?: LocalRunEnvironmentOptions["limits"];
}

export function createLocalRunnerHandlers(
  options: LocalRunnerHandlerOptions
): RunnerEnvironmentHandlers {
  const audit = createAccessAuditLog({
    filePath: options.auditLogPath,
    now: options.now
  });

  /** Records a refusal, so an attempt outside the grant is still evidence. */
  async function recordViolation(violation: AccessViolation): Promise<void> {
    for (const entry of violation.violations) {
      await audit.append({
        runId: violation.runId,
        kind: "execute",
        path: entry.canonicalPath,
        origin: "command_argv",
        outOfScope: true
      });
    }
  }

  /** Resolves the grant or refuses; never infers one. */
  async function requireGrant(input: {
    runId: string;
    scope: FileAccessScope;
    worktreePath: string;
  }): Promise<FileAccessGrant> {
    const grant = await options.resolveGrant(input);
    if (!grant) {
      // Refusing is the only safe answer: running under an inferred scope would
      // have the sandbox enforce a decision the user never made.
      throw new Error(
        `No FileAccessGrant was issued for run ${input.runId}; refusing to execute locally`
      );
    }
    return grant;
  }

  /**
   * What `prepare` established, keyed by the handle the server holds.
   *
   * Everything a later operation needs — the Run it belongs to, the scope the
   * user authorized, the environment built under that grant — is recorded here
   * at prepare time and looked up afterwards. Later operations carry only the
   * handle id, so they cannot name a different Run or a wider scope than the
   * grant covered, and there is no default to fall back to.
   */
  const prepared = new Map<
    string,
    {
      runId: string;
      scope: FileAccessScope;
      environment: Awaited<ReturnType<typeof buildEnvironment>>;
    }
  >();

  /** One environment per Run, because a grant is per Run. */
  async function buildEnvironment(input: {
    runId: string;
    scope: FileAccessScope;
  }) {
    return createLocalRunEnvironment({
      sourceRepo: options.sourceRepo,
      worktreeRoot: options.worktreeRoot,
      sandbox: options.sandbox,
      grant: await requireGrant({
        runId: input.runId,
        scope: input.scope,
        worktreePath: options.worktreePathFor(input.runId)
      }),
      ...(options.limits ? { limits: options.limits } : {}),
      onAccessViolation: (violation: AccessViolation) => {
        void recordViolation(violation);
      }
    });
  }

  /** The prepared state for a handle, or a refusal if prepare never happened. */
  function requirePrepared(handleId: string, op: string) {
    const record = prepared.get(handleId);
    if (!record) {
      // Refuse rather than rebuild: rebuilding would issue a fresh grant for a
      // handle the user may never have authorized.
      throw new Error(`${op} references a handle that was never prepared here`);
    }
    return record;
  }

  return {
    async prepare(payload, _signal, context) {
      const runId = requireRunId(payload);
      const spec = parseSpec(payload, runId);
      const environment = await buildEnvironment({
        runId,
        scope: spec.fileAccessScope
      });
      const handle = await environment.prepare(spec);
      prepared.set(handle.id, {
        runId,
        scope: spec.fileAccessScope,
        environment
      });
      await options.host.beginCommand({ runId, commandId: context.commandId });
      await options.host.settleCommand({
        runId,
        commandId: context.commandId,
        outcome: { ok: true, value: { handleId: handle.id } as JsonValue }
      });
      return { handleId: handle.id };
    },

    async perform(payload, signal, context) {
      const handle = requireHandle(payload);
      const record = requirePrepared(handle.id, "env.perform");
      const command = requireCommand(payload);
      await options.host.beginCommand({
        runId: record.runId,
        commandId: context.commandId
      });
      try {
        const result = await record.environment.perform(
          handle,
          { type: "execute", command },
          signal
        );
        const outcome = { ok: true, value: result as unknown as JsonValue } as const;
        await options.host.settleCommand({
          runId: record.runId,
          commandId: context.commandId,
          outcome
        });
        return result as unknown as JsonValue;
      } catch (error) {
        // Settling the failure is what makes the command replayable-from-cache
        // rather than re-runnable, so a reconnect cannot repeat its effects.
        await options.host.settleCommand({
          runId: record.runId,
          commandId: context.commandId,
          outcome: {
            ok: false,
            code: "internal",
            message: error instanceof Error ? error.message : "Local execution failed"
          }
        });
        throw error;
      }
    },

    async inspect(payload, _signal, context) {
      const handle = requireHandle(payload);
      const record = requirePrepared(handle.id, "env.inspect");
      await options.host.beginCommand({
        runId: record.runId,
        commandId: context.commandId
      });
      const report = await record.environment.inspect(handle);
      await options.host.settleCommand({
        runId: record.runId,
        commandId: context.commandId,
        outcome: { ok: true, value: report as unknown as JsonValue }
      });
      return report as unknown as JsonValue;
    },

    async dispose(payload, _signal, context) {
      const handle = requireHandle(payload);
      const record = requirePrepared(handle.id, "env.dispose");
      const outcome = requireOutcome(payload);
      await options.host.beginCommand({
        runId: record.runId,
        commandId: context.commandId
      });
      // Idempotency and the keep/discard decision belong to the host, which
      // owns the durable record of what the user already chose.
      const resolved = await options.host.resolve({ runId: record.runId, outcome });
      /*
       * Apply the *effective* outcome, not this request's.
       *
       * `resolved.effectiveOutcome` is the first decision when one existed. A
       * replayed discard after a keep must leave the worktree kept: handing the
       * request's outcome to `dispose` here would re-run the Git resolution the
       * other way and destroy changes the user chose to keep.
       */
      await record.environment.dispose(handle, resolved.effectiveOutcome);
      await options.host.settleCommand({
        runId: record.runId,
        commandId: context.commandId,
        outcome: { ok: true, value: resolved as unknown as JsonValue }
      });
      prepared.delete(handle.id);
      return resolved as unknown as JsonValue;
    }
  };
}

type Record = { [key: string]: JsonValue | undefined };

function asRecord(value: JsonValue | undefined, op: string): Record {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${op} received a non-object payload`);
  }
  return value as Record;
}

function requireRunId(payload: JsonValue | undefined): string {
  const record = asRecord(payload, "env");
  const runId = record["runId"];
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("Local Runner command is missing its runId");
  }
  return runId;
}

function parseSpec(payload: JsonValue | undefined, runId: string) {
  const record = asRecord(payload, "env.prepare");
  const projectId = record["projectId"];
  const environmentId = record["environmentId"];
  const scope = record["fileAccessScope"];
  if (
    typeof projectId !== "string" ||
    typeof environmentId !== "string" ||
    (scope !== "workspace_only" && scope !== "selected_directories" && scope !== "host_full")
  ) {
    throw new Error("env.prepare received an invalid spec");
  }
  return { runId, projectId, environmentId, fileAccessScope: scope } as const;
}

function requireHandle(payload: JsonValue | undefined) {
  const record = asRecord(payload, "env");
  const handleId = record["handleId"];
  if (typeof handleId !== "string" || handleId.length === 0) {
    throw new Error("Local Runner command is missing its handleId");
  }
  return { id: handleId, environmentId: "" };
}

function requireCommand(payload: JsonValue | undefined): string[] {
  const record = asRecord(payload, "env.perform");
  const command = record["command"];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("env.perform received an invalid command");
  }
  return command as string[];
}

function requireOutcome(payload: JsonValue | undefined): "keep" | "discard" {
  const record = asRecord(payload, "env.dispose");
  const outcome = record["outcome"];
  if (outcome !== "keep" && outcome !== "discard") {
    throw new Error("env.dispose received an invalid outcome");
  }
  return outcome;
}
