/**
 * DesktopLocalEnvironment adapter.
 *
 * Wraps the LocalRunEnvironment with desktop-only affordances:
 * - ApprovalGate: prompts the user (UI dialog) before prepare; host_full
 *   requires explicit danger acknowledgement because it lets commands touch
 *   arbitrary host paths.
 * - KeepOrDiscardGate: prompts the user at dispose time; the gate's decision
 *   wins over the caller-supplied outcome so user choices survive transport.
 * - HostAccessLog: a write-only record of file paths touched outside the
 *   canonical worktree. The Renderer subscribes via the public log reader.
 * - StateObserver: UI-friendly lifecycle events emitted in documentable order.
 *
 * The adapter satisfies the same RunEnvironment interface contract that
 * ServerDockerEnvironment and LocalRunEnvironment satisfy, so RunEngine
 * stays adapter-agnostic.
 */

import { resolve } from "node:path";
import type {
  EnvironmentAction,
  EnvironmentHandle,
  EnvironmentReport,
  EnvironmentResult,
  EnvironmentSpec,
  FileAccessScope
} from "@lecoding/contracts";
import type { RunEnvironment } from "@lecoding/run-environment";
import {
  createLocalRunEnvironment,
  type LocalRunEnvironmentOptions
} from "@lecoding/local-runner";

/** What the desktop UI shows the user before prepare. */
export interface ApprovalRequest {
  runId: string;
  projectId: string;
  environmentId: string;
  fileAccessScope: FileAccessScope;
  /**
   * True when the scope is host_full. The UI must render a danger acknowledgement
   * (e.g. "I understand this command may modify files outside the workspace")
   * and only return approved: true after the user ticks it.
   */
  requiresDangerAcknowledgement: boolean;
}

/** The user's answer to the approval prompt. */
export type ApprovalDecision =
  | { approved: true }
  | { approved: false; reason: string };

/** What the desktop UI shows the user before keep/discard. */
export interface KeepOrDiscardRequest {
  runId: string;
  worktreePath: string;
  changedFiles: string[];
  callerOutcome: "keep" | "discard";
}

/** The user's answer to the keep/discard prompt. */
export type KeepDecision =
  | { outcome: "keep"; targetBranch?: string }
  | { outcome: "discard" };

/** ApprovalGate is invoked once per Run before prepare. */
export type ApprovalGate = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/** KeepOrDiscardGate is invoked once per Run before dispose. */
export type KeepOrDiscardGate = (
  request: KeepOrDiscardRequest
) => Promise<KeepDecision>;

/** A single row of the host-access audit log. */
export interface HostAccessRecord {
  runId: string;
  kind: "read" | "write" | "execute";
  path: string;
  /**
   * Provenance of the access; the adapter can extend this in the future
   * (e.g. "policy_engine" once the policy package emits the row).
   */
  origin: "command_argv" | "policy_engine" | "user_supplied";
  /**
   * True if the path is outside the canonical worktree. The Renderer uses
   * this flag to colour the audit row red.
   */
  outOfScope: boolean;
  recordedAt: string;
}

/**
 * UI-facing lifecycle event. The observer receives these in a strict order:
 *   awaiting_approval → prepared → (perform happens) → awaiting_keep/discard → terminal
 * The Runner itself doesn't emit a "running" event because perform is invoked
 * by RunEngine and the RunEnvironment interface doesn't carry lifecycle hooks.
 */
export type DesktopLocalRunState =
  | {
      kind: "awaiting_approval";
      runId: string;
      scope: FileAccessScope;
    }
  | {
      kind: "prepared";
      runId: string;
      handleId: string;
    }
  | {
      kind: "awaiting_keep/discard";
      runId: string;
    }
  | {
      kind: "terminal";
      runId: string;
      outcome: "keep" | "discard";
    };

export type StateObserver = (state: DesktopLocalRunState) => void;

/** Inputs to createDesktopRunEnvironment. */
export interface DesktopRunEnvironmentOptions {
  sourceRepo: string;
  worktreeRoot: string;
  approvalGate: ApprovalGate;
  keepOrDiscardGate: KeepOrDiscardGate;
  /** Optional underlying Local environment; tests inject a stub. */
  environment?: RunEnvironment;
  observer?: StateObserver;
  /**
   * Pass-through LocalRunner limits so the adapter can construct the default
   * Local environment when none is provided.
   */
  localLimits?: LocalRunEnvironmentOptions["limits"];
}

/**
 * Public API returned to the caller. Mirrors the RunEnvironment interface so
 * RunEngine sees a single adapter, plus the desktop-specific audit log surface.
 */
export interface DesktopRunEnvironment extends RunEnvironment {
  /** Append a host-access record to the audit log. */
  recordHostAccess(entry: Omit<HostAccessRecord, "outOfScope" | "recordedAt">): void;
  /** Snapshot the current audit log. */
  readHostAccessLog(): HostAccessRecord[];
}

