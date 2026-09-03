/**
 * CI build script for the desktop Electron app.
 *
 * Cross-platform: runs on macOS (darwin) and Windows (win32) CI runners.
 * Decodes signing credentials from env vars, drives electron-forge's
 * `make` command, validates the produced artifacts, and prints them so the
 * upload step in the workflow can pick them up.
 *
 * Why a script and not a raw `electron-forge make` in the workflow?
 *   - CSC_LINK arrives as base64 from GitHub secrets; it must be
 *     decoded to a .p12 file on disk before forge can use it.
 *   - pnpm's symlinked node_modules layout breaks asar packing and
 *     native-module walking on Windows, so we do a hoisted install
 *     into a temp dir before packaging.
 *   - The forge config is shared via `forge.config.ts` so the same
 *     schema is exercised everywhere.
 *   - M1.4: the release matrix must prove that the artifact's file name and
 *     its actual Mach-O / PE architecture agree. A `darwin/x64` job used to
 *     run on an arm64 runner and silently publish an arm64 binary under an
 *     x64 name, so the runner, the packaged app, and every extracted archive
 *     are all checked before anything is uploaded.
 *
 * Usage (from repo root):
 *   node scripts/ci-desktop-make.mjs <platform> <arch>
 *
 * Environment:
 *   CSC_LINK             : base64-encoded .p12 (Windows)
 *   CSC_KEY_PASSWORD     : .p12 password
 *   APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID : macOS notarize
 *   LECODING_RELEASE_VERSION : version embedded in every artifact
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, readlinkSync, lstatSync, copyFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute, dirname, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const DESKTOP_DIR = resolve(import.meta.dirname, "..", "apps", "desktop");
const platform = process.argv[2];
const arch = process.argv[3];

const supportedTarget =
  (platform === "darwin" && (arch === "arm64" || arch === "x64")) ||
  (platform === "win32" && arch === "x64");
if (!supportedTarget) {
  console.error(
    "Usage: ci-desktop-make.mjs <darwin|win32> <arm64|x64> " +
      "(Windows supports x64 only)"
  );
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

/** Runs a command that is allowed to fail; returns its exit status. */
function tryRun(cmd, args, options = {}) {
  console.error(`$ ${cmd} ${args.join(" ")}`);
  return spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: DESKTOP_DIR,
    shell: process.platform === "win32",
    ...options
  }).status ?? 1;
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

/**
 * Materialize pnpm workspace symlinks under node_modules/@lecoding/*.
 *
 * pnpm creates symlinks for workspace packages that point OUTSIDE the
 * package tree (e.g. node_modules/@lecoding/client-sdk ->
 * ../../packages/client-sdk). Both electron-packager's flora-colossus
 * walker and asar reject these cross-boundary links.
 *
 * This function walks node_modules/@lecoding/* and replaces each symlink
 * with a real recursive copy. Nested symlinks inside the copied package
 * (e.g. @lecoding/client-sdk/node_modules/@lecoding/contracts) are also
 * materialized so the entire subtree is self-contained.
 *
 * Must run AFTER the root node_modules staging step so @lecoding links
 * are present in desktop/node_modules.
 */
function materializeWorkspaceLinks(nodeModulesDir) {
  replaceSymlinksWithCopies(join(nodeModulesDir, "@lecoding"), (entryPath) => {
    // Recursively materialize any nested @lecoding/* symlinks inside the
    // newly-copied package (e.g. client-sdk -> contracts). One level of
    // nesting is enough: workspace packages only depend on sibling
    // @lecoding/* packages, and those pull in no further @lecoding deps.
    replaceSymlinksWithCopies(
      join(entryPath, "node_modules", "@lecoding"),
      () => undefined
    );
  });
}

/**
 * Replaces every symlink directly under `scopeDir` with a real copy.
 *
 * `afterCopy` runs once per replaced entry so callers can recurse into the
 * copy. Both nesting levels in this repo need identical handling, so the walk
 * lives in one place rather than two near-identical loops.
 */
