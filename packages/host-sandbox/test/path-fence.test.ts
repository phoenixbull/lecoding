import { describe, expect, it } from "vitest";
import {
  createPathFence,
  isCaseInsensitiveByDefault,
  looksLikePath,
  type RealpathFn
} from "../src/path-fence.js";

interface FakeFs {
  /** Directories that exist. */
  dirs: string[];
  /** Symlink path to its target. */
  links: Record<string, string>;
}

/**
 * Models a filesystem with symlinks without touching disk.
 *
 * Symlinks are resolved component by component, the way real `realpath` does,
 * so a symlink in the middle of a path (`worktree/escape/passwd`) resolves
 * rather than only exact matches.
 */
function fakeRealpath(fs: FakeFs): RealpathFn {
  return async (path: string) => {
    let resolved = "";
    for (const part of path.split("/").filter(Boolean)) {
      const candidate = `${resolved}/${part}`;
      resolved = fs.links[candidate] ?? candidate;
    }
    resolved = resolved || "/";
    if (!exists(fs, resolved)) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    }
    return resolved;
  };
}

/** A path exists if it is a known directory or lives directly inside one. */
function exists(fs: FakeFs, path: string): boolean {
  const known = [...fs.dirs, ...Object.values(fs.links)];
  return known.some(
    (dir) => path === dir || path.startsWith(dir + "/") || dirOf(path) === dir
  );
}

function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

const WORKTREE = "/work/runs/run-1";
const BASE_FS: FakeFs = {
  dirs: ["/", "/work", "/work/runs", WORKTREE],
  links: {}
};

/** Adds symlinks and extra directories to the base filesystem. */
function fsWith(symlinks: Record<string, string> = {}, extraDirs: string[] = []): FakeFs {
  return {
    dirs: [...BASE_FS.dirs, ...extraDirs, ...Object.values(symlinks)],
    links: symlinks
  };
}

describe("looksLikePath", () => {
  it("accepts absolute and relative paths", () => {
    expect(looksLikePath("/etc/passwd")).toBe(true);
    expect(looksLikePath("src/index.ts")).toBe(true);
    expect(looksLikePath("~/secrets")).toBe(true);
  });

  it("rejects flags, URLs and bare words", () => {
    // A bare word is usually a subcommand or a ref, not a path, and treating
    // every argument as a path would make the fence unusable.
    expect(looksLikePath("--force")).toBe(false);
    expect(looksLikePath("-rf")).toBe(false);
    expect(looksLikePath("https://example.com/a")).toBe(false);
    expect(looksLikePath("test")).toBe(false);
    expect(looksLikePath("HEAD")).toBe(false);
    expect(looksLikePath("")).toBe(false);
  });

  it("accepts Windows drive roots on win32 only", () => {
    expect(looksLikePath("C:\\Users", "win32")).toBe(true);
    expect(looksLikePath("C:\\Users", "linux")).toBe(false);
  });
});

