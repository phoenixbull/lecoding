/**
 * Electron Forge packaging configuration.
 *
 * Produces signed Windows and macOS installers with the security baseline
 * mandated by PRD § 10.1. The schema matches what `electron-forge` CLI
 * actually accepts in `forge.config.{js,ts}`:
 *
 *  - `makers[]` entries use fully-qualified `@electron-forge/maker-*`
 *    package names. Bare identifiers (`"zip"`, `"squirrel"`, `"msi"`)
 *    are NOT legal — forge resolves the name through Node's package
 *    resolver and a missing entry fails the build before any artifact
 *    is produced.
 *  - macOS codesign (`osxSign`) and notarize (`osxNotarize`) live under
 *    `packagerConfig`, NOT inside a maker config. Forge wires these
 *    during `package`, before any maker runs, so the `.app` is signed
 *    before it's zipped / DMG'd.
 *  - Windows code signing is per-maker: `@electron-forge/maker-squirrel`
 *    accepts `certificateFile` + `certificatePassword` in its `config`.
 *    The single Squirrel maker emits both the Squirrel-style `.exe`
 *    installer and the `.msi` for system administrators.
 *  - Native Node bindings (keytar, better-sqlite3, fsevents) are
 *    unpacked from the asar so they load at runtime — Node native
 *    addons cannot be loaded from inside an asar.
 *  - The Renderer entry is a packaged file:// path; remote URLs are
 *    forbidden in the config (the security baseline lives in
 *    main/index.ts but the build config must NOT bypass it by accident).
 *
 * The factory function `buildForgeConfig` takes only the inputs that
 * vary per environment so tests can exercise it without pulling in the
 * real electron-forge runtime.
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Credential inputs read from the environment by the build pipeline. */
export interface SigningEnvironment {
  CSC_LINK?: string;
  CSC_KEY_PASSWORD?: string;
  APPLE_ID?: string;
  APPLE_APP_SPECIFIC_PASSWORD?: string;
  APPLE_TEAM_ID?: string;
}

export interface ForgeConfigInputs {
  appName: string;
  appVersion: string;
  rendererEntry: string;
  mainEntry: string;
  preloadEntry: string;
  signEnv: SigningEnvironment;
  repository: string;
}

/** Subset of electron-forge maker shape the build pipeline consumes. */
export interface ForgeMaker {
  name: string;
  platforms?: Array<"darwin" | "win32" | "linux">;
  config?: Record<string, unknown>;
}

/** Subset of electron-forge packagerConfig the build pipeline consumes. */
export interface ForgePackagerConfig {
  asar: true;
  asarUnpack?: string[];
  osxSign?: Record<string, unknown>;
  osxNotarize?: Record<string, unknown>;
}

export interface AutoUpdateConfig {
  provider: "github";
  owner: string;
  repo: string;
  verifySignature: true;
  tagPrefix?: string;
}

export interface ForgeConfig {
  appName: string;
  appId: string;
  publisher: string;
  rendererEntry: string;
  mainEntry: string;
  preloadEntry: string;
  packagerConfig: ForgePackagerConfig;
  makers: ForgeMaker[];
  autoUpdate: AutoUpdateConfig;
}

export function isReleaseSigningEnabled(env: SigningEnvironment): boolean {
  const hasWindowsCert = Boolean(env.CSC_LINK);
  const hasAppleTeam = Boolean(
    env.APPLE_TEAM_ID && env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD
  );
  return hasWindowsCert || hasAppleTeam;
}

function buildPackagerConfig(signEnv: SigningEnvironment): ForgePackagerConfig {
  // asar is mandatory for the security baseline (it makes the Renderer
  // bundle tamper-evident at startup). Native bindings must be unpacked
  // because Node cannot dlopen() a module from inside an asar archive.
  const packager: ForgePackagerConfig = {
    asar: true,
    asarUnpack: [
      "**/node_modules/better-sqlite3/**",
      "**/node_modules/keytar/**",
      "**/node_modules/fsevents/**",
      "**/node_modules/@lecoding/local-runner/**/native/**"
    ]
  };
  // osxSign / osxNotarize are top-level packager concerns, NOT maker
  // concerns. Forge applies them during the `package` step, before any
  // maker runs, so the .app is signed before it's packaged into a zip
  // / dmg / tar.xz.
  if (isReleaseSigningEnabled(signEnv)) {
    packager.osxSign = {
      identity: "Developer ID Application: LeCoding",
      "hardened-runtime": true,
      "gatekeeper-assess": false,
      entitlements: "build/entitlements.mac.plist",
      "entitlements-inherit": "build/entitlements.mac.plist"
    };
    if (signEnv.APPLE_ID && signEnv.APPLE_TEAM_ID && signEnv.APPLE_APP_SPECIFIC_PASSWORD) {
      packager.osxNotarize = {
        tool: "notarytool",
        appleId: signEnv.APPLE_ID,
        appleIdPassword: signEnv.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: signEnv.APPLE_TEAM_ID
      };
    }
  }
  return packager;
}