function replaceSymlinksWithCopies(scopeDir, afterCopy) {
  if (!existsSync(scopeDir)) return;

  // Collect entries first to avoid mutating the dir while iterating.
  const entries = readdirSync(scopeDir);
  for (const entry of entries) {
    const entryPath = join(scopeDir, entry);
    if (!lstatSync(entryPath).isSymbolicLink()) {
      continue;
    }
    // Resolve the link target to an absolute path, then copy the real dir.
    let target = readlinkSync(entryPath);
    if (!isAbsolute(target)) {
      target = resolve(dirname(entryPath), target);
    }
    rmSync(entryPath, { recursive: true, force: true });
    mkdirSync(entryPath, { recursive: true });
    copyDirRecursive(target, entryPath);
    afterCopy(entryPath);
  }
}

function copyDirRecursive(src, dst) {
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dstPath, { recursive: true });
      copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, dstPath);
    }
    // Skip symlinks, device files, etc. — workspace packages only have
    // regular source files and directories.
  }
}

/** Collect regular files under a directory as stable POSIX-style paths. */
function collectArtifactPaths(rootDir, currentDir = rootDir) {
  if (!existsSync(currentDir)) return [];
  const paths = [];
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...collectArtifactPaths(rootDir, absolutePath));
    } else if (entry.isFile()) {
      paths.push(relative(rootDir, absolutePath).split(sep).join("/"));
    }
  }
  return paths.sort();
}

/** Imports a compiled builder module from apps/desktop/dist/build. */
async function importBuilder(name) {
  const url = pathToFileURL(
    join(DESKTOP_DIR, "dist", "build", `${name}.js`)
  ).href;
  return import(url);
}

/**
 * M1.4: refuse to run when the runner cannot produce the requested
 * architecture.
 *
 * The historical defect was an x64 job scheduled on an arm64 runner. Checking
 * `process.arch` catches the obvious case, and the Rosetta probe catches the
 * subtler one where an arm64 Mac reports x64 because Node is translated —
 * that combination builds an arm64 binary while every path says x64.
 */
function assertRunnerArchitecture() {
  if (process.arch !== arch) {
    console.error(
      `[ci] FATAL: runner reports process.arch="${process.arch}" but the job ` +
        `targets ${arch}. Schedule this job on a native ${arch} runner.`
    );
    process.exit(3);
  }
  if (process.platform === "darwin") {
    const probe = spawnSync("sysctl", ["-n", "sysctl.proc_translated"], {
      encoding: "utf8"
    });
    if (probe.status === 0 && probe.stdout.trim() === "1") {
      console.error(
        `[ci] FATAL: this macOS runner executes Node under Rosetta 2. A ` +
          `${arch} build must run natively, not translated.`
      );
      process.exit(3);
    }
  }
  console.error(`[ci] runner architecture verified: ${process.platform}/${process.arch}`);
}

/** Locates electron-forge's packaged app directory for this matrix job. */
function findPackagedRoot(outDir) {
  if (!existsSync(outDir)) return undefined;
  const suffix = `-${platform}-${arch}`;
  const match = readdirSync(outDir, { withFileTypes: true }).find(
    (entry) => entry.isDirectory() && entry.name.endsWith(suffix)
  );
  return match ? join(outDir, match.name) : undefined;
}

/** Collects the archive files whose contents must be re-validated. */
function findArchives(rootDir, extensions) {
  return collectArtifactPaths(rootDir).filter((path) =>
    extensions.some((extension) => path.toLowerCase().endsWith(extension))
  );
}

/** Extracts an archive into a scratch directory and returns the directory. */
function extractArchive(archivePath, destination) {
  mkdirSync(destination, { recursive: true });
  if (archivePath.toLowerCase().endsWith(".dmg")) {
    return attachDmg(archivePath, destination);
  }
  if (archivePath.toLowerCase().endsWith(".exe")) {
    // Squirrel's setup is a 7z SFX; only 7z can open it.
    const sevenZip = findSevenZip();
    if (!sevenZip) {
      return undefined;
    }
    // `-y` answers "yes" to every overwrite prompt so the call cannot hang.
    return tryRun(sevenZip, ["x", archivePath, `-o${destination}`, "-y"]) === 0
      ? destination
      : undefined;
  }
  // Both ZIP (macOS) and NUPKG (Windows) are ZIP containers; `tar` ships with
  // Windows 10+ and handles them, while `unzip` is guaranteed on macOS.
  const status =
    process.platform === "win32"
      ? tryRun("tar", ["-xf", archivePath, "-C", destination])
      : tryRun("unzip", ["-q", "-o", archivePath, "-d", destination]);
  return status === 0 ? destination : undefined;
}

