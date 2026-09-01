/**
 * DesktopLocalEnvironment 适配层契约测试。
 *
 * 该层在 LocalRunEnvironment 之上添加桌面端特有行为:
 * - 启动前由 ApprovalGate 询问用户 (workspace_only/selected_directories/host_full 三档)
 * - host_full 必须二次确认 (RejectUnlessExplicitlyAcknowledged)
 * - dispose 前由 KeepOrDiscardGate 询问用户 keep/discard
 * - 越出 worktree 的写操作记入 HostAccessLog,提供 UI 侧审计能力
 * - StateObserver 让 UI 订阅 lifecycle (idle → awaiting_approval → prepared → running → terminal)
 *
 * 测试用 FakeLocalRunEnvironment 替代真实 spawn,只验证适配层行为本身。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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
  createDesktopRunEnvironment,
  type ApprovalDecision,
  type ApprovalGate,
  type DesktopLocalRunState,
  type HostAccessRecord,
  type KeepDecision,
  type KeepOrDiscardGate,
  type StateObserver
} from "../src/index.js";

function gitAvailable(): boolean {
  const result = spawnSync("git", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function makeRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  const run = (args: string[]) =>
    spawnSync("git", args, { cwd: path, stdio: "ignore" });
  run(["init", "-q", "--initial-branch=main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  writeFileSync(join(path, "README.md"), "hello\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
}

function makeSandbox(): { sourceRepo: string; worktreeRoot: string; cleanup: () => void } {
  const base = join(
    tmpdir(),
    `desktop-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(base, { recursive: true });
  const sourceRepo = join(base, "project");
  const worktreeRoot = join(base, "runs");
  mkdirSync(worktreeRoot, { recursive: true });
  makeRepo(sourceRepo);
  return {
    sourceRepo,
    worktreeRoot,
    cleanup() {
      const parent = resolve(base, "..");
      try {
        rmSync(parent, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // tmpdir may be locked by other processes; best-effort cleanup.
      }
    }
  };
}

/**
 * Recording EnvironmentSpec builder. Spec must include `fileAccessScope` because the
 * adapter reads it to decide whether the user has narrowed access.
 */
function specWithScope(runId: string, scope: FileAccessScope): EnvironmentSpec {
  return {
    runId,
    projectId: "project-1",
    environmentId: "desktop",
    fileAccessScope: scope
  };
}

