/**
 * Local-runner environment.
 *
 * Implements the same `RunEnvironment` contract as the Docker adapter, but
 * uses an isolated Git worktree managed by `@lecoding/workspace` instead of
 * a Docker container. This is the Phase 4-B seam: the Local Runner on the
 * developer's machine owns the worktree and runs commands directly with
 * `node:child_process`, while the same Workspace invariants (server-derived
 * worktree path, Git-managed source, discard idempotency) apply.
 *
 * The Local Runner does NOT add privilege: commands still execute as the
 * user's normal account inside the worktree, not in a hardened container.
 * `NetworkPolicy` and command allow/deny remain enforced by the same upstream
 * PolicyEngine; the Local Runner simply removes Docker from the resource
 * boundary so the desktop can run offline.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, resolve, sep } from "node:path";
import {
  createBoundedOutputCapture,
  type RunEnvironment
} from "@lecoding/run-environment";
import type {
  EnvironmentHandle,
  EnvironmentResult,
  EnvironmentSpec
} from "@lecoding/contracts";
import {
  SandboxViolationError,
  type FileAccessGrant,
  type HostSandbox,
  type PathViolation
} from "@lecoding/host-sandbox";
import {
  createGitRunChangesReader,
  createGitRunResultManager,
  createGitWorkspace,
  type WorkspaceHandle
} from "@lecoding/workspace";

export interface LocalRunEnvironmentLimits {
  /** Maximum command runtime in milliseconds before the runner kills the process. */
  execTimeoutMs?: number;
  /** Per-stream stdout/stderr cap in bytes; overflow is truncated. */
  outputBytes?: number;
  /**
   * Optional CPU/memory/pid placeholders so the limit record stays compatible
   * with the Docker adapter. The Local Runner does not enforce them at the
   * process boundary; they are surfaced for parity in future telemetry.
   */
  cpuLimit?: number;
  memoryLimitBytes?: number;
  pidsLimit?: number;
}

export interface LocalRunEnvironmentOptions {
  sourceRepo: string;
  worktreeRoot: string;
  limits?: LocalRunEnvironmentLimits;
  /** Optional clock seam so tests can drive timeout / expiry behaviour. */
  now?: () => Date;
  /**
   * Enforces the Run's file access tier at process creation.
   *
   * When present, every `perform` is planned through it, so a command naming a
   * path outside the grant is never created. On macOS the plan also wraps the
   * command in Seatbelt, which confines it inside the kernel.
   *
   * Omitting it means the environment cannot enforce any tier. That is only
   * acceptable for tests and for server-side Git worktrees, which are already
   * confined by the sandbox that owns them.
   */
  sandbox?: HostSandbox;
  /**
   * The Run's authorization, issued by Desktop Main through OS-native dialogs.
   * Required whenever `sandbox` is supplied; the sandbox refuses to plan
   * without it.
   */
  grant?: FileAccessGrant;
  /**
   * Receives every refused command, so out-of-scope attempts reach the audit
   * log even though the process was never created.
   */
  onAccessViolation?: (violation: {
    runId: string;
    executable: string;
    violations: PathViolation[];
  }) => void;
  /**
   * Optional underlying spawn implementation. Defaults to `node:child_process.spawn`.
   * Tests substitute a stub that does not actually fork.
   */
  spawn?: (
    command: string,
    args: string[],
    options: SpawnOptions
  ) => ChildProcessLike;
}

interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio: ["ignore", "pipe", "pipe"];
}