/** Mounts a DMG and returns the mount point, or undefined on failure. */
function attachDmg(dmgPath, mountPoint) {
  const status = tryRun("hdiutil", [
    "attach",
    "-nobrowse",
    "-quiet",
    "-mountpoint",
    mountPoint,
    dmgPath
  ]);
  return status === 0 ? mountPoint : undefined;
}

function detachDmg(mountPoint) {
  tryRun("hdiutil", ["detach", "-quiet", mountPoint]);
}

/**
 * Path to the 7z binary electron-winstaller ships.
 *
 * The Squirrel setup `.exe` is a 7z self-extracting archive, not a zip, so
 * `tar` cannot open it. 7z is the only tool available on a Windows runner that
 * can — and it is already staged by the vendor step above.
 */
function findSevenZip() {
  const candidate = join(
    DESKTOP_DIR,
    "..",
    "..",
    "node_modules",
    "electron-winstaller",
    "vendor",
    "7z.exe"
  );
  return existsSync(candidate) ? candidate : undefined;
}

async function validateArchitecture() {
  const { collectBinaries, validateArchitectures } = await importBuilder("architecture");
  const outDir = join(DESKTOP_DIR, "out");
  const makeDir = join(outDir, "make");

  const packagedRoot = findPackagedRoot(outDir);
  if (!packagedRoot) {
    console.error(
      `[ci] FATAL: no packaged app directory ending in -${platform}-${arch} ` +
        "was produced; the package step failed silently."
    );
    process.exit(4);
  }
  validateArchitectures({
    expected: arch,
    entries: collectBinaries(packagedRoot),
    source: `packaged app ${relative(DESKTOP_DIR, packagedRoot)}`
  });
  console.error(`[ci] packaged app architecture verified: ${arch}`);

  // Re-check inside the shipped archives: the packaged tree and the archive
  // the user downloads are produced by different steps. The Windows setup
  // `.exe` matters most of all — it is the file a user actually runs.
  const extensions = platform === "darwin" ? [".zip", ".dmg"] : [".exe", ".nupkg"];
  const archives = findArchives(makeDir, extensions);
  if (archives.length === 0) {
    console.error(
      `[ci] FATAL: no ${extensions.join(" / ")} archive was produced under out/make.`
    );
    process.exit(4);
  }
  for (const archive of archives) {
    const relativeArchive = join("out", "make", archive);
    const destination = join(
      tmpdir(),
      `lecoding-arch-check-${platform}-${arch}-${Buffer.from(archive).toString("hex").slice(0, 8)}`
    );
    const extracted = extractArchive(relativeArchive, destination);
    if (!extracted) {
      console.error(
        `[ci] FATAL: cannot extract ${relativeArchive} to verify its architecture.`
      );
      process.exit(4);
    }
    try {
      validateArchitectures({
        expected: arch,
        entries: collectBinaries(extracted),
        source: `archive ${archive}`
      });
      console.error(`[ci] archive architecture verified: ${archive} → ${arch}`);
    } finally {
      if (archive.toLowerCase().endsWith(".dmg")) {
        detachDmg(destination);
      }
    }
  }
}

/**
 * Collects platform-native signing evidence for the produced artifacts.
 *
 * Signing is an external dependency (a certificate we may not hold yet), so
 * the outcome is recorded rather than assumed: `unsigned` artifacts are still
 * allowed to be published as a pre-release, but never as a stable one.
 */
