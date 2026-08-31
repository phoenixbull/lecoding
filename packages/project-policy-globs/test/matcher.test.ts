import { describe, expect, it } from "vitest";
import {
  createProjectPolicyGlobMatcher,
  type ProjectPolicyGlob
} from "../src/index.js";

describe("createProjectPolicyGlobMatcher", () => {
  it("matches an exact basename", () => {
    const matcher = createProjectPolicyGlobMatcher({ globs: [".env"] });
    expect(matcher.matches("/repo/.env")).toBe(true);
    expect(matcher.matches("/repo/app/.env")).toBe(true);
    expect(matcher.matches("/repo/.envrc")).toBe(false);
  });

  it("matches a ** pattern across multiple path segments", () => {
    const matcher = createProjectPolicyGlobMatcher({
      globs: [".github/workflows/**"]
    });
    expect(matcher.matches("/repo/.github/workflows/ci.yml")).toBe(true);
    expect(matcher.matches("/repo/.github/workflows/prod/strict.yml")).toBe(
      true
    );
    expect(matcher.matches("/repo/.github/codeowners")).toBe(false);
  });

  it("matches a * glob within a single path segment", () => {
    const matcher = createProjectPolicyGlobMatcher({ globs: ["*.key"] });
    expect(matcher.matches("/repo/server.key")).toBe(true);
    expect(matcher.matches("/repo/sub/server.key")).toBe(true);
    expect(matcher.matches("/repo/keys.tar")).toBe(false);
  });

  it("returns false when no globs are configured", () => {
    const matcher = createProjectPolicyGlobMatcher({ globs: [] });
    expect(matcher.matches("/repo/.env")).toBe(false);
  });

  it("rejects an absolute path pattern", () => {
    expect(() =>
      createProjectPolicyGlobMatcher({ globs: ["/etc/passwd"] })
    ).toThrow(/must be project-relative/);
  });

  it("rejects a leading-slash glob (use a project-relative pattern instead)", () => {
    expect(() =>
      createProjectPolicyGlobMatcher({ globs: ["/.env"] })
    ).toThrow(/must be project-relative/);
  });

  it("rejects a Windows-style absolute path", () => {
    expect(() =>
      createProjectPolicyGlobMatcher({ globs: ["C:\\Windows\\System32"] })
    ).toThrow(/must be project-relative/);
  });

  it("rejects a pattern that escapes the project root", () => {
    expect(() =>
      createProjectPolicyGlobMatcher({ globs: ["../outside/**"] })
    ).toThrow(/must be project-relative/);
  });

  it("does not let a literal dot become a regex wildcard", () => {
    const matcher = createProjectPolicyGlobMatcher({ globs: [".env"] });
    expect(matcher.matches("/repo/xenv")).toBe(false);
    expect(matcher.matches("/repo/.envy")).toBe(false);
  });

  it("supports multiple patterns and returns true on the first hit", () => {
    const matcher = createProjectPolicyGlobMatcher({
      globs: [".env", ".github/workflows/**"]
    });
    expect(matcher.matches("/repo/.env")).toBe(true);
    expect(matcher.matches("/repo/.github/workflows/release.yml")).toBe(true);
    expect(matcher.matches("/repo/src/index.ts")).toBe(false);
  });

  it("treats a single-segment .env as matching the project root and any descendant", () => {
    const matcher = createProjectPolicyGlobMatcher({ globs: [".env"] });
    expect(matcher.matches("/repo/.env")).toBe(true);
    expect(matcher.matches("/repo/services/api/.env")).toBe(true);
  });
});

describe("ProjectPolicyGlob validation", () => {
  it("rejects an empty string", () => {
    expect(() =>
      createProjectPolicyGlobMatcher({ globs: [""] })
    ).toThrow(/non-empty string/);
  });

  it("rejects a non-string entry", () => {
    const globs = [42] as unknown as ProjectPolicyGlob[];
    expect(() => createProjectPolicyGlobMatcher({ globs })).toThrow();
  });

  it("rejects a pattern containing a backslash", () => {
    expect(() =>
      createProjectPolicyGlobMatcher({ globs: ["a\\b"] })
    ).toThrow(/backslash/);
  });

  it("rejects a pattern containing a null byte", () => {
    expect(() =>
      createProjectPolicyGlobMatcher({ globs: ["a\u0000b"] })
    ).toThrow(/null byte/);
  });

  it("rejects more than the configured number of globs", () => {
    expect(() =>
      createProjectPolicyGlobMatcher({ globs: [".env", "*.key"], maxGlobs: 1 })
    ).toThrow(/Too many/);
  });
});