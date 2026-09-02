import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Release-workflow contract tests keep the checked-in CI boundary aligned
 * with the same fail-closed guarantees enforced by the desktop build code.
 */
describe("desktop release workflow", () => {
  const workflow = readFileSync(
    resolve(process.cwd(), ".github/workflows/desktop-release.yml"),
    "utf8"
  );

  it("runs the full repository verification gates before packaging", () => {
    expect(workflow).toMatch(/run:\s*pnpm typecheck/u);
    expect(workflow).toMatch(/run:\s*pnpm test/u);
    expect(workflow).not.toContain("pnpm --filter @lecoding/desktop... typecheck");
    expect(workflow).not.toContain("pnpm --filter @lecoding/desktop test");
  });

  it("passes the requested architecture to the build and fails on missing release assets", () => {
    expect(workflow).toContain(
      "node scripts/ci-desktop-make.mjs ${{ matrix.platform }} ${{ matrix.arch }}"
    );
    expect(workflow).toContain("fail_on_unmatched_files: true");
  });
});
