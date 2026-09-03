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

  it("builds each macOS architecture on a runner with a matching CPU", () => {
    // `macos-latest` is arm64-only, which is exactly why the historical x64
    // job shipped an arm64 binary under an x64 file name.
    expect(workflow).toContain("macos-15-intel");
    expect(workflow).toContain("macos-15\n");
    // The generic alias must not reappear in the macOS legs.
    const macosLegs = workflow
      .split("- name: macOS")
      .slice(1)
      .join("\n");
    expect(macosLegs).not.toContain("os: macos-latest");
  });

  it("rejects duplicate artifact names before publishing", () => {
    // GitHub release assets are addressed by file name; a collision silently
    // drops an architecture from the release.
    expect(workflow).toContain("uniq -d");
    expect(workflow).toContain("duplicate artifact names");
  });

  it("gates a stable release on real signature evidence", () => {
    // The evidence file must be named per platform/arch: all three jobs upload
    // into a single release and a shared name would trip the duplicate gate.
    expect(workflow).toContain("signing-evidence-*.txt");
    expect(workflow).toContain("LECODING_REQUIRE_SIGNED_ARTIFACTS");
    // An unsigned build may only ever reach a pre-release channel.
    expect(workflow).toContain("prerelease:");
    expect(workflow).toContain("needs.release-gate.outputs.signed");
  });

  it("validates the Windows setup installer the user actually runs", () => {
    // The Squirrel .exe is a 7z self-extracting archive, so it needs its own
    // extraction path rather than the zip-based one used for .nupkg.
    const script = readFileSync(
      resolve(process.cwd(), "scripts/ci-desktop-make.mjs"),
      "utf8"
    );
    expect(script).toContain('".exe", ".nupkg"');
    expect(script).toContain("7z.exe");
    expect(script).toContain("signing-evidence-${platform}-${arch}.txt");
  });
});
