import { mkdtemp, mkdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linkWorkspacePackages } from "../../../scripts/link-workspace-packages.mjs";

describe("linkWorkspacePackages", () => {
  it("hoists every workspace package as a relative root dependency link", async () => {
    const root = await mkdtemp(join(tmpdir(), "lecoding-workspace-links-"));
    const packageDirectory = join(root, "packages", "contracts");
    await Promise.all([
      mkdir(packageDirectory, { recursive: true }),
      // Reserved app directories without manifests are not workspace packages.
      mkdir(join(root, "apps", "future-web"), { recursive: true })
    ]);
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({ name: "@lecoding/contracts" }),
      "utf8"
    );

    try {
      await linkWorkspacePackages(root);

      expect(
        await readlink(join(root, "node_modules", "@lecoding", "contracts"))
      ).toBe("../../packages/contracts");
    } finally {
      // The fixture is unique to this test and contains no user-owned files.
      await rm(root, { recursive: true, force: true });
    }
  });
});
