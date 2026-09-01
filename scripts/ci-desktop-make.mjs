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
  console.error("[ci] compiling TypeScript");
  run("npx", ["tsc", "--project", "tsconfig.build.json"], {
    env: { ...forgeEnv }
  });

  // 3. Run electron-forge make for the target platform.
  //    --arch defaults to the runner's arch (x64 on windows-latest).
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
