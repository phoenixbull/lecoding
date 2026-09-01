/**
 * CI build script for the desktop Electron app.
 *
 * Cross-platform: runs on macOS (darwin) and Windows (win32) CI runners.
 * Decodes signing credentials from env vars, drives electron-forge's
 * `make` command, and prints the produced artifacts so the upload
 * step in the workflow can pick them up.
 *
 * Why a script and not a raw `electron-forge make` in the workflow?
 *   - CSC_LINK arrives as base64 from GitHub secrets; it must be
 *     decoded to a .p12 file on disk before forge can use it.
 *   - pnpm's symlinked node_modules layout breaks asar packing and
 *     native-module walking on Windows, so we do a hoisted install
 *     into a temp dir before packaging.
 *   - The forge config is shared via `forge.config.ts` so the same
 *     schema is exercised everywhere.
 *
 * Usage (from repo root):
 *   node scripts/ci-desktop-make.mjs <platform>
 *
 * Environment:
 *   CSC_LINK             : base64-encoded .p12 (Windows)
 *   CSC_KEY_PASSWORD     : .p12 password
 *   APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID : macOS notarize
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, execSync } from "node:child_process";

const DESKTOP_DIR = resolve(import.meta.dirname, "..", "apps", "desktop");
const platform = process.argv[2];

if (!platform) {
  console.error("Usage: ci-desktop-make.mjs <darwin|win32>");
  process.exit(1);
}

function run(cmd, args, options = {}) {
  console.error(`$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: DESKTOP_DIR,
    shell: process.platform === "win32",
    ...options
  });
  if (result.status !== 0) {
    console.error(`Command failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
  return result;
}

function decodeBase64ToFile(base64Value, fileName) {
  const dir = join(tmpdir(), "lecoding-ci-certs");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, fileName);
  const buffer = Buffer.from(base64Value, "base64");
  writeFileSync(filePath, buffer);
  console.error(`[ci] decoded certificate to ${filePath} (${buffer.length} bytes)`);
  return filePath;
}

function prepareSigningEnv() {
  const env = { ...process.env };
  if (platform === "win32" && env.CSC_LINK) {
    // electron-forge/maker-squirrel expects a file path on disk, not base64.
    const certPath = decodeBase64ToFile(env.CSC_LINK, "cert.p12");
    env.CSC_LINK = certPath;
  }
  return env;
}

function main() {
  console.error(`[ci] building desktop for ${platform}`);
  console.error(`[ci] working dir: ${DESKTOP_DIR}`);

  // 1. Decode signing certs (if any) and set up env for forge.
  const forgeEnv = prepareSigningEnv();

  // 2. Build the TypeScript source (main + preload + shared).
  //    forge needs JS entry points; tsconfig.build.json emits to dist/.
  //    First stage workspace symlinks under apps/desktop/node_modules so
  //    TS + Node module resolution can find @lecoding/* — pnpm's isolated
  //    workspace layout keeps those links out of sub-package trees.
  console.error("[ci] staging workspace symlinks");
  const compileNm = join(DESKTOP_DIR, "node_modules");
  mkdirSync(compileNm, { recursive: true });
  run("pnpm", ["install", "--filter", "@lecoding/desktop...", "--offline"], {
    env: { ...forgeEnv }
  });

  console.error("[ci] compiling TypeScript");
  run("pnpm", ["exec", "tsc", "--project", "tsconfig.build.json"], {
    env: { ...forgeEnv }
  });

  // 3. Run electron-forge make for the target platform.
  //    --arch defaults to the runner's arch (x64 on windows-latest).
  //
  //    In a pnpm workspace with node-linker=hoisted, all third-party
  //    packages (including @electron-forge/*) live in the root
  //    node_modules, not under apps/desktop/node_modules. electron-forge's
  //    flora-colossus walker starts from the package dir and only walks
  //    downward, so it cannot find its own deps from the root. We stage
  //    a junction (Windows) / symlink-loop (POSIX) from the root
  //    node_modules into apps/desktop/node_modules so flora-colossus sees
  //    a flat layout. This is a build-time seam — production code does
  //    not import from electron-forge.
  const rootNm = join(DESKTOP_DIR, "..", "..", "node_modules");
  const desktopNm = join(DESKTOP_DIR, "node_modules");
  console.error(`[ci] staging root node_modules under apps/desktop/node_modules`);
  mkdirSync(desktopNm, { recursive: true });
  if (process.platform === "win32") {
    // Junction a temporary copy of the root node_modules at apps/desktop/.
    // flora-colossus reads the copy's directory entries directly, which
    // resolves to the real files under the junction. @lecoding/* workspace
    // symlinks are preserved by moving them aside and back.
    const lecodingLink = join(desktopNm, "@lecoding");
    const lecodingHidden = join(DESKTOP_DIR, ".tmp-lecoding-link");
    if (existsSync(lecodingLink)) {
      execSync(`move "${lecodingLink}" "${lecodingHidden}"`, { stdio: "inherit" });
    }
    const junctionTarget = join(DESKTOP_DIR, ".tmp-desktop-nm");
    execSync(`cmd /c mklink /J "${junctionTarget}" "${rootNm}"`, { stdio: "inherit" });
    execSync(`xcopy "${junctionTarget}" "${desktopNm}" /E /I /Y /Q`, { stdio: "inherit" });
    execSync(`rmdir "${junctionTarget}"`, { stdio: "inherit" });
    if (existsSync(lecodingHidden)) {
      execSync(`move "${lecodingHidden}" "${lecodingLink}"`, { stdio: "inherit" });
    }
  } else {
    // POSIX: symlink each top-level entry from root node_modules.
    for (const entry of readdirSync(rootNm)) {
      const src = join(rootNm, entry);
      const dst = join(desktopNm, entry);
      if (existsSync(dst)) continue;
      try {
        execSync(`ln -s "${src}" "${dst}"`, { stdio: "pipe" });
      } catch {
        // Best effort: missing entries are fine.
      }
    }
  }
  console.error(`[ci] node_modules staging complete`);

  console.error(`[ci] running electron-forge make --platform=${platform}`);
  run("pnpm", ["make", "--platform", platform], {
    env: { ...forgeEnv }
  });

  // 4. Print artifact paths so the workflow upload step can find them.
  const outDir = join(DESKTOP_DIR, "out", "make");
  if (existsSync(outDir)) {
    console.error("[ci] artifacts produced:");
    try {
      const listing = execSync(
        process.platform === "win32"
          ? `dir /s /b "${outDir}"`
          : `find "${outDir}" -type f`,
        { encoding: "utf8" }
      );
      console.error(listing);
    } catch {
      console.error("  (could not list files)");
    }
  } else {
    console.error("[ci] WARNING: no out/make directory found");
  }

  console.error("[ci] done.");
}

main();
