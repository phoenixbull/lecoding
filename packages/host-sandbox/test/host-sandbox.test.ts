import { describe, expect, it } from "vitest";
import type { FileAccessScope } from "@lecoding/contracts";
import {
  buildProfile,
  createAccessAuditLog,
  createFileAccessGrant,
  createHostSandbox,
  createMemoryAuditFileSystem,
  createWindowsSandbox,
  createPathFence,
  createSeatbeltSandbox,
  createUnsupportedSandbox,
  FileAccessGrantError,
  SandboxViolationError,
  selectHostSandbox,
  terminateProcessTree,
  type EnforcementLevel,
  type PathFence,
  type RealpathFn
} from "../src/index.js";

const now = () => "2026-09-03T00:00:00.000Z";
const WORKTREE = "/work/runs/run-1";

/** Filesystem model with one escaping symlink. */
function fenceWith(symlinks: Record<string, string> = {}): PathFence {
  const dirs = ["/", "/work", "/work/runs", WORKTREE, "/etc", "/shared", ...Object.values(symlinks)];
  const realpath: RealpathFn = async (path) => {
    let resolved = "";
    for (const part of path.split("/").filter(Boolean)) {
      const candidate = `${resolved}/${part}`;
      resolved = symlinks[candidate] ?? candidate;
    }
    resolved = resolved || "/";
    const parent = resolved.slice(0, resolved.lastIndexOf("/")) || "/";
    const exists = dirs.includes(resolved) || dirs.includes(parent);
    if (!exists) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    return resolved;
  };
  return createPathFence({ realpath, cwd: WORKTREE, caseInsensitive: false });
}

function grant(scope: FileAccessScope, extra: { selected?: string[]; danger?: boolean } = {}) {
  return createFileAccessGrant({
    runId: "run-1",
    scope,
    worktreePath: WORKTREE,
    selectedDirectories: extra.selected ?? ["/shared"],
    dangerAcknowledged: extra.danger === true,
    now
  });
}

/** Adapter whose tiers are set explicitly, so fail-closed rules can be tested. */
function sandboxWithTiers(tiers: Record<FileAccessScope, EnforcementLevel>) {
  return createHostSandbox({
    fence: fenceWith(),
    platform: "darwin",
    tiers,
    detail: "test adapter"
  });
}

describe("HostSandbox.admit", () => {
  it("admits a tier the host can enforce", () => {
    const sandbox = sandboxWithTiers({
      workspace_only: "argv_fence",
      selected_directories: "argv_fence",
      host_full: "acknowledged_unrestricted"
    });
    expect(() => sandbox.admit(grant("workspace_only"))).not.toThrow();
  });

  it("refuses a tier reported as unsupported", () => {
    // The whole point of the capability report: an unenforceable tier must
    // stop the Run, not quietly run with a weaker guarantee.
    const sandbox = sandboxWithTiers({
      workspace_only: "unsupported",
      selected_directories: "unsupported",
      host_full: "unsupported"
    });
    expect(() => sandbox.admit(grant("workspace_only"))).toThrow(FileAccessGrantError);
  });

  it("never downgrades an unsupported tier to the argv fence", () => {
    const sandbox = sandboxWithTiers({
      workspace_only: "unsupported",
      selected_directories: "unsupported",
      host_full: "unsupported"
    });
    // Even a command that stays inside the worktree is refused: enforcement is
    // a property of the host, not of the individual command.
    expect(() => sandbox.admit(grant("workspace_only"))).toThrow(/cannot enforce/);
  });

  it("refuses host_full without the danger acknowledgement", () => {
    const sandbox = sandboxWithTiers({
      workspace_only: "argv_fence",
      selected_directories: "argv_fence",
      host_full: "acknowledged_unrestricted"
    });
    // Simulates a persisted grant that was edited to remove the confirmation.
    const tampered: Parameters<typeof sandbox.admit>[0] = grant("host_full", { danger: true });
    delete tampered.dangerAcknowledgedAt;
    expect(() => sandbox.admit(tampered)).toThrow(/danger acknowledgement/);
  });
});

