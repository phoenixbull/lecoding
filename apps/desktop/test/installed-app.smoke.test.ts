import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { collectBinaries, validateArchitectures } from "../src/build/architecture.js";

/**
 * Shallow smoke test against a real installed desktop app.
 *
 * This is the complement to `run-loop.integration.test.ts`: that suite drives
 * the business loop with Electron faked, while this one inspects an artifact
 * produced by `electron-forge make` on a real machine. It deliberately does
 * NOT launch the GUI — headless Electron on macOS/Windows CI runners is not
 * dependable enough to gate a release on — so it verifies the packaged layout
 * and the architecture of every shipped binary.
 *
 * Environment gate:
 *   LECODING_INSTALLED_APP_PATH  : path to the packaged app (`.app` on macOS,
 *                                  the win-unpacked directory on Windows).
 *   LECODING_INSTALLED_APP_ARCH  : expected architecture, `x64` or `arm64`.
 *
 * Both are unset in normal development runs, in which case the suite reports
 * as skipped with an explicit reason rather than passing vacuously.
 */
const installedPath = process.env["LECODING_INSTALLED_APP_PATH"];
const expectedArch = process.env["LECODING_INSTALLED_APP_ARCH"];
const reason =
  !installedPath || !expectedArch
    ? "set LECODING_INSTALLED_APP_PATH and LECODING_INSTALLED_APP_ARCH to run the installed-app smoke"
    : !existsSync(installedPath)
      ? `LECODING_INSTALLED_APP_PATH does not exist: ${installedPath}`
      : undefined;

/** Walks a packaged app looking for a file by name. */
function findFile(root: string, fileName: string): string | undefined {
  if (!existsSync(root)) {
    return undefined;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return absolute;
    }
    if (entry.isDirectory()) {
      const found = findFile(absolute, fileName);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/** Reads the packaged app's `package.json` to learn its entry points. */
function readPackagedManifest(appRoot: string): {
  main?: string;
  version?: string;
} {
  const resources =
    findFile(appRoot, "package.json") ?? join(appRoot, "Resources", "app", "package.json");
  if (!existsSync(resources)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(resources, "utf8")) as {
      main?: string;
      version?: string;
    };
  } catch {
    return {};
  }
}

describe.skipIf(reason !== undefined)(
  `installed desktop app smoke${reason ? ` (skipped: ${reason})` : ""}`,
  () => {
    const appRoot = resolve(installedPath ?? ".");

    it("ships the packaged Renderer entry the main process loads", () => {
      // forge.config.ts points the main process at dist/renderer/index.html,
      // so a missing bundle means the app opens a blank window.
      const renderer = findFile(appRoot, "index.html");
      expect(renderer).toBeTruthy();
      const relative = renderer!.slice(appRoot.length).split(sep).join("/");
      expect(relative).toContain("dist/renderer/index.html");
      expect(statSync(renderer!).size).toBeGreaterThan(0);
    });

    it("ships the compiled preload and main entry points", () => {
      const manifest = readPackagedManifest(appRoot);
      // A package whose `main` still points at the factory module would boot
      // nothing at all.
      expect(manifest.main).toBe("dist/main/electron.js");
      const preload = findFile(appRoot, "index.js");
      expect(preload).toBeTruthy();
      expect(preload!.split(sep).join("/")).toContain("dist/preload/index.js");
    });

    it("ships only binaries matching the target architecture", () => {
      validateArchitectures({
        expected: expectedArch as "x64" | "arm64",
        entries: collectBinaries(appRoot),
        source: `installed app ${appRoot}`
      });
    });

    it("embeds a real version rather than the 0.0.0 placeholder", () => {
      const manifest = readPackagedManifest(appRoot);
      expect(manifest.version).toBeTruthy();
      expect(manifest.version).not.toBe("0.0.0");
    });
  }
);
