/**
 * End-to-end test for the local execution chain.
 *
 * Wires the four pieces exactly as production does —
 * `RemoteRunnerEnvironment` (server) → `HostSession` → `RunnerSession` →
 * `createLocalRunnerHandlers` (desktop) — over a paired in-memory socket.
 *
 * It exists because the pieces were tested separately and each passed while
 * the whole chain was broken: the server sent payloads that did not carry what
 * the desktop handlers required, so every environment operation failed against
 * a real Runner. Only a test crossing all four boundaries can see that, which
 * is why it lives here with the handlers rather than beside either endpoint.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileAccessScope } from "@lecoding/contracts";
import {
  createFileAccessGrant,
  createHostSandbox,
  createPathFence,
  type EnforcementLevel,
  type HostSandbox
} from "@lecoding/host-sandbox";
import {
  createHostSession,
  createPairedRunnerSockets,
  createRunnerSession,
  type HostSession,
  type RunnerIdentity,
  type RunnerSession
} from "@lecoding/runner-protocol";
import {
  createRunJournal,
  createMemoryJournalFileSystem
} from "@lecoding/local-runner";
import {
  createLocalRunnerHost,
  type LocalRunnerHost
} from "../src/main/local-runner-host.js";
import { createLocalRunnerHandlers } from "../src/main/local-runner-handlers.js";
import { createRemoteRunnerEnvironment } from "@lecoding/run-environment";

const now = () => "2026-09-04T00:00:00.000Z";
const identity: RunnerIdentity = {
  deviceId: "device-1",
  userId: "user-1",
  projectId: "project-1"
};

const TIERS: Record<FileAccessScope, EnforcementLevel> = {
  workspace_only: "argv_fence",
  selected_directories: "argv_fence",
  host_full: "acknowledged_unrestricted"
};

interface Chain {
  environment: ReturnType<typeof createRemoteRunnerEnvironment>;
  host: HostSession;
  runner: RunnerSession;
  runnerHost: LocalRunnerHost;
  grantsIssued: string[];
  resolutions: Array<{ runId: string; outcome: "keep" | "discard" }>;
  root: string;
}

function gitAvailable(): boolean {
  return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
}

function makeRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  const run = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: path, stdio: "ignore" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} exited with status ${result.status}`);
    }
  };
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  const match = probe.stdout?.match(/git version (\d+)\.(\d+)/);
  const major = match ? Number(match[1]) : 0;
  const minor = match ? Number(match[2]) : 0;
  if (major > 2 || (major === 2 && minor >= 28)) {
    run(["init", "-q", "--initial-branch=main"]);
  } else {
    run(["init", "-q"]);
    run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  }
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  run(["add", "."]);
  run(["commit", "-q", "-m", "init", "--allow-empty"]);
}

/**
 * Builds the whole chain against a temp source repo.
 *
 * The sandbox is the real argv fence, so an out-of-scope command is refused
 * exactly as it would be on a desktop; only the transport is simulated.
 */