/**
 * Factory: returns a RunEnvironment that satisfies the DesktopLocalEnvironment
 * contract documented in the PRD § 15. The adapter composes a LocalRunEnvironment
 * by default; tests can substitute an explicit environment for isolation.
 */
export function createDesktopRunEnvironment(
  options: DesktopRunEnvironmentOptions
): DesktopRunEnvironment {
  const underlying =
    options.environment ??
    createLocalRunEnvironment({
      sourceRepo: options.sourceRepo,
      worktreeRoot: options.worktreeRoot,
      ...(options.localLimits ? { limits: options.localLimits } : {})
    });
  const worktreeRoot = resolve(options.worktreeRoot);
  const accessLog: HostAccessRecord[] = [];
  const observer = options.observer;

  function classifyPath(path: string): boolean {
    // In-scope iff the resolved path is strictly inside (or equal to) the
    // registered worktree root. Symlinks are not dereferenced here; the
    // LocalRunner is the canonical authority for what the worktree path
    // actually is.
    const resolved = resolve(path);
    if (resolved === worktreeRoot) {
      return true;
    }
    return resolved.startsWith(worktreeRoot + "/");
  }

  function recordHostAccess(
    entry: Omit<HostAccessRecord, "outOfScope" | "recordedAt">
  ): void {
    accessLog.push({
      ...entry,
      outOfScope: !classifyPath(entry.path),
      recordedAt: new Date().toISOString()
    });
  }

  function emit(state: DesktopLocalRunState): void {
    observer?.(state);
  }

  return {
    async prepare(spec: EnvironmentSpec): Promise<EnvironmentHandle> {
      // Approval gate runs before any worktree is created so a denied user
      // never pollutes the host filesystem.
      emit({
        kind: "awaiting_approval",
        runId: spec.runId,
        scope: spec.fileAccessScope
      });
      const decision = await options.approvalGate({
        runId: spec.runId,
        projectId: spec.projectId,
        environmentId: spec.environmentId,
        fileAccessScope: spec.fileAccessScope,
        requiresDangerAcknowledgement: spec.fileAccessScope === "host_full"
      });
      if (!decision.approved) {
        throw new Error(
          `Desktop approval denied for run ${spec.runId}: ${decision.reason}`
        );
      }
      const handle = await underlying.prepare(spec);
      emit({ kind: "prepared", runId: spec.runId, handleId: handle.id });
      return handle;
    },

    async perform(
      handle: EnvironmentHandle,
      action: EnvironmentAction,
      signal?: AbortSignal
    ): Promise<EnvironmentResult> {
      return await underlying.perform(handle, action, signal);
    },

    async inspect(handle: EnvironmentHandle): Promise<EnvironmentReport> {
      return await underlying.inspect(handle);
    },

    async dispose(
      handle: EnvironmentHandle,
      outcome: "keep" | "discard"
    ): Promise<void> {
      // Surface changed files to the gate so the user can decide with evidence.
      let changedFiles: string[] = [];
      let worktreePath = "";
      try {
        const report = await underlying.inspect(handle);
        changedFiles = report.changedFiles;
      } catch {
        // inspect failure is non-fatal; the gate can still ask the user.
      }
      try {
        // The Local adapter encodes the worktree path in the handle id; we
        // try to extract it so the UI can show "this worktree" in the dialog.
        // If the underlying adapter uses a different handle format, the gate
        // receives an empty worktreePath and degrades gracefully.
        const separator = handle.id.indexOf("::");
        if (separator > 0) {
          worktreePath = handle.id.slice(separator + 2);
        }
      } catch {
        worktreePath = "";
      }
      emit({ kind: "awaiting_keep/discard", runId: handle.environmentId });
      const decision = await options.keepOrDiscardGate({
        // RunEnvironment's EnvironmentHandle only carries environmentId, so we
        // map it back through the spec passed to prepare; here we use the handle
        // environmentId as a fallback. The Local adapter stores the runId inside
        // the handle id; for non-Local adapters, the gate still receives a
        // request keyed on environmentId.
        runId: worktreePath
          ? worktreePath.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? handle.environmentId
          : handle.environmentId,
        worktreePath,
        changedFiles,
        callerOutcome: outcome
      });
      // The user-confirmed outcome ALWAYS wins over the caller-supplied one.
      const effective = decision.outcome;
      try {
        await underlying.dispose(handle, effective);
      } finally {
        emit({ kind: "terminal", runId: handle.environmentId, outcome: effective });
      }
    },

    recordHostAccess,
    readHostAccessLog(): HostAccessRecord[] {
      // Return a defensive copy so callers can't mutate the internal log.
      return accessLog.map((entry) => ({ ...entry }));
    }
  };
}