function collectSigningEvidence() {
  const lines = [`platform=${platform}`, `arch=${arch}`];
  let signed = false;

  if (platform === "darwin") {
    const packagedRoot = findPackagedRoot(join(DESKTOP_DIR, "out"));
    const app = packagedRoot
      ? readdirSync(packagedRoot).find((entry) => entry.endsWith(".app"))
      : undefined;
    if (app) {
      const appPath = join(packagedRoot, app);
      const verify = tryRun("codesign", [
        "--verify",
        "--deep",
        "--strict",
        "--verbose=2",
        appPath
      ]);
      lines.push(`codesign=${verify === 0 ? "valid" : "missing-or-invalid"}`);
      // Gatekeeper assessment is what actually proves notarization.
      const notarized = tryRun("spctl", [
        "--assess",
        "--type",
        "execute",
        "--ignore-cache",
        "--no-cache",
        appPath
      ]);
      lines.push(`notarization=${notarized === 0 ? "accepted" : "not-accepted"}`);
      signed = verify === 0 && notarized === 0;
    } else {
      lines.push("codesign=no-app-found");
    }
  } else {
    const setup = collectArtifactPaths(join(DESKTOP_DIR, "out", "make")).find(
      (path) => path.toLowerCase().endsWith(".exe")
    );
    if (setup) {
      const status = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-AuthenticodeSignature '${join(DESKTOP_DIR, "out", "make", setup)}').Status`
        ],
        { encoding: "utf8", shell: true }
      );
      const value = (status.stdout ?? "").trim();
      lines.push(`authenticode=${value || "unknown"}`);
      signed = value === "Valid";
    } else {
      lines.push("authenticode=no-setup-found");
    }
  }

  lines.push(`signed=${signed ? "true" : "false"}`);
  return { signed, lines };
}

async function main() {
  console.error(`[ci] building desktop for ${platform}/${arch}`);
  console.error(`[ci] working dir: ${DESKTOP_DIR}`);

  // M0.4: refuse to run if the workflow forgot to export
  // LECODING_RELEASE_VERSION. Falling back to npm_package_version or
  // a hard-coded `0.0.0` is the exact regression the planning document
  // calls out as release-blocking (tag `v0.1.0` → installer `0.0.0`).
  const releaseVersion = process.env["LECODING_RELEASE_VERSION"];
  if (!releaseVersion) {
    console.error(
      "[ci] FATAL: LECODING_RELEASE_VERSION is not set. CI workflows " +
        "must export it from the trigger tag before invoking this script."
    );
    process.exit(2);
  }
  console.error(`[ci] release version: ${releaseVersion}`);

  // M1.4: the runner itself is part of the release evidence.
  assertRunnerArchitecture();

  // 1. Decode signing certs (if any) and set up env for forge.
  const forgeEnv = prepareSigningEnv();

  // 2. Build the TypeScript source (main + preload + shared) and the Vite
  //    Renderer bundle. forge needs JS entry points; tsconfig.build.json emits
  //    to dist/ and the Renderer lands in dist/renderer, which is exactly the
  //    path forge.config.ts declares as the packaged entry.
  //    First stage workspace symlinks under apps/desktop/node_modules so
  //    TS + Node module resolution can find @lecoding/* — pnpm's isolated
  //    workspace layout keeps those links out of sub-package trees.
  console.error("[ci] staging workspace symlinks");
  const compileNm = join(DESKTOP_DIR, "node_modules");
  mkdirSync(compileNm, { recursive: true });
  run("pnpm", ["install", "--filter", "@lecoding/desktop...", "--offline"], {
    env: { ...forgeEnv }
  });

  console.error("[ci] building the Renderer bundle");
  run("pnpm", ["run", "build:renderer"], { env: { ...forgeEnv } });

  console.error("[ci] compiling TypeScript");
  run("pnpm", ["exec", "tsc", "--project", "tsconfig.build.json"], {
    env: { ...forgeEnv }
  });

  // 3. Stage root node_modules into apps/desktop/node_modules.
  //
  //    In a pnpm workspace with node-linker=hoisted, all third-party
  //    packages (including @electron-forge/*) live in the root
  //    node_modules, not under apps/desktop/node_modules. electron-forge's
  //    flora-colossus walker starts from the package dir and only walks
  //    downward, so it cannot find its own deps from the root.
  //
  //    We link each top-level entry of the root node_modules into
  //    desktop/node_modules (junction on Windows, symlink on POSIX) so
  //    flora-colossus sees a flat layout. @lecoding/* workspace symlinks
  //    are skipped because we materialize them separately below.
  //
  //    This is a build-time seam — production code does not import from
  //    electron-forge.
  const rootNm = join(DESKTOP_DIR, "..", "..", "node_modules");
  const desktopNm = join(DESKTOP_DIR, "node_modules");
  console.error(`[ci] staging root node_modules under apps/desktop/node_modules`);
  mkdirSync(desktopNm, { recursive: true });
  stageRootNodeModules(rootNm, desktopNm);
  console.error(`[ci] node_modules staging complete`);

  // 4. Ensure vendor/7z.exe exists in electron-winstaller's vendor dir.
  //    electron-winstaller's post-install only creates vendor/7z.exe on
  //    the host that ran `npm install` (e.g. macOS arm64 → 7z-arm64.exe).
  //    On a different OS runner (e.g. Windows), vendor/7z.exe is missing
  //    and Squirrel --releasify fails with "The system cannot find the
  //    file specified" when it tries to spawn `7z.exe` to zip the
  //    release. Create a copy of the arch-specific 7z binary so
  //    Squirrel can find it.
  if (platform === "win32") {
    const vendorDir = join(rootNm, "electron-winstaller", "vendor");
    const archExe = join(vendorDir, "7z-x64.exe");
    const archDll = join(vendorDir, "7z-x64.dll");
    const genericExe = join(vendorDir, "7z.exe");
    const genericDll = join(vendorDir, "7z.dll");
    if (existsSync(archExe) && !existsSync(genericExe)) {
      copyFileSync(archExe, genericExe);
      console.error("[ci] created vendor/7z.exe from 7z-x64.exe");
    }
    if (existsSync(archDll) && !existsSync(genericDll)) {
      copyFileSync(archDll, genericDll);
    }
  }

  // 4. Materialize workspace symlinks under @lecoding/*.
  //    pnpm hoist mode creates symlinks like
  //    node_modules/@lecoding/client-sdk -> ../../packages/client-sdk
  //    which point OUTSIDE the desktop package tree. electron-packager's
  //    flora-colossus walker and asar both reject cross-package symlinks
  //    ("links out of the package" / "Failed to locate module").
  //    We replace each @lecoding/* symlink with a real directory copy so
  //    the packager sees a self-contained node_modules tree.
  console.error(`[ci] materializing @lecoding/* workspace symlinks`);
  materializeWorkspaceLinks(desktopNm);
  console.error(`[ci] workspace links materialized`);

  // 5. Rebuild native addons that need node-gyp.
  //    pnpm v10 does NOT auto-run install scripts for security. Packages
  //    like macos-alias and fs-xattr ship a binding.gyp but no install
  //    script, so pnpm never triggers node-gyp even with
  //    onlyBuiltDependencies set. We rebuild them manually via npx so
  //    makers like @electron-forge/maker-dmg can load their native .node
  //    binaries. Only rebuild for the target OS.
  const nativeAddons =
    platform === "darwin"
      ? ["macos-alias", "fs-xattr"]
      : [];
  if (nativeAddons.length > 0) {
    console.error(`[ci] rebuilding native addons: ${nativeAddons.join(", ")}`);
    for (const pkg of nativeAddons) {
      const pkgDir = join(rootNm, pkg);
      if (!existsSync(pkgDir)) continue;
      // node-gyp rebuild compiles the addon for the host Node version.
      // This is fine because forge makers run in the CI Node process,
      // not in the packaged Electron app.
      const gypResult = spawnSync(
        "npx",
        ["--yes", "node-gyp", "rebuild"],
        {
          stdio: "inherit",
          cwd: pkgDir,
          shell: process.platform === "win32",
          env: { ...process.env, ...forgeEnv }
        }
      );
      if (gypResult.status !== 0) {
        console.error(
          `[ci] WARNING: node-gyp rebuild failed for ${pkg} (exit ${gypResult.status})`
        );
      }
    }
  }

  console.error(
    `[ci] running electron-forge make --platform=${platform} --arch=${arch}`
  );
  // Enable debug output so CI logs show what electron-winstaller is
  // actually doing (it spawns external tools like Update.exe and the
  // default error message is just "Failed with exit code: 1").
  // The debug namespace is "electron-windows-installer" (note: NOT
  // "electron-winstaller").
  const makeEnv = {
    ...forgeEnv,
    DEBUG: (forgeEnv.DEBUG ? `${forgeEnv.DEBUG},` : "") + "electron-windows-installer:*"
  };
  run("pnpm", ["make", "--platform", platform, "--arch", arch], {
    env: makeEnv
  });

  // Validate before upload so the release cannot silently accept an empty,
  // wrong-version, wrong-architecture, or self-overwriting make directory.
  const outDir = join(DESKTOP_DIR, "out", "make");
  const relativePaths = collectArtifactPaths(outDir);
  const { resolveReleaseVersion, validateDesktopReleaseArtifacts } =
    await importBuilder("forge-config");
  const { validateReleaseAssets } = await importBuilder("release-assets");
  const appVersion = resolveReleaseVersion({ releaseTag: releaseVersion });

  validateDesktopReleaseArtifacts({ platform, arch, appVersion, relativePaths });
  // Every artifact must name its version and architecture, and no two may
  // share a file name — GitHub release assets are addressed by name, so a
  // collision silently drops an architecture from the release.
  validateReleaseAssets({ version: appVersion, platform, arch, assets: relativePaths });
  // The file name is only a promise; read the actual Mach-O / PE headers.
  await validateArchitecture();

  // Record signing evidence. A certificate is an external dependency, so an
  // unsigned build is reported (and can ship as a pre-release) instead of
  // silently passing the release gate.
  const evidence = collectSigningEvidence();
  // The file name carries platform and arch: all three jobs upload into one
  // release, and a shared `signing-evidence.txt` would trip the duplicate-name
  // gate (and silently overwrite two of the three reports).
  writeFileSync(
    join(outDir, `signing-evidence-${platform}-${arch}.txt`),
    `${evidence.lines.join("\n")}\n`
  );
  console.error(`[ci] signing evidence:\n${evidence.lines.join("\n")}`);
  if (!evidence.signed && process.env["LECODING_REQUIRE_SIGNED_ARTIFACTS"] === "true") {
    console.error(
      "[ci] FATAL: LECODING_REQUIRE_SIGNED_ARTIFACTS is true but this artifact " +
        "is not signed. Obtain the platform certificate or publish as a pre-release."
    );
    process.exit(5);
  }

  console.error("[ci] validated artifacts produced:");
  console.error(relativePaths.join("\n"));

  console.error("[ci] done.");
}

/**
 * Link top-level entries from the root (hoisted) node_modules into
 * apps/desktop/node_modules.
 *
 * Uses directory junctions on Windows and symlinks on POSIX. Skips
 * entries that already exist in the target (e.g. @lecoding/* workspace
 * symlinks created by pnpm — those are handled separately by
 * materializeWorkspaceLinks).
 */
function stageRootNodeModules(rootNm, desktopNm) {
  for (const entry of readdirSync(rootNm)) {
    const src = join(rootNm, entry);
    const dst = join(desktopNm, entry);
    if (existsSync(dst)) continue;
    // On Windows, use directory junctions (mklink /J equivalent via
    // fs.symlink with type "junction"). On POSIX, use regular symlinks.
    try {
      const stat = statSync(src);
      if (stat.isDirectory()) {
        symlinkSync(src, dst, process.platform === "win32" ? "junction" : "dir");
      } else {
        symlinkSync(src, dst);
      }
    } catch {
      // Best effort: individual failures don't abort the whole staging.
      // flora-colossus / forge will fail loudly later if something
      // critical is missing.
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ci] FATAL: ${message}`);
  process.exit(1);
});