export interface ChildProcessLike {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MIN_OUTPUT_BYTES = 16_384;
const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function createLocalRunEnvironment(
  options: LocalRunEnvironmentOptions
): RunEnvironment {
  const sourceRepo = resolve(options.sourceRepo);
  const worktreeRoot = resolve(options.worktreeRoot);
  const execTimeoutMs = options.limits?.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const outputBytes = options.limits?.outputBytes ?? DEFAULT_OUTPUT_BYTES;
  if (!Number.isSafeInteger(outputBytes) || outputBytes < MIN_OUTPUT_BYTES) {
    throw new Error(`outputBytes must be at least ${MIN_OUTPUT_BYTES}`);
  }
  if (!Number.isSafeInteger(execTimeoutMs) || execTimeoutMs <= 0) {
    throw new Error("execTimeoutMs must be a positive integer");
  }
  const workspace = createGitWorkspace({ worktreeRoot });
  const changesReader = createGitRunChangesReader({
    sourceRepo,
    worktreeRoot
  });
  const resultManager = createGitRunResultManager({
    sourceRepo,
    worktreeRoot
  });

  return {
    async prepare(spec: EnvironmentSpec): Promise<EnvironmentHandle> {
      if (!RUN_ID_PATTERN.test(spec.runId)) {
        throw new Error("Run ID contains unsupported path characters");
      }
      // Admit before creating anything, so a Run the host cannot enforce fails
      // before a worktree exists rather than after the first command runs.
      if (options.sandbox && options.grant) {
        options.sandbox.admit(options.grant);
      }
      const handle: WorkspaceHandle = await workspace.prepare({
        runId: spec.runId,
        sourceRepo,
        baseRef: "HEAD"
      });
      // Stash the worktree path into the handle id so perform() can resolve
      // cwd without going back through the Workspace. The Workspace keeps
      // the canonical record; the handle id is only an opaque pointer.
      const encoded = encodeHandleId(spec.runId, handle.path);
      return {
        id: encoded,
        environmentId: spec.environmentId
      };
    },

    async perform(
      handle: EnvironmentHandle,
      action,
      signal?: AbortSignal
    ): Promise<EnvironmentResult> {
      const decoded = decodeHandleId(handle.id);
      if (action.type !== "execute") {
        throw new Error(
          `Unsupported action type: ${String((action as { type: string }).type)}`
        );
      }
      const command = action.command;
      if (command.length === 0) {
        throw new Error("Action command must be a non-empty array");
      }
      const executable = command[0]!;
      const args = command.slice(1);
      // The sandbox decides what actually gets spawned. On macOS this is where
      // the command is wrapped in Seatbelt; everywhere else it is where an
      // out-of-scope command is refused outright.
      const planned = await planSpawn({
        sandbox: options.sandbox,
        grant: options.grant,
        runId: decoded.runId,
        executable,
        args,
        cwd: decoded.worktreePath,
        ...(options.onAccessViolation
          ? { onViolation: options.onAccessViolation }
          : {})
      });
      const runInput = {
        executable: planned.executable,
        args: planned.args,
        cwd: decoded.worktreePath,
        execTimeoutMs,
        outputBytes,
        spawn: options.spawn ?? defaultSpawn
      } as Parameters<typeof runCommand>[0];
      if (signal) {
        runInput.signal = signal;
      }
      return await runCommand(runInput);
    },

    async inspect(handle: EnvironmentHandle) {
      const decoded = decodeHandleId(handle.id);
      const changes = await changesReader.read(decoded.runId);
      return { changedFiles: changes.changedFiles };
    },

    async dispose(handle: EnvironmentHandle, outcome: "keep" | "discard") {
      const decoded = decodeHandleId(handle.id);
      await resultManager.resolve(decoded.runId, outcome);
    }
  };
}

/**
 * Resolves what to spawn, applying the sandbox when one is configured.
 *
 * With no sandbox the command is returned untouched, which preserves the
 * existing behaviour for tests and for server-owned Git worktrees. With a
 * sandbox, this is the enforcement point: a violation throws and the process is
 * never created.
 */
async function planSpawn(input: {
  sandbox: HostSandbox | undefined;
  grant: FileAccessGrant | undefined;
  runId: string;
  executable: string;
  args: string[];
  cwd: string;
  onViolation?: (violation: {
    runId: string;
    executable: string;
    violations: PathViolation[];
  }) => void;
}): Promise<{ executable: string; args: string[] }> {
  if (!input.sandbox) {
    return { executable: input.executable, args: input.args };
  }
  if (!input.grant) {
    // A sandbox without a grant cannot decide anything, so refuse rather than
    // guess: guessing wrong means the command runs unconfined.
    throw new Error("Local Runner has a sandbox but no FileAccessGrant for this Run");
  }
  try {
    const plan = await input.sandbox.plan({
      grant: input.grant,
      executable: input.executable,
      args: input.args,
      cwd: input.cwd
    });
    return { executable: plan.executable, args: plan.args };
  } catch (error) {
    if (error instanceof SandboxViolationError) {
      // Refusals are evidence: record them so the audit log shows the attempt
      // even though no process was ever created.
      input.onViolation?.({
        runId: input.runId,
        executable: input.executable,
        violations: error.violations
      });
    }
    throw error;
  }
}

/**
 * Internal helper exposed for tests so they can verify the encoded handle
 * survives a prepare/perform round trip without leaking the full object graph.
 */
export function decodeHandleId(id: string): {
  runId: string;
  worktreePath: string;
} {
  const separatorIndex = id.indexOf("::");
  if (separatorIndex <= 0 || separatorIndex === id.length - 2) {
    throw new Error("Local environment handle id is malformed");
  }
  const runId = id.slice(0, separatorIndex);
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error("Local environment handle id is malformed");
  }
  return { runId, worktreePath: id.slice(separatorIndex + 2) };
}

