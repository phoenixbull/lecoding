import { describe, expect, it } from "vitest";
import {
  createFileAccessGrant,
  FileAccessGrantError,
  grantRoots,
  isFenced,
  minimalDirectorySet,
  parseFileAccessGrant
} from "../src/file-access-grant.js";

const now = () => "2026-09-03T00:00:00.000Z";

describe("createFileAccessGrant", () => {
  it("issues a workspace_only grant with the worktree as the only root", () => {
    const grant = createFileAccessGrant({
      runId: "run-1",
      scope: "workspace_only",
      worktreePath: "/work/run-1",
      now
    });

    expect(grant).toEqual({
      runId: "run-1",
      scope: "workspace_only",
      allowedDirectories: [],
      worktreePath: "/work/run-1",
      issuedAt: now()
    });
    expect(grantRoots(grant)).toEqual(["/work/run-1"]);
  });

  it("discards selections made under workspace_only", () => {
    // Silently keeping them would widen the grant the user never approved.
    const grant = createFileAccessGrant({
      runId: "run-1",
      scope: "workspace_only",
      worktreePath: "/work/run-1",
      selectedDirectories: ["/etc"],
      now
    });
    expect(grant.allowedDirectories).toEqual([]);
  });

  it("issues a selected_directories grant with the minimal directory set", () => {
    const grant = createFileAccessGrant({
      runId: "run-1",
      scope: "selected_directories",
      worktreePath: "/work/run-1",
      selectedDirectories: ["/shared/a", "/shared"],
      now
    });
    expect(grant.allowedDirectories).toEqual(["/shared"]);
    expect(grantRoots(grant)).toEqual(["/work/run-1", "/shared"]);
  });

  it("drops a selection that is the worktree itself", () => {
    const grant = createFileAccessGrant({
      runId: "run-1",
      scope: "selected_directories",
      worktreePath: "/work/run-1",
      selectedDirectories: ["/work/run-1", "/shared"],
      now
    });
    expect(grant.allowedDirectories).toEqual(["/shared"]);
  });

  it("rejects selected_directories with nothing usable selected", () => {
    expect(() =>
      createFileAccessGrant({
        runId: "run-1",
        scope: "selected_directories",
        worktreePath: "/work/run-1",
        selectedDirectories: [],
        now
      })
    ).toThrow(FileAccessGrantError);
  });

  it("requires the danger acknowledgement for host_full", () => {
    expect(() =>
      createFileAccessGrant({
        runId: "run-1",
        scope: "host_full",
        worktreePath: "/work/run-1",
        now
      })
    ).toThrow(/danger acknowledgement/);
  });

  it("records the acknowledgement timestamp for host_full", () => {
    const grant = createFileAccessGrant({
      runId: "run-1",
      scope: "host_full",
      worktreePath: "/work/run-1",
      dangerAcknowledged: true,
      now
    });
    expect(grant.dangerAcknowledgedAt).toBe(now());
    expect(grantRoots(grant)).toEqual([]);
    expect(isFenced(grant)).toBe(false);
  });

  it("canonicalizes paths through the injected canonicalizer", () => {
    const grant = createFileAccessGrant({
      runId: "run-1",
      scope: "selected_directories",
      worktreePath: "/link/work",
      selectedDirectories: ["/link/shared"],
      canonicalize: (path) => path.replace("/link/", "/real/"),
      now
    });
    expect(grant.worktreePath).toBe("/real/work");
    expect(grant.allowedDirectories).toEqual(["/real/shared"]);
  });

  it("rejects a missing runId or worktreePath", () => {
    expect(() =>
      createFileAccessGrant({ runId: "", scope: "workspace_only", worktreePath: "/w", now })
    ).toThrow(FileAccessGrantError);
    expect(() =>
      createFileAccessGrant({ runId: "r", scope: "workspace_only", worktreePath: "", now })
    ).toThrow(FileAccessGrantError);
  });
});

describe("minimalDirectorySet", () => {
  it("removes directories nested inside another", () => {
    expect(minimalDirectorySet(["/a/b/c", "/a", "/a/b"])).toEqual(["/a"]);
  });

  it("removes duplicates", () => {
    expect(minimalDirectorySet(["/a", "/a", "/b"])).toEqual(["/a", "/b"]);
  });

  it("keeps siblings that do not contain each other", () => {
    expect(minimalDirectorySet(["/a", "/b"])).toEqual(["/a", "/b"]);
  });

  it("ignores a trailing separator when detecting nesting", () => {
    expect(minimalDirectorySet(["/a/b", "/a/"])).toEqual(["/a"]);
  });
});

describe("parseFileAccessGrant", () => {
  it("round-trips a valid grant", () => {
    const grant = createFileAccessGrant({
      runId: "run-1",
      scope: "selected_directories",
      worktreePath: "/work/run-1",
      selectedDirectories: ["/shared"],
      now
    });
    expect(parseFileAccessGrant(JSON.parse(JSON.stringify(grant)))).toEqual(grant);
  });

  const invalid: Array<{ name: string; value: unknown }> = [
    { name: "non-object", value: "grant" },
    { name: "array", value: [] },
    { name: "bad scope", value: { runId: "r", scope: "everywhere", worktreePath: "/w", issuedAt: "t" } },
    { name: "missing runId", value: { scope: "workspace_only", worktreePath: "/w", issuedAt: "t" } },
    { name: "missing worktree", value: { runId: "r", scope: "workspace_only", issuedAt: "t" } },
    { name: "missing issuedAt", value: { runId: "r", scope: "workspace_only", worktreePath: "/w" } }
  ];

  it.each(invalid)("rejects $name", ({ value }) => {
    expect(() => parseFileAccessGrant(value)).toThrow(FileAccessGrantError);
  });

  it("rejects a host_full grant with no acknowledgement", () => {
    // A persisted grant is untrusted input: without this check, editing the
    // file on disk would upgrade a Run to unrestricted host access.
    expect(() =>
      parseFileAccessGrant({
        runId: "r",
        scope: "host_full",
        worktreePath: "/w",
        issuedAt: "t"
      })
    ).toThrow(/danger acknowledgement/);
  });

  it("rejects a selected_directories grant with no directories", () => {
    expect(() =>
      parseFileAccessGrant({
        runId: "r",
        scope: "selected_directories",
        worktreePath: "/w",
        issuedAt: "t",
        allowedDirectories: []
      })
    ).toThrow(FileAccessGrantError);
  });

  it("rejects a workspace_only grant carrying extra directories", () => {
    expect(() =>
      parseFileAccessGrant({
        runId: "r",
        scope: "workspace_only",
        worktreePath: "/w",
        issuedAt: "t",
        allowedDirectories: ["/etc"]
      })
    ).toThrow(FileAccessGrantError);
  });

  it("rejects a non-string directory list", () => {
    expect(() =>
      parseFileAccessGrant({
        runId: "r",
        scope: "selected_directories",
        worktreePath: "/w",
        issuedAt: "t",
        allowedDirectories: [1, 2]
      })
    ).toThrow(FileAccessGrantError);
  });
});

describe("isFenced", () => {
  it("is false only for host_full", () => {
    const base = { runId: "r", worktreePath: "/w", allowedDirectories: [], issuedAt: now() };
    expect(isFenced({ ...base, scope: "workspace_only" })).toBe(true);
    expect(isFenced({ ...base, scope: "selected_directories" })).toBe(true);
    expect(isFenced({ ...base, scope: "host_full", dangerAcknowledgedAt: now() })).toBe(false);
  });
});
