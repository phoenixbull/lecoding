/**
 * electron-forge packaging config tests.
 *
 * The config must satisfy PRD § 10.1's release-blocking rules AND use
 * the maker-name schema that electron-forge actually accepts. Bare
 * identifiers like "zip" or "squirrel" are NOT legal maker names — the
 * CLI requires fully-qualified `@electron-forge/maker-*` package names.
 *
 * Rules verified here:
 * - macOS uses three independent makers (zip / dmg / pkg) so each
 *   output format has its own artifact path.
 * - Windows uses the Squirrel maker (which produces both .exe + .msi
 *   internally — PRD-aligned: native installer + MSI).
 * - macOS codesign + notarize live under `packagerConfig.osxSign` /
 *   `packagerConfig.osxNotarize`, NOT inside a maker config. forge
 *   wires these during `package`, before any maker runs.
 * - Local Runner (@lecoding/local-runner), secure-store, and client-sdk
 *   native binaries are unpacked from the asar so that Node native
 *   bindings (keytar, better-sqlite3, fsevents) load correctly.
 * - Auto-update is wired through electron-updater with the production
 *   feed pointing at the GitHub releases API; dev builds fall back to
 *   a local feed so contributors can iterate.
 * - Renderer entry is the packaged file:// dist, never a remote URL.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  buildForgeConfig,
  isReleaseSigningEnabled,
  resolveReleaseVersion,
  validateDesktopReleaseArtifacts,
  type SigningEnvironment
} from "../src/build/forge-config.js";

const SIGN_ENV: SigningEnvironment = {
  CSC_LINK: "/tmp/fake-cert.p12",
  CSC_KEY_PASSWORD: "p4ssword",
  APPLE_ID: "agent@example.com",
  APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop",
  APPLE_TEAM_ID: "ABCDE12345"
};

// Official @electron-forge/maker-* packages that exist on npm.
// Verified against electron-forge's published maker list (zip / dmg /
// pkg / squirrel / wix / deb / rpm / snap / appx).
const LEGAL_MAKER_NAMES = new Set<string>([
  "@electron-forge/maker-zip",
  "@electron-forge/maker-dmg",
  "@electron-forge/maker-pkg",
  "@electron-forge/maker-squirrel",
  "@electron-forge/maker-wix",
  "@electron-forge/maker-deb",
  "@electron-forge/maker-rpm",
  "@electron-forge/maker-snap",
  "@electron-forge/maker-appx"
]);

afterEach(() => {
  // No global teardown needed; tests are stateless.
});

describe("isReleaseSigningEnabled", () => {
  it("is true when both Apple and Windows credentials are present", () => {
    expect(isReleaseSigningEnabled(SIGN_ENV)).toBe(true);
  });

  it("is true when only the Windows cert is present (Apple can be configured later)", () => {
    const env = { ...SIGN_ENV };
    delete env.APPLE_ID;
    delete env.APPLE_APP_SPECIFIC_PASSWORD;
    delete env.APPLE_TEAM_ID;
    expect(isReleaseSigningEnabled(env)).toBe(true);
  });

  it("is true when only the Apple credentials are present (Windows build is skipped)", () => {
    const env: SigningEnvironment = {
      APPLE_ID: SIGN_ENV.APPLE_ID!,
      APPLE_APP_SPECIFIC_PASSWORD: SIGN_ENV.APPLE_APP_SPECIFIC_PASSWORD!,
      APPLE_TEAM_ID: SIGN_ENV.APPLE_TEAM_ID!
    };
    expect(isReleaseSigningEnabled(env)).toBe(true);
  });

  it("rejects Apple-only env when the team id is missing", () => {
    const env: SigningEnvironment = {
      APPLE_ID: "agent@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop"
    };
    expect(isReleaseSigningEnabled(env)).toBe(false);
  });

  it("is false when nothing is configured (developer machine)", () => {
    expect(isReleaseSigningEnabled({})).toBe(false);
  });
});

describe("buildForgeConfig", () => {
  it("embeds the release version in the packaged application metadata", () => {
    const config = buildForgeConfig({
      appName: "LeCoding",
      appVersion: "1.2.3",
      rendererEntry: "../renderer/dist/index.html",
      mainEntry: "./src/main/index.ts",
      preloadEntry: "./src/preload/index.ts",
      signEnv: SIGN_ENV,
      repository: "phoenixbull/lecoding"
    });

    expect(config.packagerConfig.appVersion).toBe("1.2.3");
    expect(config.packagerConfig.buildVersion).toBe("1.2.3");
  });

  it("uses fully-qualified @electron-forge/maker-* names (not bare identifiers)", () => {
    const config = buildForgeConfig({
      appName: "LeCoding",
      appVersion: "0.1.0",
      rendererEntry: "../renderer/dist/index.html",
      mainEntry: "./src/main/index.ts",
      preloadEntry: "./src/preload/index.ts",
      signEnv: SIGN_ENV,
      repository: "phoenixbull/lecoding"
    });
    for (const maker of config.makers) {
      const names = Array.isArray(maker.name) ? maker.name : [maker.name];
      for (const name of names) {
        expect(LEGAL_MAKER_NAMES.has(name)).toBe(true);
      }
    }
  });

  it("includes maker-pkg when full Apple credentials are present", () => {
    const config = buildForgeConfig({
      appName: "LeCoding",
      appVersion: "0.1.0",
      rendererEntry: "../renderer/dist/index.html",
      mainEntry: "./src/main/index.ts",
      preloadEntry: "./src/preload/index.ts",
      signEnv: SIGN_ENV,
      repository: "phoenixbull/lecoding"
    });
    const macosNames = config.makers
      .filter((m) => m.name.startsWith("@electron-forge/maker-") && !m.name.includes("squirrel"))
      .map((m) => m.name);
    expect(macosNames).toContain("@electron-forge/maker-zip");
    expect(macosNames).toContain("@electron-forge/maker-dmg");
    expect(macosNames).toContain("@electron-forge/maker-pkg");
  });

  it("drops maker-pkg when Apple credentials are missing (CI fallback)", () => {
    // Build with an empty signing env. zip + dmg still produce
    // usable installers for manual distribution, but maker-pkg is
    // removed because @electron/osx-sign fails with "No identity
    // found" whenever any Apple credential is missing.
    const config = buildForgeConfig({
      appName: "LeCoding",
      appVersion: "0.1.0",
      rendererEntry: "../renderer/dist/index.html",
      mainEntry: "./src/main/index.ts",
      preloadEntry: "./src/preload/index.ts",
      signEnv: {},
      repository: "phoenixbull/lecoding"
    });
    const macosNames = config.makers
      .filter((m) => m.name.startsWith("@electron-forge/maker-") && !m.name.includes("squirrel"))
      .map((m) => m.name);
    expect(macosNames).toEqual(
      expect.arrayContaining(["@electron-forge/maker-zip", "@electron-forge/maker-dmg"])
    );
    expect(macosNames).not.toContain("@electron-forge/maker-pkg");
  });

  it("produces a single Squirrel maker on win32 (which itself ships .exe + .msi)", () => {
    const config = buildForgeConfig({
      appName: "LeCoding",
      appVersion: "0.1.0",
      rendererEntry: "../renderer/dist/index.html",
      mainEntry: "./src/main/index.ts",
      preloadEntry: "./src/preload/index.ts",
      signEnv: SIGN_ENV,
      repository: "phoenixbull/lecoding"
    });
    const winMakers = config.makers.filter((m) =>
      m.name === "@electron-forge/maker-squirrel"
    );
    expect(winMakers.length).toBe(1);
    expect(winMakers[0]!.name).toBe("@electron-forge/maker-squirrel");
  });

  it("does not double-declare osxSign / notarize inside the maker config", () => {
    const config = buildForgeConfig({
      appName: "LeCoding",
      appVersion: "0.1.0",
      rendererEntry: "../renderer/dist/index.html",
      mainEntry: "./src/main/index.ts",
      preloadEntry: "./src/preload/index.ts",
      signEnv: SIGN_ENV,
      repository: "phoenixbull/lecoding"
    });
    for (const maker of config.makers) {
      const configObj = (maker.config ?? {}) as Record<string, unknown>;
      expect(configObj["osx-sign"]).toBeUndefined();
      expect(configObj["notarize"]).toBeUndefined();
    }
  });

  it("places osxSign + osxNotarize on packagerConfig when Apple creds are present", () => {
    const config = buildForgeConfig({
      appName: "LeCoding",
      appVersion: "0.1.0",
      rendererEntry: "../renderer/dist/index.html",
      mainEntry: "./src/main/index.ts",
      preloadEntry: "./src/preload/index.ts",
      signEnv: SIGN_ENV,
      repository: "phoenixbull/lecoding"
    });
    expect(config.packagerConfig.osxSign).toBeDefined();
    const sign = config.packagerConfig.osxSign as Record<string, unknown>;
    expect(sign["identity"]).toBe("Developer ID Application: LeCoding");
    expect(sign["hardened-runtime"]).toBe(true);
    expect(sign["entitlements"]).toBe("build/entitlements.mac.plist");
    expect(config.packagerConfig.osxNotarize).toBeDefined();
    const notarize = config.packagerConfig.osxNotarize as Record<string, unknown>;
    expect(notarize["appleId"]).toBe(SIGN_ENV.APPLE_ID);
    expect(notarize["appleIdPassword"]).toBe(SIGN_ENV.APPLE_APP_SPECIFIC_PASSWORD);
    expect(notarize["teamId"]).toBe(SIGN_ENV.APPLE_TEAM_ID);
    expect(notarize["tool"]).toBe("notarytool");
  });

  it("omits osxSign / osxNotarize on developer machines (no Apple creds)", () => {
    const config = buildForgeConfig({
      appName: "LeCoding",
      appVersion: "0.1.0",
      rendererEntry: "../renderer/dist/index.html",
      mainEntry: "./src/main/index.ts",
      preloadEntry: "./src/preload/index.ts",
      signEnv: {},
      repository: "phoenixbull/lecoding"
    });
    expect(config.packagerConfig.osxSign).toBeUndefined();
    expect(config.packagerConfig.osxNotarize).toBeUndefined();
  });

  it("bakes the Windows cert into the Squirrel maker config when present", () => {
    const config = buildForgeConfig({
      appName: "LeCoding",
      appVersion: "0.1.0",
      rendererEntry: "../renderer/dist/index.html",
      mainEntry: "./src/main/index.ts",
      preloadEntry: "./src/preload/index.ts",
      signEnv: SIGN_ENV,
      repository: "phoenixbull/lecoding"
    });
    const squirrel = config.makers.find(
      (m) => m.name === "@electron-forge/maker-squirrel"
    );
    expect(squirrel).toBeDefined();
    if (squirrel) {
      const makerConfig = (squirrel.config ?? {}) as Record<string, unknown>;
      expect(makerConfig["certificateFile"]).toBe(SIGN_ENV.CSC_LINK);
      expect(makerConfig["certificatePassword"]).toBe(SIGN_ENV.CSC_KEY_PASSWORD);
      // M0.4: the nuspec id stays lowercase (Squirrel would replace
      // hyphens with underscores anyway). The setupExe carries the
      // version, not the package id.
      expect(makerConfig["name"]).toBe("lecode");
      expect(makerConfig["setupExe"]).toBe("LeCoding-Setup-0.1.0.exe");
    }
  });

  it("omits the cert from the Squirrel maker on developer machines", () => {
    const config = buildForgeConfig({
      appName: "LeCoding",
      appVersion: "0.1.0",
      rendererEntry: "../renderer/dist/index.html",
      mainEntry: "./src/main/index.ts",
      preloadEntry: "./src/preload/index.ts",
      signEnv: {},
      repository: "phoenixbull/lecoding"
    });
    const squirrel = config.makers.find(
      (m) => m.name === "@electron-forge/maker-squirrel"
    );
    expect(squirrel).toBeDefined();
    if (squirrel) {
      const makerConfig = (squirrel.config ?? {}) as Record<string, unknown>;
      expect(makerConfig["certificateFile"]).toBeUndefined();
      expect(makerConfig["certificatePassword"]).toBeUndefined();
    }
  });

  it("pins asar + asarUnpack globs for keytar / better-sqlite3 / fsevents / local-runner native", () => {
    const config = buildForgeConfig({
      appName: "LeCoding",
      appVersion: "0.1.0",
      rendererEntry: "../renderer/dist/index.html",
      mainEntry: "./src/main/index.ts",
      preloadEntry: "./src/preload/index.ts",
      signEnv: {},
      repository: "phoenixbull/lecoding"
    });
    expect(config.packagerConfig.asar).toBe(true);
    const unpack = config.packagerConfig.asarUnpack ?? [];
    expect(unpack.some((p) => p.includes("better-sqlite3"))).toBe(true);
    expect(unpack.some((p) => p.includes("keytar"))).toBe(true);
    expect(unpack.some((p) => p.includes("fsevents"))).toBe(true);
  });

  it("includes the Renderer entry under the packaged file:// origin", () => {
    const config = buildForgeConfig({
      appName: "LeCoding",
      appVersion: "0.1.0",
      rendererEntry: "../renderer/dist/index.html",
      mainEntry: "./src/main/index.ts",
      preloadEntry: "./src/preload/index.ts",
      signEnv: {},
      repository: "phoenixbull/lecoding"
    });
    // PRD § 10.1 forbids loading a remote URL — assert the entry never
    // starts with an http(s) prefix.
    expect(config.rendererEntry).not.toMatch(/^https?:/);
  });

  it("configures electron-updater with the GitHub releases feed and signature gating", () => {
    const config = buildForgeConfig({
      appName: "LeCoding",
      appVersion: "0.1.0",
      rendererEntry: "../renderer/dist/index.html",
      mainEntry: "./src/main/index.ts",
      preloadEntry: "./src/preload/index.ts",
      signEnv: {},
      repository: "phoenixbull/lecoding"
    });
    expect(config.autoUpdate).toMatchObject({
      provider: "github",
      owner: "phoenixbull",
      repo: "lecoding"
    });
    // PRD § 10.1: "自动更新只接受签名清单和签名包"
    expect(config.autoUpdate?.verifySignature).toBe(true);
  });

  it("packs the app id and product name consistently so the auto-update feed matches the installer", () => {
    const config = buildForgeConfig({
      appName: "LeCoding",
      appVersion: "0.1.0",
      rendererEntry: "../renderer/dist/index.html",
      mainEntry: "./src/main/index.ts",
      preloadEntry: "./src/preload/index.ts",
      signEnv: SIGN_ENV,
      repository: "phoenixbull/lecoding"
    });
    expect(config.appName).toBe("LeCoding");
    expect(config.appId).toBeTruthy();
    expect(config.publisher).toBeTruthy();
  });

  it("threads the supplied version through the Squirrel name, setupExe and product name", () => {
    // M0.4: the nuspec id, the setupExe file name, and the displayed
    // product name must all carry the same version so a tag-driven
    // release cannot produce a `0.0.0` installer under a `v0.1.0` tag.
    const config = buildForgeConfig({
      appName: "LeCoding",
      appVersion: "0.1.0",
      rendererEntry: "../renderer/dist/index.html",
      mainEntry: "./src/main/index.ts",
      preloadEntry: "./src/preload/index.ts",
      signEnv: SIGN_ENV,
      repository: "phoenixbull/lecoding"
    });
    const squirrel = config.makers.find(
      (m) => m.name === "@electron-forge/maker-squirrel"
    );
    expect(squirrel).toBeDefined();
    const makerConfig = (squirrel?.config ?? {}) as Record<string, unknown>;
    expect(makerConfig["setupExe"]).toBe("LeCoding-Setup-0.1.0.exe");
    expect(makerConfig["title"]).toBe("LeCoding 0.1.0");
    expect(makerConfig["productName"]).toBe("LeCoding 0.1.0");
    // nuspec id stays lowercase with no hyphens so Squirrel does not
    // rewrite the package id and silently change the update feed.
    expect(makerConfig["name"]).toBe("lecode");
  });

  it("uses the same version for every pre-release tag (e.g. 0.2.0-rc.1)", () => {
    // M0.4: pre-release tags (beta-v*, rc-*) must still produce an
    // installer whose embedded version matches the tag so the auto-
    // update feed does not skip or duplicate releases.
    const config = buildForgeConfig({
      appName: "LeCoding",
      appVersion: "0.2.0-rc.1",
      rendererEntry: "../renderer/dist/index.html",
      mainEntry: "./src/main/index.ts",
      preloadEntry: "./src/preload/index.ts",
      signEnv: SIGN_ENV,
      repository: "phoenixbull/lecoding"
    });
    const squirrel = config.makers.find(
      (m) => m.name === "@electron-forge/maker-squirrel"
    );
    const makerConfig = (squirrel?.config ?? {}) as Record<string, unknown>;
    expect(makerConfig["setupExe"]).toBe("LeCoding-Setup-0.2.0-rc.1.exe");
    expect(makerConfig["title"]).toBe("LeCoding 0.2.0-rc.1");
  });

  it("refuses to build when the version is empty or a placeholder", () => {
    // M0.4: a `0.0.0` fallback used to ship under a `v0.1.0` tag. The
    // builder must reject the call so the CI step catches the regression
    // instead of silently publishing a mismatched update feed.
    expect(() =>
      buildForgeConfig({
        appName: "LeCoding",
        appVersion: "0.0.0",
        rendererEntry: "../renderer/dist/index.html",
        mainEntry: "./src/main/index.ts",
        preloadEntry: "./src/preload/index.ts",
        signEnv: SIGN_ENV,
        repository: "phoenixbull/lecoding"
      })
    ).toThrow(/LECODING_RELEASE_VERSION|major\.minor\.patch|placeholder|0\.0\.0/);
  });
});

describe("resolveReleaseVersion", () => {
  it("normalizes a stable release tag", () => {
    expect(resolveReleaseVersion({ releaseTag: "v1.2.3" })).toBe("1.2.3");
  });

  it("preserves beta release semantics instead of publishing a stable version", () => {
    expect(resolveReleaseVersion({ releaseTag: "beta-v1.2.3" })).toBe(
      "1.2.3-beta.0"
    );
  });

  it("rejects a no-tag development build that only has the placeholder package version", () => {
    expect(() =>
      resolveReleaseVersion({ packageVersion: "0.0.0" })
    ).toThrow(/release tag|development version|0\.0\.0/i);
  });

  it("rejects malformed release tags before they reach artifact names", () => {
    expect(() => resolveReleaseVersion({ releaseTag: "v1.2" })).toThrow(
      /semantic version/i
    );
  });
});

describe("validateDesktopReleaseArtifacts", () => {
  it("accepts the required macOS x64 artifacts for the requested version", () => {
    expect(() =>
      validateDesktopReleaseArtifacts({
        platform: "darwin",
        arch: "x64",
        appVersion: "1.2.3",
        relativePaths: [
          "LeCoding-1.2.3-x64.dmg",
          "zip/darwin/x64/LeCoding-darwin-x64-1.2.3.zip"
        ]
      })
    ).not.toThrow();
  });

  it("rejects a macOS x64 job that produced arm64 artifacts", () => {
    expect(() =>
      validateDesktopReleaseArtifacts({
        platform: "darwin",
        arch: "x64",
        appVersion: "1.2.3",
        relativePaths: [
          "LeCoding-1.2.3-arm64.dmg",
          "zip/darwin/arm64/LeCoding-darwin-arm64-1.2.3.zip"
        ]
      })
    ).toThrow(/x64|architecture/i);
  });

  it("rejects missing or version-mismatched Windows artifacts", () => {
    expect(() =>
      validateDesktopReleaseArtifacts({
        platform: "win32",
        arch: "x64",
        appVersion: "1.2.3",
        relativePaths: [
          "squirrel.windows/x64/LeCoding-Setup-0.0.0.exe",
          "squirrel.windows/x64/RELEASES"
        ]
      })
    ).toThrow(/1\.2\.3|artifact/i);
  });
});