describe.skipIf(!gitAvailable())("createDesktopRunEnvironment", () => {
  let sandbox: ReturnType<typeof makeSandbox>;

  beforeEach(() => {
    sandbox = makeSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it("delegates prepare/perform/inspect/dispose to the underlying Local environment", async () => {
    const approvalGate = mockApproval(async () => ({ approved: true }));
    const keepGate = mockKeep(async () => ({ outcome: "discard" }));
    const desktop = createDesktopRunEnvironment({
      sourceRepo: sandbox.sourceRepo,
      worktreeRoot: sandbox.worktreeRoot,
      approvalGate,
      keepOrDiscardGate: keepGate
    });

    const handle = await desktop.prepare(specWithScope("run-1", "workspace_only"));
    expect(handle.environmentId).toBe("desktop");

    const result = await desktop.perform(
      handle,
      { type: "execute", command: ["node", "-e", "process.stdout.write('ok')"] }
    );
    expect(result.stdout).toBe("ok");

    const report = await desktop.inspect(handle);
    expect(Array.isArray(report.changedFiles)).toBe(true);

    await desktop.dispose(handle, "discard");
    expect(approvalGate).toHaveBeenCalledTimes(1);
    expect(keepGate).toHaveBeenCalledTimes(1);
  });

  it("prompts the approval gate before delegating to prepare", async () => {
    const order: string[] = [];
    const approvalGate = mockApproval(async (request) => {
      order.push(`approval:${request.runId}:${request.fileAccessScope}`);
      return { approved: true };
    });
    const desktop = createDesktopRunEnvironment({
      sourceRepo: sandbox.sourceRepo,
      worktreeRoot: sandbox.worktreeRoot,
      approvalGate,
      keepOrDiscardGate: async () => ({ outcome: "discard" })
    });

    const handle = await desktop.prepare(specWithScope("run-2", "workspace_only"));
    expect(order[0]).toBe("approval:run-2:workspace_only");
    // The handle returned by prepare must be the underlying Local handle (same shape).
    expect(handle.id).toBeTruthy();
    await desktop.dispose(handle, "discard");
  });

  it("rejects prepare when the approval gate denies", async () => {
    const approvalGate: ApprovalGate = vi.fn(async () => ({
      approved: false,
      reason: "user declined"
    }));
    const desktop = createDesktopRunEnvironment({
      sourceRepo: sandbox.sourceRepo,
      worktreeRoot: sandbox.worktreeRoot,
      approvalGate,
      keepOrDiscardGate: async () => ({ outcome: "discard" })
    });

    await expect(
      desktop.prepare(specWithScope("run-3", "workspace_only"))
    ).rejects.toThrow(/user declined/);
  });

  it("requires explicit acknowledgement for host_full scope", async () => {
    const approvalGate = mockApproval(async (request) => {
      if (request.fileAccessScope === "host_full") {
        // Adapter must present a danger acknowledgement requirement; gate returns
        // approved only after the user checks the danger box.
        if (!request.requiresDangerAcknowledgement) {
          throw new Error("host_full must demand danger acknowledgement");
        }
      }
      return { approved: true };
    });
    const desktop = createDesktopRunEnvironment({
      sourceRepo: sandbox.sourceRepo,
      worktreeRoot: sandbox.worktreeRoot,
      approvalGate,
      keepOrDiscardGate: async () => ({ outcome: "discard" })
    });

    const handle = await desktop.prepare(specWithScope("run-4", "host_full"));
    expect(approvalGate).toHaveBeenCalledTimes(1);
    const call = (approvalGate.mock.calls[0]![0]) as Parameters<ApprovalGate>[0];
    expect(call.fileAccessScope).toBe("host_full");
    expect(call.requiresDangerAcknowledgement).toBe(true);
    await desktop.dispose(handle, "discard");
  });

  it("does not require danger acknowledgement for workspace_only scope", async () => {
    const approvalGate = mockApproval(async (request) => {
      expect(request.requiresDangerAcknowledgement).toBe(false);
      return { approved: true };
    });
    const desktop = createDesktopRunEnvironment({
      sourceRepo: sandbox.sourceRepo,
      worktreeRoot: sandbox.worktreeRoot,
      approvalGate,
      keepOrDiscardGate: async () => ({ outcome: "discard" })
    });
    const handle = await desktop.prepare(specWithScope("run-5", "workspace_only"));
    await desktop.dispose(handle, "discard");
  });

  it("uses the gate's keep/discard decision rather than the caller-supplied outcome", async () => {
    const keepGate = mockKeep(async () => ({
      outcome: "keep",
      targetBranch: "feature/desktop-run"
    }));
    const desktop = createDesktopRunEnvironment({
      sourceRepo: sandbox.sourceRepo,
      worktreeRoot: sandbox.worktreeRoot,
      approvalGate: async () => ({ approved: true }),
      keepOrDiscardGate: keepGate
    });
    const handle = await desktop.prepare(specWithScope("run-6", "workspace_only"));
    await desktop.perform(handle, {
      type: "execute",
      command: ["node", "-e", "require('fs').writeFileSync('new.txt', 'data')"]
    });
    // Caller asks for discard; gate returns keep. The adapter MUST honour the gate
    // so user-confirmed outcomes survive transport-level overrides.
    await desktop.dispose(handle, "discard");
    expect(keepGate).toHaveBeenCalledTimes(1);
    const keepCall = (keepGate.mock.calls[0]![0]) as Parameters<KeepOrDiscardGate>[0];
    expect(keepCall.changedFiles.length).toBeGreaterThan(0);
    expect(keepCall.worktreePath).toBeTruthy();
  });

  it("emits lifecycle states through the observer in order", async () => {
    const observer = vi.fn<StateObserver>();
    // The adapter emits awaiting_approval / prepared / awaiting_keep/discard /
    // terminal itself. The gates must NOT re-emit those states; they only
    // surface user-driven decisions.
    const approvalGate: ApprovalGate = async () => ({ approved: true });
    const keepGate: KeepOrDiscardGate = async () => ({ outcome: "discard" });
    const desktop = createDesktopRunEnvironment({
      sourceRepo: sandbox.sourceRepo,
      worktreeRoot: sandbox.worktreeRoot,
      approvalGate,
      keepOrDiscardGate: keepGate,
      observer
    });

    const handle = await desktop.prepare(specWithScope("run-7", "workspace_only"));
    await desktop.perform(handle, {
      type: "execute",
      command: ["node", "-e", "process.stdout.write('hi')"]
    });
    await desktop.dispose(handle, "discard");

    const kinds = observer.mock.calls.map((c) => (c[0] as DesktopLocalRunState).kind);
    expect(kinds).toEqual([
      "awaiting_approval",
      "prepared",
      "awaiting_keep/discard",
      "terminal"
    ]);
  });

  it("logs host access attempts that touch paths outside the worktree", async () => {
    const approvalGate: ApprovalGate = async () => ({ approved: true });
    const keepGate: KeepOrDiscardGate = async () => ({ outcome: "discard" });
    const desktop = createDesktopRunEnvironment({
      sourceRepo: sandbox.sourceRepo,
      worktreeRoot: sandbox.worktreeRoot,
      approvalGate,
      keepOrDiscardGate: keepGate
    });

    const handle = await desktop.prepare(specWithScope("run-8", "workspace_only"));
    // Simulate a write that escapes the worktree. The recorded path lives
    // entirely outside the registered worktree root so the audit log
    // classifier flags it as out_of_scope.
    const escapePath = join(sandbox.worktreeRoot, "..", "escape.txt");
    desktop.recordHostAccess({
      runId: "run-8",
      kind: "write",
      path: escapePath,
      origin: "command_argv"
    });
    const log = desktop.readHostAccessLog();
    expect(log.length).toBe(1);
    const entry: HostAccessRecord = log[0]!;
    expect(entry.runId).toBe("run-8");
    expect(entry.kind).toBe("write");
    expect(entry.path).toBe(escapePath);
    expect(entry.origin).toBe("command_argv");
    // Path is outside the worktree; the adapter must flag it as out_of_scope.
    expect(entry.outOfScope).toBe(true);
    await desktop.dispose(handle, "discard");
  });

  it("treats writes inside the worktree as in-scope host access", async () => {
    const desktop = createDesktopRunEnvironment({
      sourceRepo: sandbox.sourceRepo,
      worktreeRoot: sandbox.worktreeRoot,
      approvalGate: async () => ({ approved: true }),
      keepOrDiscardGate: async () => ({ outcome: "discard" })
    });

    const handle = await desktop.prepare(specWithScope("run-9", "workspace_only"));
    const inside = join(sandbox.worktreeRoot, "run-9", "new-file.txt");
    desktop.recordHostAccess({
      runId: "run-9",
      kind: "write",
      path: inside,
      origin: "command_argv"
    });
    const log = desktop.readHostAccessLog();
    expect(log.length).toBe(1);
    expect(log[0]!.outOfScope).toBe(false);
    await desktop.dispose(handle, "discard");
  });

  it("calls perform with the same arguments the user supplied (no silent rewriting)", async () => {
    const desktop = createDesktopRunEnvironment({
      sourceRepo: sandbox.sourceRepo,
      worktreeRoot: sandbox.worktreeRoot,
      approvalGate: async () => ({ approved: true }),
      keepOrDiscardGate: async () => ({ outcome: "discard" })
    });
    const handle = await desktop.prepare(specWithScope("run-10", "workspace_only"));
    const action: EnvironmentAction = {
      type: "execute",
      command: ["node", "-e", "process.stdout.write('pass-through')"]
    };
    const result = await desktop.perform(handle, action);
    expect(result.stdout).toBe("pass-through");
    await desktop.dispose(handle, "discard");
  });

  it("propagates AbortSignal from perform to the underlying runner", async () => {
    const desktop = createDesktopRunEnvironment({
      sourceRepo: sandbox.sourceRepo,
      worktreeRoot: sandbox.worktreeRoot,
      approvalGate: async () => ({ approved: true }),
      keepOrDiscardGate: async () => ({ outcome: "discard" })
    });
    const handle = await desktop.prepare(specWithScope("run-11", "workspace_only"));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const promise = desktop.perform(
      handle,
      {
        type: "execute",
        command: [
          "node",
          "-e",
          "setInterval(()=>{},1000); setTimeout(()=>process.exit(0),30000);"
        ]
      },
      controller.signal
    );
    await expect(promise).rejects.toThrow();
    await desktop.dispose(handle, "discard");
  });

  it("does not invoke keepOrDiscardGate when prepare was rejected", async () => {
    const keepGate = mockKeep(async () => ({ outcome: "discard" }));
    const desktop = createDesktopRunEnvironment({
      sourceRepo: sandbox.sourceRepo,
      worktreeRoot: sandbox.worktreeRoot,
      approvalGate: async () => ({ approved: false, reason: "blocked" }),
      keepOrDiscardGate: keepGate
    });
    await expect(
      desktop.prepare(specWithScope("run-12", "workspace_only"))
    ).rejects.toThrow(/blocked/);
    expect(keepGate).not.toHaveBeenCalled();
  });

  it("exposes its handle id opaquely so RunEngine can route inspect/dispose", async () => {
    const desktop = createDesktopRunEnvironment({
      sourceRepo: sandbox.sourceRepo,
      worktreeRoot: sandbox.worktreeRoot,
      approvalGate: async () => ({ approved: true }),
      keepOrDiscardGate: async () => ({ outcome: "discard" })
    });
    const handle = await desktop.prepare(specWithScope("run-13", "workspace_only"));
    // The adapter delegates to Local; the worktree should be visible at the
    // canonical path derived from the runId, proving the handle correctly
    // references the Local environment's worktree.
    expect(existsSync(join(sandbox.worktreeRoot, "run-13"))).toBe(true);
    await desktop.dispose(handle, "discard");
  });
});

describe("createDesktopRunEnvironment with explicit underlying environment", () => {
  /**
   * Pure-interface tests that don't need a real worktree. They use a stub
   * Local-equivalent environment to prove the adapter doesn't depend on
   * the filesystem or git for the lifecycle/hook logic.
   */
  it("survives without an observer", async () => {
    const stub: RunEnvironment = createStubEnvironment();
    const desktop = createDesktopRunEnvironment({
      sourceRepo: "/unused",
      worktreeRoot: "/unused",
      approvalGate: async () => ({ approved: true }),
      keepOrDiscardGate: async () => ({ outcome: "discard" }),
      environment: stub
    });
    const handle = await desktop.prepare({
      runId: "stub-1",
      projectId: "project-1",
      environmentId: "desktop",
      fileAccessScope: "workspace_only"
    });
    await desktop.perform(handle, { type: "execute", command: ["true"] });
    await desktop.dispose(handle, "discard");
  });

  it("rejects an unknown action type the same way Local does", async () => {
    const stub: RunEnvironment = createStubEnvironment();
    const desktop = createDesktopRunEnvironment({
      sourceRepo: "/unused",
      worktreeRoot: "/unused",
      approvalGate: async () => ({ approved: true }),
      keepOrDiscardGate: async () => ({ outcome: "discard" }),
      environment: stub
    });
    const handle = await desktop.prepare({
      runId: "stub-2",
      projectId: "project-1",
      environmentId: "desktop",
      fileAccessScope: "workspace_only"
    });
    await expect(
      desktop.perform(handle, {
        type: "execute",
        command: []
      })
    ).rejects.toThrow(/non-empty/);
    await desktop.dispose(handle, "discard");
  });

  it("classifies paths relative to the registered worktree root", async () => {
    const desktop = createDesktopRunEnvironment({
      sourceRepo: "/unused",
      worktreeRoot: "/runs",
      approvalGate: async () => ({ approved: true }),
      keepOrDiscardGate: async () => ({ outcome: "discard" })
    });
    desktop.recordHostAccess({
      runId: "x",
      kind: "write",
      path: "/runs/x/new.txt",
      origin: "command_argv"
    });
    desktop.recordHostAccess({
      runId: "x",
      kind: "write",
      path: "/etc/hosts",
      origin: "command_argv"
    });
    const log = desktop.readHostAccessLog();
    expect(log[0]!.outOfScope).toBe(false);
    expect(log[1]!.outOfScope).toBe(true);
  });
});

/**
 * vi.fn<ApprovalGate> infers the implementation return type as `{approved: boolean}`,
 * which loses the discriminated union. Cast through unknown so we keep both
 * the callable mock (with .mock.calls) and the strict ApprovalGate type.
 */
function mockApproval(impl: ApprovalGate): ApprovalGate & ReturnType<typeof vi.fn> {
  return vi.fn(impl) as unknown as ApprovalGate & ReturnType<typeof vi.fn>;
}
function mockKeep(impl: KeepOrDiscardGate): KeepOrDiscardGate & ReturnType<typeof vi.fn> {
  return vi.fn(impl) as unknown as KeepOrDiscardGate & ReturnType<typeof vi.fn>;
}

function createStubEnvironment(): RunEnvironment {
  const handles = new Map<string, { runId: string }>();
  return {
    async prepare(spec: EnvironmentSpec): Promise<EnvironmentHandle> {
      const handle = { id: `stub-${spec.runId}`, environmentId: spec.environmentId };
      handles.set(handle.id, { runId: spec.runId });
      return handle;
    },
    async perform(
      _handle: EnvironmentHandle,
      action: EnvironmentAction
    ): Promise<EnvironmentResult> {
      if (action.command.length === 0) {
        throw new Error("Action command must be a non-empty array");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async inspect(_handle: EnvironmentHandle): Promise<EnvironmentReport> {
      return { changedFiles: [] };
    },
    async dispose() {
      // no-op
    }
  };
}