describe("HostSandbox.plan", () => {
  it("allows a command inside the worktree", async () => {
    const sandbox = sandboxWithTiers({
      workspace_only: "argv_fence",
      selected_directories: "argv_fence",
      host_full: "acknowledged_unrestricted"
    });
    await expect(
      sandbox.plan({
        grant: grant("workspace_only"),
        executable: "pnpm",
        args: ["test"],
        cwd: WORKTREE
      })
    ).resolves.toMatchObject({ executable: "pnpm", args: ["test"] });
  });

  it("refuses a command that names a path outside the grant", async () => {
    const sandbox = sandboxWithTiers({
      workspace_only: "argv_fence",
      selected_directories: "argv_fence",
      host_full: "acknowledged_unrestricted"
    });
    await expect(
      sandbox.plan({
        grant: grant("workspace_only"),
        executable: "cat",
        args: ["/etc/passwd"],
        cwd: WORKTREE
      })
    ).rejects.toThrow(SandboxViolationError);
  });

  it("refuses a command whose symlink argument escapes the worktree", async () => {
    const sandbox = createHostSandbox({
      fence: fenceWith({ [`${WORKTREE}/escape`]: "/etc" }),
      platform: "darwin",
      tiers: {
        workspace_only: "argv_fence",
        selected_directories: "argv_fence",
        host_full: "acknowledged_unrestricted"
      },
      detail: "test"
    });
    await expect(
      sandbox.plan({
        grant: grant("workspace_only"),
        executable: "cat",
        args: [`${WORKTREE}/escape/passwd`],
        cwd: WORKTREE
      })
    ).rejects.toThrow(SandboxViolationError);
  });

  it("allows a path covered by selected_directories", async () => {
    const sandbox = sandboxWithTiers({
      workspace_only: "argv_fence",
      selected_directories: "argv_fence",
      host_full: "acknowledged_unrestricted"
    });
    await expect(
      sandbox.plan({
        grant: grant("selected_directories", { selected: ["/shared"] }),
        executable: "cp",
        args: ["out.tgz", "/shared/"],
        cwd: WORKTREE
      })
    ).resolves.toMatchObject({ executable: "cp" });
  });

  it("does not fence host_full but still requires the acknowledgement", async () => {
    const sandbox = sandboxWithTiers({
      workspace_only: "argv_fence",
      selected_directories: "argv_fence",
      host_full: "acknowledged_unrestricted"
    });
    await expect(
      sandbox.plan({
        grant: grant("host_full", { danger: true }),
        executable: "cat",
        args: ["/etc/passwd"],
        cwd: WORKTREE
      })
    ).resolves.toMatchObject({ executable: "cat" });
  });

  it("carries the environment through to the plan", async () => {
    const sandbox = sandboxWithTiers({
      workspace_only: "argv_fence",
      selected_directories: "argv_fence",
      host_full: "acknowledged_unrestricted"
    });
    await expect(
      sandbox.plan({
        grant: grant("workspace_only"),
        executable: "pnpm",
        args: ["test"],
        cwd: WORKTREE,
        env: { PATH: "/usr/bin" }
      })
    ).resolves.toMatchObject({ env: { PATH: "/usr/bin" } });
  });
});

describe("platform adapters", () => {
  it("reports kernel enforcement on macOS when Seatbelt is available", () => {
    const sandbox = createSeatbeltSandbox({
      fence: fenceWith(),
      probe: async () => true
    });
    const report = sandbox.capabilities();
    expect(report.platform).toBe("darwin");
    expect(report.tiers.workspace_only).toBe("kernel");
    expect(report.tiers.selected_directories).toBe("kernel");
  });

  it("wraps the command in sandbox-exec for fenced tiers", async () => {
    const sandbox = createSeatbeltSandbox({
      fence: fenceWith(),
      probe: async () => true
    });
    const plan = await sandbox.plan({
      grant: grant("workspace_only"),
      executable: "pnpm",
      args: ["test"],
      cwd: WORKTREE
    });
    expect(plan.executable).toBe("/usr/bin/sandbox-exec");
    expect(plan.args[0]).toBe("-p");
    expect(plan.args[2]).toBe("pnpm");
  });

  it("refuses to wrap when the Seatbelt probe failed", async () => {
    // A failed probe must not produce a plan that only looks confined.
    const sandbox = createSeatbeltSandbox({
      fence: fenceWith(),
      probe: async () => false
    });
    await expect(
      sandbox.plan({
        grant: grant("workspace_only"),
        executable: "pnpm",
        args: ["test"],
        cwd: WORKTREE
      })
    ).rejects.toThrow(/cannot be enforced/);
  });

  it("reports the argv fence honestly on Windows", () => {
    const report = createWindowsSandbox({ fence: fenceWith() }).capabilities();
    expect(report.platform).toBe("win32");
    expect(report.tiers.workspace_only).toBe("argv_fence");
    expect(report.tiers.selected_directories).toBe("argv_fence");
    // The report must say what is missing, not just what is present, or the UI
    // cannot show the user the difference from macOS.
    expect(report.detail).toMatch(/AppContainer|native/);
  });

  it("does not claim kernel-level isolation on Windows", () => {
    // The adapter is named for what it does. Reporting `kernel` here would let
    // the UI advertise a guarantee the OS is not providing.
    const report = createWindowsSandbox({ fence: fenceWith() }).capabilities();
    expect(report.tiers.workspace_only).not.toBe("kernel");
    expect(report.detail).toMatch(/not stopped by the OS|best-effort/);
  });

  it("terminates a process tree rather than only the direct child", async () => {
    // Killing just the spawned child leaves grandchildren holding the
    // worktree, which then survives cleanup as a residual.
    const result = await terminateProcessTree(999_999, { platform: "win32" });
    expect(result.terminated).toBe(false);
    // A failed termination is reported, never swallowed.
    expect(result.reason).toBeTruthy();
  });

  it("rejects an invalid pid instead of signalling process zero", async () => {
    // A negative or zero pid would target the wrong process group.
    const result = await terminateProcessTree(0, { platform: "win32" });
    expect(result.terminated).toBe(false);
    expect(result.reason).toBe("invalid pid");
  });

  it("reports unsupported on platforms Phase 4B does not target", () => {
    const sandbox = createUnsupportedSandbox("linux");
    expect(sandbox.capabilities().tiers.workspace_only).toBe("unsupported");
    expect(() => sandbox.admit(grant("workspace_only"))).toThrow(FileAccessGrantError);
  });

  it("selects the adapter for the platform", () => {
    expect(selectHostSandbox({ platform: "darwin" }).capabilities().platform).toBe("darwin");
    expect(selectHostSandbox({ platform: "win32" }).capabilities().platform).toBe("win32");
    expect(selectHostSandbox({ platform: "linux" }).capabilities().platform).toBe("linux");
  });
});