describe("createPathFence.canonicalize", () => {
  it("collapses dot and dot-dot segments", async () => {
    const fence = createPathFence({
      realpath: fakeRealpath(BASE_FS),
      cwd: WORKTREE,
      caseInsensitive: false
    });
    await expect(fence.canonicalize("src/../src/a.ts")).resolves.toBe(`${WORKTREE}/src/a.ts`);
  });

  it("resolves a symlink that escapes the worktree", async () => {
    // The attack this exists for: a symlink inside the worktree pointing at a
    // host directory the Run was never granted.
    const fence = createPathFence({
      realpath: fakeRealpath(fsWith({ [`${WORKTREE}/escape`]: "/etc" })),
      cwd: WORKTREE,
      caseInsensitive: false
    });
    await expect(fence.canonicalize(`${WORKTREE}/escape/passwd`)).resolves.toBe("/etc/passwd");
  });

  it("canonicalizes a path that does not exist yet", async () => {
    // Commands routinely name output files that do not exist; refusing to
    // canonicalize them would make the fence useless for writes.
    const fence = createPathFence({
      realpath: fakeRealpath(BASE_FS),
      cwd: WORKTREE,
      caseInsensitive: false
    });
    await expect(fence.canonicalize(`${WORKTREE}/out/new.txt`)).resolves.toBe(
      `${WORKTREE}/out/new.txt`
    );
  });

  it("resolves the ancestor when a symlink precedes a new file", async () => {
    const fence = createPathFence({
      realpath: fakeRealpath(fsWith({ [`${WORKTREE}/linked`]: "/elsewhere" })),
      cwd: WORKTREE,
      caseInsensitive: false
    });
    await expect(fence.canonicalize(`${WORKTREE}/linked/brand-new.txt`)).resolves.toBe(
      "/elsewhere/brand-new.txt"
    );
  });

  it("treats the extended-length form as the same path so aliases cannot slip past", async () => {
    // Compared against the plain form rather than a literal, because path
    // primitives on the test host are POSIX and cannot round-trip `C:\`.
    const fence = createPathFence({
      realpath: fakeRealpath({ dirs: ["C:\\work"], links: {} }),
      cwd: "C:\\work",
      caseInsensitive: true,
      platform: "win32"
    });
    const prefixed = await fence.canonicalize("\\\\?\\C:\\work\\a.txt");
    const plain = await fence.canonicalize("C:\\work\\a.txt");
    expect(prefixed).toBe(plain);
  });
});

describe("createPathFence.isWithin", () => {
  const fence = createPathFence({
    realpath: fakeRealpath(BASE_FS),
    cwd: "/work",
    caseInsensitive: false
  });

  it("treats the root itself as inside", () => {
    expect(fence.isWithin(WORKTREE, WORKTREE)).toBe(true);
  });

  it("treats descendants as inside", () => {
    expect(fence.isWithin(`${WORKTREE}/src/a.ts`, WORKTREE)).toBe(true);
  });

  it("rejects a sibling directory that merely shares a prefix", () => {
    // A naive startsWith check would pass `/work/runs/run-1-evil` against
    // `/work/runs/run-1`; path-segment comparison must not.
    expect(fence.isWithin("/work/runs/run-1-evil/x", WORKTREE)).toBe(false);
  });

  it("rejects parents and unrelated paths", () => {
    expect(fence.isWithin("/work/runs", WORKTREE)).toBe(false);
    expect(fence.isWithin("/etc/passwd", WORKTREE)).toBe(false);
  });

  it("compares case-insensitively when configured", () => {
    const insensitive = createPathFence({
      realpath: fakeRealpath(BASE_FS),
      cwd: "/work",
      caseInsensitive: true
    });
    expect(insensitive.isWithin("/WORK/RUNS/RUN-1/a", WORKTREE)).toBe(true);

    const sensitive = createPathFence({
      realpath: fakeRealpath(BASE_FS),
      cwd: "/work",
      caseInsensitive: false
    });
    expect(sensitive.isWithin("/WORK/RUNS/RUN-1/a", WORKTREE)).toBe(false);
  });

  it("defaults case sensitivity to the platform", () => {
    expect(isCaseInsensitiveByDefault("darwin")).toBe(true);
    expect(isCaseInsensitiveByDefault("win32")).toBe(true);
    expect(isCaseInsensitiveByDefault("linux")).toBe(false);
  });

  it("checks membership across several roots", () => {
    expect(fence.isWithinAny("/etc/passwd", [WORKTREE, "/etc"])).toBe(true);
    expect(fence.isWithinAny("/var/log", [WORKTREE, "/etc"])).toBe(false);
  });
});