function createChain(): Chain {
  const root = join(
    tmpdir(),
    `runner-chain-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const sourceRepo = join(root, "project");
  const worktreeRoot = join(root, "worktrees");
  makeRepo(sourceRepo);
  mkdirSync(worktreeRoot, { recursive: true });

  const sandbox: HostSandbox = createHostSandbox({
    fence: createPathFence({ caseInsensitive: process.platform !== "linux" }),
    platform: process.platform,
    tiers: TIERS,
    detail: "test adapter"
  });

  const fs = createMemoryJournalFileSystem();
  const journal = createRunJournal({ filePath: "/state/run-journal.jsonl", now, fs });
  const resolutions: Array<{ runId: string; outcome: "keep" | "discard" }> = [];
  const runnerHost = createLocalRunnerHost({
    journal,
    resolveRunOutcome: async (runId, outcome) => {
      resolutions.push({ runId, outcome });
    },
    cancelRun: () => undefined,
    now
  });

  const grantsIssued: string[] = [];
  const handlers = createLocalRunnerHandlers({
    sandbox,
    host: runnerHost,
    // Grants are issued for the scope the Run actually asked for, as Main does
    // from the OS dialog — not always workspace_only, which would make the
    // scope mapping untestable for the other two tiers.
    resolveGrant: async (input) => {
      grantsIssued.push(`${input.runId}:${input.scope}`);
      // Canonicalized first, exactly as `createFileAccessGrant` does in
      // production: the worktree does not exist yet, so the path is derived
      // from the canonical worktree root. Naming the non-canonical spelling
      // would make every command look like an escape on hosts where /var is a
      // symlink.
      const canonicalRoot = await realpath(worktreeRoot);
      return createFileAccessGrant({
        runId: input.runId,
        scope: input.scope,
        worktreePath: join(canonicalRoot, input.runId),
        selectedDirectories: [],
        dangerAcknowledged: input.scope === "host_full",
        now
      });
    },
    sourceRepo,
    worktreeRoot,
    // The audit log writes through the real filesystem, so it needs a real
    // path inside the temp root rather than the journal's in-memory location.
    auditLogPath: join(root, "host-access.jsonl"),
    worktreePathFor: (runId) => join(worktreeRoot, runId),
    now
  });

  const pair = createPairedRunnerSockets();
  const host = createHostSession({
    socket: pair.a,
    sessionId: "session-1",
    authenticate: async () => ({ ok: true, identity }),
    onEvent: () => undefined
  });
  const runner = createRunnerSession({
    deviceAccessToken: "device-token",
    capabilities: {
      maxFileAccessScope: "host_full",
      kernelEnforced: false,
      platform: process.platform === "win32" ? "win32" : "darwin"
    },
    handlers,
    lastReceivedCommandId: 0
  });
  runner.connect(pair.b);

  const environment = createRemoteRunnerEnvironment({
    gateway: { sessionFor: () => host },
    deviceId: identity.deviceId,
    projectId: identity.projectId
  });

  return { environment, host, runner, runnerHost, grantsIssued, resolutions, root };
}

describe.skipIf(!gitAvailable())("local execution chain, end to end", () => {
  const roots: string[] = [];
  let chain: Chain;

  beforeEach(() => {
    chain = createChain();
    roots.push(chain.root);
  });

  afterEach(() => {
    // 4004 is the protocol's "shutting down" code; the test transport accepts
    // it without requiring a real close handshake.
    chain.runner.close(4004, "test done");
    for (const root of roots.splice(0)) {
      if (existsSync(root)) {
        rmSync(root, { recursive: true, force: true });
      }
    }
    vi.restoreAllMocks();
  });

  it("carries a prepare through all four boundaries and returns a handle", async () => {
    const handle = await chain.environment.prepare({
      runId: "run-1",
      projectId: "project-1",
      environmentId: "local:device-1",
      fileAccessScope: "workspace_only"
    });

    expect(handle.id.length).toBeGreaterThan(0);
    expect(handle.environmentId).toBe("local:device-1");
    // The grant was issued for the scope the Run actually asked for.
    expect(chain.grantsIssued).toEqual(["run-1:workspace_only"]);
  });

  it("performs a command through the prepared handle", async () => {
    const handle = await chain.environment.prepare({
      runId: "run-1",
      projectId: "project-1",
      environmentId: "local:device-1",
      fileAccessScope: "workspace_only"
    });

    const result = await chain.environment.perform(handle, {
      type: "execute",
      command: ["node", "-e", "process.stdout.write('e2e')"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("e2e");
  });

  it("refuses a command that escapes the worktree", async () => {
    const handle = await chain.environment.prepare({
      runId: "run-1",
      projectId: "project-1",
      environmentId: "local:device-1",
      fileAccessScope: "workspace_only"
    });

    await expect(
      chain.environment.perform(handle, {
        type: "execute",
        command: ["cat", "/etc/hosts"]
      })
    ).rejects.toThrow(/refused|outside|escapes|grant/i);
  });

  it("inspects and disposes through the same handle", async () => {
    const handle = await chain.environment.prepare({
      runId: "run-1",
      projectId: "project-1",
      environmentId: "local:device-1",
      fileAccessScope: "workspace_only"
    });

    const report = await chain.environment.inspect(handle);
    expect(Array.isArray(report.changedFiles)).toBe(true);

    await expect(
      chain.environment.dispose(handle, "discard")
    ).resolves.toBeUndefined();
    expect(chain.resolutions).toEqual([{ runId: "run-1", outcome: "discard" }]);
  });

  it("keeps a later dispose from flipping an earlier keep", async () => {
    const handle = await chain.environment.prepare({
      runId: "run-1",
      projectId: "project-1",
      environmentId: "local:device-1",
      fileAccessScope: "workspace_only"
    });
    await chain.environment.dispose(handle, "keep");

    // The handle is gone after disposal, so a replayed dispose cannot re-run
    // the Git resolution the other way and destroy the kept changes.
    await expect(
      chain.environment.dispose(handle, "discard")
    ).rejects.toThrow(/never prepared/);
    expect(chain.resolutions).toEqual([{ runId: "run-1", outcome: "keep" }]);
  });

  it("refuses an operation for a handle that was never prepared here", async () => {
    await expect(
      chain.environment.perform(
        { id: "no-such-handle", environmentId: "local:device-1" },
        { type: "execute", command: ["node", "-e", "0"] }
      )
    ).rejects.toThrow(/never prepared/);
  });
});
