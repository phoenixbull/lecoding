import type {
  ApprovalScope,
  ControlPlaneConfig,
  CreateRunInput,
  CreateRunResult,
  EditedApprovalCapability,
  ProjectId,
  ProjectPolicyRule,
  ProjectPolicyRuleResult,
  RunChanges,
  RunEventV1,
  RunHistoryResult,
  RunId,
  RunSummary,
  RunView
} from "@lecoding/contracts";
import type { RunEventSource } from "../src/events.js";
import type {
  DeviceExchangeInput,
  DeviceListing,
  DeviceSummary,
  RunGateway
} from "../src/gateway.js";

/** Control-plane bootstrap with one admin-owned project. */
export const ADMIN_CONFIG: ControlPlaneConfig = {
  projectId: "project-a",
  projects: [{ id: "project-a", role: "admin" }],
  defaultEnvironmentId: "sandbox-v1"
};

export const VIEWER_CONFIG: ControlPlaneConfig = {
  projectId: "project-a",
  projects: [{ id: "project-a", role: "viewer" }],
  defaultEnvironmentId: "sandbox-v1"
};

/** Mimics `LeCodingHttpError` so controllers can classify status codes. */
export class HttpError extends Error {
  public readonly status: number;
  public constructor(operation: string, status: number) {
    super(`${operation}: HTTP ${status}`);
    this.name = "LeCodingHttpError";
    this.status = status;
  }
}

export function makeRunView(overrides: Partial<RunView> = {}): RunView {
  return {
    id: "run-1",
    projectId: "project-a",
    environmentId: "sandbox-v1",
    task: "实现健康检查端点",
    status: "queued",
    ...overrides
  };
}

export function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "run-1",
    projectId: "project-a",
    environmentId: "sandbox-v1",
    task: "实现健康检查端点",
    status: "queued",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

export function makeChanges(overrides: Partial<RunChanges> = {}): RunChanges {
  return {
    changedFiles: ["src/health.ts"],
    unifiedDiff: "diff --git a/src/health.ts b/src/health.ts",
    truncated: false,
    ...overrides
  };
}

export function makeEvent(
  sequence: number,
  overrides: Partial<RunEventV1> = {}
): RunEventV1 {
  return {
    version: 1,
    sequence,
    runId: "run-1",
    type: "status_changed",
    occurredAt: "2026-01-01T00:00:00.000Z",
    data: { status: "running" },
    ...overrides
  } as RunEventV1;
}

export function makeTerminalEvent(sequence: number, status = "succeeded"): RunEventV1 {
  return makeEvent(sequence, { data: { status } });
}

