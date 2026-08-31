import { describe, expect, it } from "vitest";
import { createProjectInstructionLoader } from "../src/index.js";

/** Minimal in-memory fs adapter so loader tests never touch the real filesystem. */
function createMemoryFs(
  files: Record<string, string>
): Parameters<typeof createProjectInstructionLoader>[0]["fs"] {
  return {
    async read(path) {
      if (!(path in files)) {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return files[path]!;
    }
  };
}

describe("createProjectInstructionLoader", () => {
  it("returns no sections when neither AGENTS.md nor CLAUDE.md exists", async () => {
    const loader = createProjectInstructionLoader({ fs: createMemoryFs({}) });
    const result = await loader.load({
      projectRoot: "/repo",
      cwd: "/repo"
    });
    expect(result.sections).toEqual([]);
  });

  it("prefers AGENTS.md over CLAUDE.md at the project root", async () => {
    const loader = createProjectInstructionLoader({
      fs: createMemoryFs({
        "/repo/AGENTS.md": "Project agents rules",
        "/repo/CLAUDE.md": "Project claude rules"
      })
    });
    const result = await loader.load({
      projectRoot: "/repo",
      cwd: "/repo"
    });
    expect(result.sections).toEqual([
      {
        path: "/repo/AGENTS.md",
        relativePath: "AGENTS.md",
        content: "Project agents rules"
      }
    ]);
  });

  it("falls back to CLAUDE.md when AGENTS.md is absent", async () => {
    const loader = createProjectInstructionLoader({
      fs: createMemoryFs({
        "/repo/CLAUDE.md": "Legacy claude rules"
      })
    });
    const result = await loader.load({
      projectRoot: "/repo",
      cwd: "/repo"
    });
    expect(result.sections).toEqual([
      {
        path: "/repo/CLAUDE.md",
        relativePath: "CLAUDE.md",
        content: "Legacy claude rules"
      }
    ]);
  });

  it("rejects a project instruction file that exceeds the size ceiling", async () => {
    const oversized = "a".repeat(70_000);
    const loader = createProjectInstructionLoader({
      fs: createMemoryFs({
        "/repo/AGENTS.md": oversized
      })
    });
    await expect(
      loader.load({ projectRoot: "/repo", cwd: "/repo" })
    ).rejects.toThrow(/exceeds the size limit/);
  });

  it("surfaces unexpected fs errors instead of silently masking failures", async () => {
    const loader = createProjectInstructionLoader({
      fs: {
        async read() {
          const error = new Error("EACCES") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
      }
    });
    await expect(
      loader.load({ projectRoot: "/repo", cwd: "/repo" })
    ).rejects.toThrow(/EACCES/);
  });

  it("rejects a projectRoot that does not contain the cwd", async () => {
    const loader = createProjectInstructionLoader({ fs: createMemoryFs({}) });
    await expect(
      loader.load({ projectRoot: "/other", cwd: "/repo" })
    ).rejects.toThrow(/projectRoot must contain cwd/);
  });

  it("walks ancestors root-first so child directories override the project defaults", async () => {
    const loader = createProjectInstructionLoader({
      fs: createMemoryFs({
        "/repo/AGENTS.md": "Project rules",
        "/repo/packages/AGENTS.md": "Packages rules",
        "/repo/packages/api/CLAUDE.md": "API rules"
      })
    });
    const result = await loader.load({
      projectRoot: "/repo",
      cwd: "/repo/packages/api"
    });
    expect(result.sections).toEqual([
      {
        path: "/repo/AGENTS.md",
        relativePath: "AGENTS.md",
        content: "Project rules"
      },
      {
        path: "/repo/packages/AGENTS.md",
        relativePath: "packages/AGENTS.md",
        content: "Packages rules"
      },
      {
        path: "/repo/packages/api/CLAUDE.md",
        relativePath: "packages/api/CLAUDE.md",
        content: "API rules"
      }
    ]);
  });

  it("stops at projectRoot even when matching files exist above it", async () => {
    const loader = createProjectInstructionLoader({
      fs: createMemoryFs({
        "/AGENTS.md": "Global default",
        "/repo/AGENTS.md": "Project rule"
      })
    });
    const result = await loader.load({
      projectRoot: "/repo",
      cwd: "/repo"
    });
    expect(result.sections.map((section) => section.content)).toEqual([
      "Project rule"
    ]);
  });

  it("skips intermediate directories that have neither AGENTS.md nor CLAUDE.md", async () => {
    const loader = createProjectInstructionLoader({
      fs: createMemoryFs({
        "/repo/AGENTS.md": "Project rule",
        "/repo/packages/api/CLAUDE.md": "API rule"
      })
    });
    const result = await loader.load({
      projectRoot: "/repo",
      cwd: "/repo/packages/api"
    });
    expect(result.sections.map((section) => section.relativePath)).toEqual([
      "AGENTS.md",
      "packages/api/CLAUDE.md"
    ]);
  });
});