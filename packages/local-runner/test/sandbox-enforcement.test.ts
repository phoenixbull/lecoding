import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileAccessScope } from "@lecoding/contracts";
import {
  createFileAccessGrant,
  createHostSandbox,
  createPathFence,
  SandboxViolationError,
  type EnforcementLevel,
  type HostSandbox,
  type PathViolation
} from "@lecoding/host-sandbox";
import { createLocalRunEnvironment, type ChildProcessLike } from "../src/index.js";

const now = () => "2026-09-03T00:00:00.000Z";
const LIMITS = { execTimeoutMs: 5_000, outputBytes: 16_384 };

function gitAvailable(): boolean {
  return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
}

/**
 * Initialises a throw-away repo, following the Git 2.22-compatible recipe from
 * `environment.test.ts`: `--initial-branch` needs Git 2.28+, so on older hosts
 * the default branch is renamed instead.
 */
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
  writeFileSync(join(path, "README.md"), "hello\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
}

function tempRoot(label: string): string {
  const root = join(
    tmpdir(),
    `local-runner-fence-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(root, { recursive: true });
  return root;
}

/** Real sandbox over a temp tree, so symlinks are resolved by the OS itself. */
function sandboxFor(
  tiers: Record<FileAccessScope, EnforcementLevel> = {
    workspace_only: "argv_fence",
    selected_directories: "argv_fence",
    host_full: "acknowledged_unrestricted"
  }
): HostSandbox {
  return createHostSandbox({
    fence: createPathFence({ caseInsensitive: process.platform !== "linux" }),
    platform: process.platform,
    tiers,
    detail: "test"
  });
}

/**
 * Spawn stub that records what would have run and exits cleanly.
 *
 * It must still present pipe-like stdio: `runCommand` refuses to continue
 * without them, and a null stream means "the child was never wired up", which
 * is a different failure from the one under test.
 */
function spawnRecorder() {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const spawn = (
    command: string,
    args: string[],
    options: { cwd: string }
  ): ChildProcessLike => {
    calls.push({ command, args, cwd: options.cwd });
    const noopStream = { on: () => noopStream };
    const child = {
      stdout: noopStream,
      stderr: noopStream,
      on(event: string, listener: (...args: never[]) => void) {
        if (event === "exit") {
          setImmediate(() => (listener as (code: number, signal: null) => void)(0, null));
        }
        return child;
      },
      kill: () => true
    };
    return child as unknown as ChildProcessLike;
  };
  return { calls, spawn };
}

describe.skipIf(!gitAvailable())("local runner sandbox enforcement", () => {
  let sandboxRoot: string;
  let sourceRepo: string;
  let worktreeRoot: string;
  /** Canonical worktree path; `/var` is a symlink to `/private/var` on macOS. */
  let worktree: string;

  beforeEach(async () => {
    sandboxRoot = tempRoot("sandbox");
    worktreeRoot = tempRoot("worktrees");
    sourceRepo = join(sandboxRoot, "project");
    makeRepo(sourceRepo);
    worktree = join(await realpath(worktreeRoot), "run-1");
  });

  afterEach(() => {
    for (const root of [sandboxRoot, worktreeRoot]) {
      if (root && existsSync(root)) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  /**
   * Builds a grant naming the canonical worktree path.
   *
   * The grant is issued before the worktree exists, so the path is derived from
   * the canonical worktree *root* plus the run id — the same construction
   * `createGitWorkspace` uses. Naming a non-canonical path would make every
   * command look like an escape on hosts where `/var` is a symlink.
   */
  function grantForRun(scope: FileAccessScope = "workspace_only") {
    return createFileAccessGrant({
      runId: "run-1",
      scope,
      worktreePath: worktree,
      selectedDirectories: ["/shared"],
      dangerAcknowledged: scope === "host_full",
      now
    });
  }

  function environmentWith(input: {
    sandbox?: HostSandbox;
    grant?: ReturnType<typeof grantForRun>;
    spawn: ReturnType<typeof spawnRecorder>["spawn"];
    onViolation?: (event: { violations: PathViolation[] }) => void;
  }) {
    return createLocalRunEnvironment({
      sourceRepo,
      worktreeRoot,
      ...(input.sandbox ? { sandbox: input.sandbox } : {}),
      ...(input.grant ? { grant: input.grant } : {}),
      ...(input.onViolation ? { onAccessViolation: input.onViolation } : {}),
      spawn: input.spawn,
      limits: LIMITS
    });
  }

  const spec = {
    runId: "run-1",
    projectId: "p",
    environmentId: "local:d1",
    fileAccessScope: "workspace_only" as FileAccessScope
  };

  it("runs an in-worktree command unchanged", async () => {
    const recorder = spawnRecorder();
    const environment = environmentWith({
      sandbox: sandboxFor(),
      grant: grantForRun(),
      spawn: recorder.spawn
    });

    const handle = await environment.prepare(spec);
    await environment.perform(handle, { type: "execute", command: ["pnpm", "test"] });

    expect(recorder.calls[0]?.command).toBe("pnpm");
    // Compared through realpath: the workspace returns the worktree root as
    // constructed, which on macOS is the `/var` spelling rather than the
    // canonical `/private/var` one. The fence resolves both to the same place.
    expect(await realpath(recorder.calls[0]?.cwd ?? "")).toBe(worktree);
  });

  it("refuses a command that names a path outside the worktree", async () => {
    const outside = tempRoot("outside");
    try {
      writeFileSync(join(outside, "secret.txt"), "secret");
      const recorder = spawnRecorder();
      const environment = environmentWith({
        sandbox: sandboxFor(),
        grant: grantForRun(),
        spawn: recorder.spawn
      });
      const handle = await environment.prepare(spec);

      await expect(
        environment.perform(handle, {
          type: "execute",
          command: ["cat", join(outside, "secret.txt")]
        })
      ).rejects.toThrow(SandboxViolationError);
      // The decisive assertion: no process was ever created.
      expect(recorder.calls).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a command that escapes through a symlink inside the worktree", async () => {
    // The real-world escape: a symlink planted in the worktree pointing at a
    // host directory the Run was never granted.
    const outside = tempRoot("outside");
    try {
      const recorder = spawnRecorder();
      const environment = environmentWith({
        sandbox: sandboxFor(),
        grant: grantForRun(),
        spawn: recorder.spawn
      });
      const handle = await environment.prepare(spec);
      symlinkSync(outside, join(worktree, "escape"));

      await expect(
        environment.perform(handle, {
          type: "execute",
          command: ["cat", join(worktree, "escape", "secret.txt")]
        })
      ).rejects.toThrow(SandboxViolationError);
      expect(recorder.calls).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports the refusal through onAccessViolation for the audit log", async () => {
    const violations: PathViolation[][] = [];
    const recorder = spawnRecorder();
    const environment = environmentWith({
      sandbox: sandboxFor(),
      grant: grantForRun(),
      spawn: recorder.spawn,
      onViolation: (event) => violations.push(event.violations)
    });
    const handle = await environment.prepare(spec);

    await expect(
      environment.perform(handle, { type: "execute", command: ["cat", "/etc/hosts"] })
    ).rejects.toThrow(SandboxViolationError);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.[0]?.token).toBe("/etc/hosts");
  });

  it("refuses at prepare when the host cannot enforce the tier", async () => {
    // Failing before the worktree exists is the point: no command can run in a
    // tier the host cannot actually enforce.
    const unsupported = sandboxFor({
      workspace_only: "unsupported",
      selected_directories: "unsupported",
      host_full: "unsupported"
    });
    const environment = environmentWith({
      sandbox: unsupported,
      grant: grantForRun(),
      spawn: spawnRecorder().spawn
    });

    await expect(environment.prepare(spec)).rejects.toThrow(/cannot enforce/);
  });

  it("refuses to run when a sandbox is present but no grant was issued", async () => {
    // A sandbox with no grant cannot decide, so it refuses rather than running
    // the command unconfined.
    const recorder = spawnRecorder();
    const environment = environmentWith({
      sandbox: sandboxFor(),
      spawn: recorder.spawn
    });
    const handle = await environment.prepare(spec);

    await expect(
      environment.perform(handle, { type: "execute", command: ["pnpm", "test"] })
    ).rejects.toThrow(/FileAccessGrant/);
    expect(recorder.calls).toEqual([]);
  });

  it("lets the sandbox rewrite the command when it confines below the process", async () => {
    // Mirrors the macOS Seatbelt adapter, which wraps the executable.
    const recorder = spawnRecorder();
    const wrapping = createHostSandbox({
      fence: createPathFence({ caseInsensitive: process.platform !== "linux" }),
      platform: process.platform,
      tiers: {
        workspace_only: "kernel",
        selected_directories: "kernel",
        host_full: "acknowledged_unrestricted"
      },
      detail: "wrapping test adapter"
    });
    // Forcing a rewrite proves the plan flows through to the actual spawn.
    vi.spyOn(wrapping, "plan").mockResolvedValue({
      executable: "confined",
      args: ["pnpm", "test"],
      cwd: worktree
    });

    const environment = environmentWith({
      sandbox: wrapping,
      grant: grantForRun(),
      spawn: recorder.spawn
    });
    const handle = await environment.prepare(spec);
    await environment.perform(handle, { type: "execute", command: ["pnpm", "test"] });

    expect(recorder.calls[0]?.command).toBe("confined");
  });

  it("keeps working without a sandbox, preserving existing behaviour", async () => {
    // Existing callers (tests, server worktrees) must be unaffected.
    const recorder = spawnRecorder();
    const environment = environmentWith({ spawn: recorder.spawn });
    const handle = await environment.prepare(spec);

    await expect(
      environment.perform(handle, { type: "execute", command: ["pnpm", "test"] })
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it("allows a path granted by selected_directories", async () => {
    const shared = tempRoot("shared");
    try {
      // Canonicalized first, exactly as `createFileAccessGrant` does in
      // production: a grant must record real locations, not a spelling.
      const grant = createFileAccessGrant({
        runId: "run-1",
        scope: "selected_directories",
        worktreePath: worktree,
        selectedDirectories: [await realpath(shared)],
        now
      });
      const recorder = spawnRecorder();
      const environment = environmentWith({
        sandbox: sandboxFor(),
        grant,
        spawn: recorder.spawn
      });
      const handle = await environment.prepare({
        ...spec,
        fileAccessScope: "selected_directories"
      });

      await expect(
        environment.perform(handle, {
          type: "execute",
          command: ["cp", "out.tgz", join(shared, "artifacts")]
        })
      ).resolves.toMatchObject({ exitCode: 0 });
      expect(recorder.calls).toHaveLength(1);
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  });
});