function encodeHandleId(runId: string, worktreePath: string): string {
  return `${runId}::${worktreePath}`;
}

async function runCommand(input: {
  executable: string;
  args: string[];
  cwd: string;
  execTimeoutMs: number;
  outputBytes: number;
  signal?: AbortSignal;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcessLike;
}): Promise<EnvironmentResult> {
  // Reject any executable that is itself a path — Local Runner only runs
  // bare names so PATH-based resolution is the source of authority.
  if (isAbsolute(input.executable) || input.executable.includes(sep)) {
    throw new Error("Command executable must be a bare name on PATH");
  }
  const stdoutCapture = createBoundedOutputCapture(input.outputBytes);
  const stderrCapture = createBoundedOutputCapture(input.outputBytes);
  const child = input.spawn(input.executable, input.args, {
    cwd: input.cwd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (!child.stdout || !child.stderr) {
    throw new Error("Local Runner failed to capture child stdio");
  }
  child.stdout.on("data", (chunk: Buffer | string) => {
    stdoutCapture.append(toBuffer(chunk));
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrCapture.append(toBuffer(chunk));
  });

  let timedOut = false;
  let aborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, input.execTimeoutMs);

  const abortHandler = () => {
    aborted = true;
    child.kill("SIGTERM");
  };
  if (input.signal) {
    if (input.signal.aborted) {
      abortHandler();
    } else {
      input.signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      child.on("exit", (code, signal) => resolveExit({ code, signal }));
      child.on("error", rejectExit);
    }
  ).finally(() => {
    clearTimeout(timer);
    if (input.signal) {
      input.signal.removeEventListener("abort", abortHandler);
    }
  });

  const stdout = stdoutCapture.finish();
  const stderr = stderrCapture.finish();

  if (timedOut) {
    throw new Error(
      `Local Runner exceeded execTimeoutMs=${input.execTimeoutMs}; stdout/stderr captured up to ${input.outputBytes} bytes`
    );
  }
  if (aborted) {
    throw new Error("Local Runner perform aborted by signal");
  }
  return {
    exitCode: exit.code ?? 1,
    stdout: stdout.value,
    stderr: stderr.value
  };
}

function defaultSpawn(
  command: string,
  args: string[],
  options: SpawnOptions
): ChildProcessLike {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio
  }) as ChildProcess;
  return child as unknown as ChildProcessLike;
}

function toBuffer(chunk: Buffer | string): Buffer {
  if (typeof chunk === "string") {
    return Buffer.from(chunk, "utf8");
  }
  return chunk;
}