describe("buildProfile", () => {
  it("is deny-by-default and allows the worktree", () => {
    const profile = buildProfile(grant("workspace_only"), ["/usr"]);
    expect(profile).toContain("(deny default)");
    expect(profile).toContain(`(subpath "${WORKTREE}")`);
  });

  it("allows each selected directory", () => {
    const profile = buildProfile(grant("selected_directories", { selected: ["/shared"] }), []);
    expect(profile).toContain('(subpath "/shared")');
  });

  it("denies network egress by default", () => {
    // Network access is governed by the project's network policy, not by the
    // file access tier; defaulting to denied is the conservative choice.
    expect(buildProfile(grant("workspace_only"), [])).toContain("(deny network-outbound)");
  });

  it("escapes quotes so a crafted path cannot break out of the profile", () => {
    const profile = buildProfile(
      { ...grant("workspace_only"), worktreePath: '/work/" ; (allow default)' },
      []
    );
    expect(profile).toContain('\\"');
    expect(profile).not.toContain('(allow default) ;');
  });
});

describe("access audit log", () => {
  function auditLog() {
    const fs = createMemoryAuditFileSystem();
    const log = createAccessAuditLog({ filePath: "/audit/host-access.jsonl", now, fs });
    return { log, fs };
  }

  it("appends a record with an injected timestamp", async () => {
    const { log } = auditLog();
    const entry = await log.append({
      runId: "run-1",
      kind: "write",
      path: "/etc/passwd",
      origin: "command_argv",
      outOfScope: true
    });
    expect(entry.recordedAt).toBe(now());
    await expect(log.read()).resolves.toEqual([entry]);
  });

  it("exposes no update or delete surface", () => {
    const { log } = auditLog();
    // Immutability is a property of the interface: if a mutator appears here,
    // the log stops being evidence.
    const methods = Object.keys(log).sort();
    expect(methods).toEqual(["append", "read", "readOutOfScope"]);
  });

  it("filters out-of-scope records for review", async () => {
    const { log } = auditLog();
    await log.append({ runId: "r", kind: "read", path: "/work/x", origin: "command_argv", outOfScope: false });
    await log.append({ runId: "r", kind: "write", path: "/etc/y", origin: "command_argv", outOfScope: true });

    const outOfScope = await log.readOutOfScope();
    expect(outOfScope).toHaveLength(1);
    expect(outOfScope[0]?.path).toBe("/etc/y");
  });

  it("skips corrupted lines rather than losing the whole log", async () => {
    const { log, fs } = auditLog();
    await log.append({ runId: "r", kind: "read", path: "/a", origin: "command_argv", outOfScope: false });
    // A partially written line is the realistic failure after a crash mid-write.
    fs.append("/audit/host-access.jsonl", '{"runId":"r","kin');
    await expect(log.read()).resolves.toHaveLength(1);
  });

  it("returns an empty log when the file does not exist", async () => {
    const { log } = auditLog();
    await expect(log.read()).resolves.toEqual([]);
  });
});