describe("createPathFence.inspect", () => {
  function fenceFor(symlinks: Record<string, string> = {}, extraDirs: string[] = []) {
    return createPathFence({
      realpath: fakeRealpath(fsWith(symlinks, extraDirs)),
      cwd: WORKTREE,
      caseInsensitive: false
    });
  }

  it("allows a command that stays inside the worktree", async () => {
    const verdict = await fenceFor().inspect({
      allowedRoots: [WORKTREE],
      cwd: WORKTREE,
      args: ["pnpm", "test", "src/a.ts"]
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.violations).toEqual([]);
  });

  it("rejects an absolute path outside the worktree", async () => {
    const verdict = await fenceFor({}, ["/etc"]).inspect({
      allowedRoots: [WORKTREE],
      cwd: WORKTREE,
      args: ["cat", "/etc/passwd"]
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations[0]).toMatchObject({
      token: "/etc/passwd",
      canonicalPath: "/etc/passwd",
      reason: "out_of_scope"
    });
  });

  it("rejects a symlink argument that escapes the worktree", async () => {
    const verdict = await fenceFor({ [`${WORKTREE}/escape`]: "/etc" }).inspect({
      allowedRoots: [WORKTREE],
      cwd: WORKTREE,
      args: ["cat", `${WORKTREE}/escape/passwd`]
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations[0]?.canonicalPath).toBe("/etc/passwd");
  });

  it("rejects a working directory outside the grant", async () => {
    // A command that merely starts outside the grant can act there without ever
    // naming a path, so cwd is checked too.
    const verdict = await fenceFor({}, ["/etc"]).inspect({
      allowedRoots: [WORKTREE],
      cwd: "/etc",
      args: ["ls"]
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations[0]).toMatchObject({ token: "cwd", reason: "out_of_scope" });
  });

  it("rejects a traversal that escapes through dot-dot", async () => {
    const verdict = await fenceFor({}, ["/etc"]).inspect({
      allowedRoots: [WORKTREE],
      cwd: WORKTREE,
      args: ["cat", "../../../etc/passwd"]
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations[0]?.canonicalPath).toBe("/etc/passwd");
  });

  it("allows a directory granted by selected_directories", async () => {
    const verdict = await fenceFor({}, ["/shared"]).inspect({
      allowedRoots: [WORKTREE, "/shared"],
      cwd: WORKTREE,
      args: ["cp", "out.tgz", "/shared/artifacts/"]
    });
    expect(verdict.allowed).toBe(true);
  });

  it("records every examined path for the audit log", async () => {
    const verdict = await fenceFor({}, ["/etc"]).inspect({
      allowedRoots: [WORKTREE],
      cwd: WORKTREE,
      args: ["cat", "/etc/passwd", "src/a.ts"]
    });
    expect(verdict.examined.map((entry) => entry.token)).toEqual([
      "cwd",
      "/etc/passwd",
      "src/a.ts"
    ]);
  });

  it("ignores flags and URLs rather than treating them as paths", async () => {
    const verdict = await fenceFor().inspect({
      allowedRoots: [WORKTREE],
      cwd: WORKTREE,
      args: ["curl", "--output", "result.json", "https://example.com/x"]
    });
    expect(verdict.allowed).toBe(true);
    // A bare filename is resolved against the working directory, which is
    // itself fenced, so examining it would add noise without adding safety.
    expect(verdict.examined.map((entry) => entry.token)).toEqual(["cwd"]);
  });

  it("examines a relative path that carries a separator", async () => {
    const verdict = await fenceFor().inspect({
      allowedRoots: [WORKTREE],
      cwd: WORKTREE,
      args: ["cat", "./result.json"]
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.examined.map((entry) => entry.token)).toEqual(["cwd", "./result.json"]);
  });

  it("reports every violation, not just the first", async () => {
    const verdict = await fenceFor({}, ["/etc", "/var"]).inspect({
      allowedRoots: [WORKTREE],
      cwd: WORKTREE,
      args: ["cp", "/etc/passwd", "/var/log/x"]
    });
    expect(verdict.violations).toHaveLength(2);
  });
});