function buildMacosMakers(signEnv: SigningEnvironment): ForgeMaker[] {
  // Three independent makers on darwin so each output format has its own
  // artifact path and signing provenance. The `config` block is left
  // empty; osxSign / osxNotarize on packagerConfig already cover the
  // signing concerns.
  //  - zip:   portable .app bundle in a zip (auto-update baseline)
  //  - dmg:   standard macOS drag-to-install disk image
  //  - pkg:   system-level installer package (for MDM / enterprise)
  //
  // Fallback: when no Apple notarization credentials are available
  // (APPLE_ID / APPLE_TEAM_ID / APPLE_APP_SPECIFIC_PASSWORD all empty),
  // drop maker-pkg because it always tries to sign the .pkg via
  // @electron/osx-sign and fails with "No identity found" even when
  // `osxSign` is disabled at the packager level. zip + dmg remain
  // usable for manual distribution, just not for MDM / enterprise.
  const hasAppleTeam = Boolean(
    signEnv.APPLE_TEAM_ID && signEnv.APPLE_ID && signEnv.APPLE_APP_SPECIFIC_PASSWORD
  );
  const makers: ForgeMaker[] = [
    { name: "@electron-forge/maker-zip", platforms: ["darwin"] },
    { name: "@electron-forge/maker-dmg", platforms: ["darwin"] }
  ];
  if (hasAppleTeam) {
    makers.push({ name: "@electron-forge/maker-pkg", platforms: ["darwin"] });
  }
  return makers;
}

function buildWindowsMaker(
  signEnv: SigningEnvironment,
  appVersion: string
): ForgeMaker {
  // The single Squirrel maker emits both the Squirrel-style `.exe`
  // installer AND a `.msi` for system administrators. Windows code
  // signing is per-maker — we only need one entry for the platform.
  //
  // `name` is the nuspec package id (must NOT contain hyphens — Squirrel
  // replaces them with underscores). Version is appended automatically
  // by electron-winstaller, so do NOT put it in the name.
  // `title` is the user-facing display name shown in Add/Remove Programs.
  const config: Record<string, unknown> = {
    name: "lecode",
    title: "LeCoding",
    setupExe: `LeCoding-Setup-${appVersion}.exe`
  };
  if (isReleaseSigningEnabled(signEnv) && signEnv.CSC_LINK) {
    config["certificateFile"] = signEnv.CSC_LINK;
    config["certificatePassword"] = signEnv.CSC_KEY_PASSWORD;
  }
  return {
    name: "@electron-forge/maker-squirrel",
    config
  };
}

/**
 * Build a fully-typed Forge config. Pure function: same inputs always
 * produce the same config, so tests can pin behaviour.
 */
export function buildForgeConfig(inputs: ForgeConfigInputs): ForgeConfig {
  const {
    appName,
    appVersion,
    rendererEntry,
    mainEntry,
    preloadEntry,
    signEnv,
    repository
  } = inputs;
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(
      `forge-config: invalid repository "${repository}" (expected owner/repo)`
    );
  }
  return {
    appName,
    appId: "com.lecoding.desktop",
    publisher: "LeCoding",
    rendererEntry,
    mainEntry,
    preloadEntry,
    packagerConfig: buildPackagerConfig(signEnv),
    makers: [
      ...buildMacosMakers(signEnv),
      buildWindowsMaker(signEnv, appVersion)
    ],
    autoUpdate: {
      provider: "github",
      owner,
      repo,
      verifySignature: true
    }
  };
}

/**
 * Serialize a Forge config to disk. Useful as a one-shot helper for the
 * CI script; tests don't depend on this side effect.
 */
export function writeForgeConfig(config: ForgeConfig, targetPath?: string): string {
  const path = targetPath ?? join(tmpdir(), "forge.config.json");
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}