export function makeRule(overrides: Partial<ProjectPolicyRule> = {}): ProjectPolicyRule {
  return {
    id: "rule-1",
    projectId: "project-a",
    capabilityType: "command_exec",
    capabilityHash: "0123456789abcdef",
    constraints: {},
    decision: "allow",
    createdBy: "user-1",
    sourceApprovalId: "approval-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

export interface FakeGateway extends RunGateway {
  calls: Array<{ method: string; args: unknown[] }>;
  createdInputs: CreateRunInput[];
  /** Replaces the RunView returned by every subsequent `inspectRun`. */
  setView(view: RunView): void;
  setHistory(runs: RunSummary[]): void;
  setChanges(runId: RunId, changes: RunChanges): void;
  setChangesFailure(runId: RunId, error: unknown): void;
  setArtifact(runId: RunId, artifactId: string, content: string): void;
  setRules(rules: ProjectPolicyRule[]): void;
  setRulesError(error: unknown | undefined): void;
  setConfig(config: ControlPlaneConfig): void;
  setConfigError(error: unknown | undefined): void;
  /** Makes a method reject with the supplied error until cleared. */
  fail(method: string, error: unknown): void;
  clearFailure(method: string): void;
}

export interface FakeGatewayOptions {
  config?: ControlPlaneConfig;
  configError?: unknown;
  views?: RunView[];
  history?: RunSummary[];
  rules?: ProjectPolicyRule[];
  rulesError?: unknown;
  devices?: DeviceSummary[];
  /** Run id handed back by `createRun`; defaults to an incrementing id. */
  nextRunId?: RunId;
}

export function createFakeGateway(options: FakeGatewayOptions = {}): FakeGateway {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const createdInputs: CreateRunInput[] = [];
  const views = new Map<RunId, RunView>((options.views ?? []).map((v) => [v.id, v]));
  const failures = new Map<string, unknown>();
  const changes = new Map<RunId, RunChanges>();
  const changesFailures = new Map<RunId, unknown>();
  const artifacts = new Map<string, string>();
  let history: RunSummary[] = options.history ?? [];
  let rules: ProjectPolicyRule[] = options.rules ?? [];
  let rulesError: unknown | undefined = options.rulesError;
  const devices: DeviceSummary[] = options.devices ?? [];
  let config: ControlPlaneConfig = options.config ?? ADMIN_CONFIG;
  let configError: unknown | undefined = options.configError;
  let sequence = 0;

  function record(method: string, ...args: unknown[]): void {
    calls.push({ method, args });
  }

  function guard(method: string): void {
    if (failures.has(method)) {
      throw failures.get(method);
    }
  }

  const gateway: FakeGateway = {
    calls,
    createdInputs,
    setView(view) {
      views.set(view.id, view);
    },
    setHistory(runs) {
      history = runs;
    },
    setChanges(runId, value) {
      changes.set(runId, value);
      changesFailures.delete(runId);
    },
    setChangesFailure(runId, error) {
      changesFailures.set(runId, error);
      changes.delete(runId);
    },
    setArtifact(runId, artifactId, content) {
      artifacts.set(`${runId}/${artifactId}`, content);
    },
    setRules(value) {
      rules = value;
    },
    setRulesError(error) {
      rulesError = error;
    },
    setConfig(value) {
      config = value;
    },
    setConfigError(error) {
      configError = error;
    },
    fail(method, error) {
      failures.set(method, error);
    },
    clearFailure(method) {
      failures.delete(method);
    },

    async getControlPlaneConfig() {
      record("getControlPlaneConfig");
      guard("getControlPlaneConfig");
      if (configError !== undefined) {
        throw configError;
      }
      return config;
    },
    async logout() {
      record("logout");
      guard("logout");
    },
    async createRun(projectId: ProjectId, input: CreateRunInput): Promise<CreateRunResult> {
      record("createRun", projectId, input);
      guard("createRun");
      createdInputs.push(input);
      sequence += 1;
      const runId = options.nextRunId ?? `run-created-${sequence}`;
      views.set(runId, makeRunView({ id: runId, task: input.task }));
      return { runId };
    },
    async inspectRun(runId: RunId) {
      record("inspectRun", runId);
      guard("inspectRun");
      const view = views.get(runId);
      if (!view) {
        throw new HttpError("Failed to inspect Run", 404);
      }
      return view;
    },
    async listRuns(projectId: ProjectId, limit?: number): Promise<RunHistoryResult> {
      record("listRuns", projectId, limit);
      guard("listRuns");
      return { runs: history };
    },
    async cancelRun(runId: RunId) {
      record("cancelRun", runId);
      guard("cancelRun");
    },
    async resolveRunResult(runId: RunId, outcome: "keep" | "discard") {
      record("resolveRunResult", runId, outcome);
      guard("resolveRunResult");
    },
    async getRunChanges(runId: RunId) {
      record("getRunChanges", runId);
      guard("getRunChanges");
      if (changesFailures.has(runId)) {
        throw changesFailures.get(runId);
      }
      const value = changes.get(runId);
      if (!value) {
        throw new HttpError("Failed to load changes", 404);
      }
      return value;
    },
    async getRunArtifact(runId: RunId, artifactId: string) {
      record("getRunArtifact", runId, artifactId);
      guard("getRunArtifact");
      const content = artifacts.get(`${runId}/${artifactId}`);
      if (content === undefined) {
        throw new HttpError("Failed to load artifact", 404);
      }
      return content;
    },
    async approveRun(runId: RunId, approvalId: string, scope: ApprovalScope) {
      record("approveRun", runId, approvalId, scope);
      guard("approveRun");
    },
    async rejectRun(runId: RunId, approvalId: string, scope: ApprovalScope) {
      record("rejectRun", runId, approvalId, scope);
      guard("rejectRun");
    },
    async editAndApproveRun(
      runId: RunId,
      approvalId: string,
      replacement: EditedApprovalCapability
    ) {
      record("editAndApproveRun", runId, approvalId, replacement);
      guard("editAndApproveRun");
    },
    async answerRun(runId: RunId, requestId: string, value: string) {
      record("answerRun", runId, requestId, value);
      guard("answerRun");
    },
    async steerRun(runId: RunId, message: string) {
      record("steerRun", runId, message);
      guard("steerRun");
    },
    async listProjectPolicyRules(projectId: ProjectId): Promise<ProjectPolicyRuleResult> {
      record("listProjectPolicyRules", projectId);
      guard("listProjectPolicyRules");
      if (rulesError !== undefined) {
        throw rulesError;
      }
      return { rules };
    },
    async revokeProjectPolicyRule(projectId: ProjectId, ruleId: string) {
      record("revokeProjectPolicyRule", projectId, ruleId);
      guard("revokeProjectPolicyRule");
      rules = rules.filter((rule) => rule.id !== ruleId);
    },
    async createDeviceCode(projectId: ProjectId) {
      record("createDeviceCode", projectId);
      guard("createDeviceCode");
      return { code: "ABCDEFGHI", expiresAt: "2026-01-01T00:05:00.000Z" };
    },
    async exchangeDeviceCode(input: DeviceExchangeInput) {
      record("exchangeDeviceCode", input);
      guard("exchangeDeviceCode");
      devices.push({
        deviceId: `device-${devices.length + 1}`,
        deviceLabel: input.deviceLabel,
        platform: input.platform,
        projectId: input.projectId,
        projectName: "Project A",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-02-01T00:00:00.000Z"
      });
    },
    async listDevices(): Promise<DeviceListing> {
      record("listDevices");
      guard("listDevices");
      return { devices: [...devices] };
    },
    async revokeDevice(deviceId: string) {
      record("revokeDevice", deviceId);
      guard("revokeDevice");
      const index = devices.findIndex((device) => device.deviceId === deviceId);
      if (index >= 0) {
        devices.splice(index, 1);
      }
    }
  };

  return gateway;
}

interface Sink {
  push(event: RunEventV1): void;
  failWith(error: unknown): void;
  close(): void;
}

export interface ManualEventSource extends RunEventSource {
  subscriptions: Array<{ runId: RunId; lastEventId?: string }>;
  emit(runId: RunId, event: RunEventV1): void;
  fail(runId: RunId, error: unknown): void;
  complete(runId: RunId): void;
  subscriptionCount(runId?: RunId): number;
}

/**
 * Event source the test drives by hand.
 *
 * `emit` / `fail` / `complete` let a test reproduce an SSE reconnect, an event
 * burst, or a transport drop without any timers or real network.
 */
export function createManualEventSource(): ManualEventSource {
  const sinks = new Map<RunId, Set<Sink>>();
  const subscriptions: Array<{ runId: RunId; lastEventId?: string }> = [];

  function sinksFor(runId: RunId): Set<Sink> {
    const existing = sinks.get(runId);
    if (existing) {
      return existing;
    }
    const created = new Set<Sink>();
    sinks.set(runId, created);
    return created;
  }

  return {
    subscriptions,
    emit(runId, event) {
      for (const sink of sinksFor(runId)) {
        sink.push(event);
      }
    },
    fail(runId, error) {
      for (const sink of sinksFor(runId)) {
        sink.failWith(error);
      }
    },
    complete(runId) {
      for (const sink of sinksFor(runId)) {
        sink.close();
      }
    },
    subscriptionCount(runId) {
      if (runId === undefined) {
        return subscriptions.length;
      }
      return subscriptions.filter((entry) => entry.runId === runId).length;
    },
    subscribe(runId, options) {
      subscriptions.push({
        runId,
        ...(options.lastEventId !== undefined
          ? { lastEventId: options.lastEventId }
          : {})
      });
      const queue: RunEventV1[] = [];
      let notify: (() => void) | undefined;
      let failure: { error: unknown } | undefined;
      let closed = false;
      const sink: Sink = {
        push(event) {
          queue.push(event);
          notify?.();
        },
        failWith(error) {
          failure = { error };
          notify?.();
        },
        close() {
          closed = true;
          notify?.();
        }
      };
      const active = sinksFor(runId);
      active.add(sink);
      const detach = (): void => {
        active.delete(sink);
        notify?.();
      };
      options.signal.addEventListener("abort", detach, { once: true });
      return {
        async *[Symbol.asyncIterator]() {
          try {
            while (!options.signal.aborted) {
              if (queue.length > 0) {
                yield queue.shift()!;
                continue;
              }
              if (failure) {
                const { error } = failure;
                failure = undefined;
                throw error;
              }
              if (closed) {
                return;
              }
              await new Promise<void>((resolve) => {
                notify = resolve;
              });
              notify = undefined;
            }
          } finally {
            active.delete(sink);
          }
        }
      };
    }
  };
}

/**
 * Drains pending microtasks and timers so controller work triggered by an
 * event (inspect, changes load, notification flush) has completed.
 */
export async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}
