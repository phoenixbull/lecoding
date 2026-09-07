import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildSignedUpdatePackage,
  createAutoUpdater,
  hashArtifact,
  serializeUpdateManifest
} from "../src/build/auto-update.js";
import {
  createDesktopUpdater,
  loadUpdaterConfig,
  type DesktopUpdaterOptions,
  type UpdaterConfig
} from "../src/main/updater.js";

/**
 * M3.A2: the production update path.
 *
 * `installVerifiedUpdate` was already a fail-closed gate with tests, but
 * nothing in the app called it, so no update could ever be installed — or
 * rejected — in production. These tests exercise the wiring that stands
 * between discovery and that gate, and prove each rejection stops the install.
 */

const { publicKey, privateKey } = (() => {
  const pair = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  return { publicKey: pair.publicKey as string, privateKey: pair.privateKey as string };
})();

const ARTIFACT = new TextEncoder().encode("installer-bytes");
const ARTIFACT_URL = "https://example.test/releases/app-1.1.0.dmg";

function signedPackage(overrides: Partial<Parameters<typeof buildSignedUpdatePackage>[0]> = {}) {
  return buildSignedUpdatePackage({
    version: "1.1.0",
    platform: "win32",
    arch: "x64",
    artifactUrl: ARTIFACT_URL,
    artifact: ARTIFACT,
    privateKey,
    ...overrides
  });
}

/** Builds an updater over in-memory URLs, recording what reached the installer. */
function updater(inputs: {
  bytes: Record<string, Uint8Array>;
  publicKey?: string;
  currentVersion?: string;
  platform?: "darwin" | "win32";
  arch?: "arm64" | "x64";
  manifestUrl?: string;
  signatureUrl?: string;
}) {
  const installed: Uint8Array[] = [];
  const fetchBytes = vi.fn(async (url: string) => {
    const body = inputs.bytes[url];
    if (!body) {
      throw new Error(`404 ${url}`);
    }
    return body;
  });
  const up = createAutoUpdater({
    manifestUrl: inputs.manifestUrl ?? "https://example.test/manifest.json",
    signatureUrl: inputs.signatureUrl ?? "https://example.test/manifest.sig",
    publicKey: inputs.publicKey ?? publicKey,
    currentVersion: inputs.currentVersion ?? "1.0.0",
    platform: inputs.platform ?? "win32",
    arch: inputs.arch ?? "x64",
    fetchBytes,
    install: async (artifact) => {
      installed.push(artifact);
    }
  });
  return { up, installed, fetchBytes };
}

function urlMap(pkg: ReturnType<typeof signedPackage>) {
  return {
    "https://example.test/manifest.json": pkg.bytes,
    "https://example.test/manifest.sig": new TextEncoder().encode(pkg.signature),
    [ARTIFACT_URL]: ARTIFACT
  };
}

describe("signed update manifest production", () => {
  it("hashes the artifact and signs the exact manifest bytes", () => {
    const pkg = signedPackage();
    expect(pkg.manifest.sha256).toBe(hashArtifact(ARTIFACT));
    // The signature must cover the same bytes a verifier will read.
    expect(Buffer.from(pkg.bytes).toString("utf8")).toContain("1.1.0");
  });

  it("serializes deterministically so a rebuilt manifest verifies", () => {
    const manifest = signedPackage().manifest;
    const first = Buffer.from(serializeUpdateManifest(manifest)).toString("utf8");
    const second = Buffer.from(serializeUpdateManifest(manifest)).toString("utf8");
    expect(first).toBe(second);
    // Fixed key order, no pretty printing: any drift breaks every signature.
    expect(first).toBe(
      JSON.stringify({
        version: manifest.version,
        platform: manifest.platform,
        arch: manifest.arch,
        artifactUrl: manifest.artifactUrl,
        sha256: manifest.sha256
      })
    );
  });

  it("refuses a non-HTTPS artifact URL at build time", () => {
    expect(() => signedPackage({ artifactUrl: "http://example.test/app.dmg" })).toThrow(
      /HTTPS/
    );
  });
});

describe("auto updater production wiring", () => {
  it("installs a correctly signed, newer, correctly targeted artifact", async () => {
    const pkg = signedPackage();
    const { up, installed } = updater({ bytes: urlMap(pkg) });

    const outcome = await up.checkAndInstall();

    expect(outcome).toEqual({ installed: true, manifest: pkg.manifest });
    expect(installed).toEqual([ARTIFACT]);
  });

  it("does not install when the signature is wrong", async () => {
    const { publicKey: otherPublic } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const pkg = signedPackage();
    const { up, installed } = updater({ bytes: urlMap(pkg), publicKey: otherPublic });

    const outcome = await up.checkAndInstall();

    expect(outcome.installed).toBe(false);
    expect(outcome).toMatchObject({ reason: expect.stringMatching(/signature/i) });
    expect(installed).toEqual([]);
  });

  it("does not install when the artifact was tampered with", async () => {
    const pkg = signedPackage();
    const bytes = { ...urlMap(pkg), [ARTIFACT_URL]: new TextEncoder().encode("evil") };
    const { up, installed } = updater({ bytes });

    const outcome = await up.checkAndInstall();

    // The digest is inside the signed manifest, so swapped bytes are caught.
    expect(outcome).toMatchObject({ reason: expect.stringMatching(/SHA-256/i) });
    expect(installed).toEqual([]);
  });

  it("does not install an artifact built for another platform", async () => {
    const pkg = signedPackage({ platform: "darwin", arch: "arm64" });
    const { up, installed } = updater({ bytes: urlMap(pkg) });

    const outcome = await up.checkAndInstall();

    expect(outcome).toMatchObject({ reason: expect.stringMatching(/platform/i) });
    expect(installed).toEqual([]);
  });

  it("does not install a version that is not newer", async () => {
    const pkg = signedPackage({ version: "1.0.0" });
    const { up, installed } = updater({ bytes: urlMap(pkg) });

    const outcome = await up.checkAndInstall();

    expect(outcome).toMatchObject({ reason: expect.stringMatching(/newer/i) });
    expect(installed).toEqual([]);
  });

  it("does not install when a download fails", async () => {
    const pkg = signedPackage();
    // Artifact missing from the map: the fetch throws.
    const { up, installed } = updater({
      bytes: {
        "https://example.test/manifest.json": pkg.bytes,
        "https://example.test/manifest.sig": new TextEncoder().encode(pkg.signature)
      }
    });

    const outcome = await up.checkAndInstall();

    expect(outcome).toMatchObject({ reason: expect.stringMatching(/download failed/i) });
    expect(installed).toEqual([]);
  });

  it("refuses a non-HTTPS manifest URL before fetching anything", async () => {
    const pkg = signedPackage();
    const { up, installed, fetchBytes } = updater({
      bytes: urlMap(pkg),
      manifestUrl: "http://example.test/manifest.json"
    });

    const outcome = await up.checkAndInstall();

    expect(outcome).toMatchObject({ reason: expect.stringMatching(/HTTPS/) });
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(installed).toEqual([]);
  });

describe("desktop updater configuration", () => {
  /** No network: every outcome is decided before or around any fetch. */
  function desktopUpdater(config: UpdaterConfig, overrides: Partial<DesktopUpdaterOptions> = {}) {
    const runs: Array<{ filePath: string }> = [];
    const fetchBytes = vi.fn(async () => new Uint8Array(0));
    const up = createDesktopUpdater({
      config,
      currentVersion: "1.0.0",
      platform: "win32",
      arch: "x64",
      stagePath: "/tmp/stage",
      fetchBytes,
      runInstaller: async (input) => {
        runs.push(input);
      },
      ...overrides
    });
    return { up, fetchBytes, runs };
  }

  it("disables updating when no public key is pinned", async () => {
    const { up, fetchBytes, runs } = desktopUpdater({});

    expect(up.enabled()).toBe(false);
    const outcome = await up.checkAndInstall();

    // The dangerous fallback is trusting the feed when unconfigured; a disabled
    // updater is the only safe answer.
    expect(outcome.installed).toBe(false);
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(runs).toEqual([]);
  });

  it("disables updating on a platform the manifest cannot target", async () => {
    const { up, fetchBytes } = desktopUpdater({ publicKey }, {});
    // linux is not a targetable platform in the manifest contract.
    const linuxOnly = createDesktopUpdater({
      config: { publicKey, manifestUrl: "https://x.test/m.json" },
      currentVersion: "1.0.0",
      platform: "linux",
      arch: "x64",
      stagePath: "/tmp/stage",
      fetchBytes,
      runInstaller: async () => undefined
    });

    expect(linuxOnly.enabled()).toBe(false);
    await linuxOnly.checkAndInstall();
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(up.enabled()).toBe(false);
  });

  it("reads the pinned key and URLs from the environment", () => {
    const config = loadUpdaterConfig({
      LECODING_UPDATE_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----",
      LECODING_UPDATE_MANIFEST_URL: "https://x.test/m.json",
      LECODING_UPDATE_SIGNATURE_URL: "https://x.test/m.sig",
      LECODING_UPDATE_CHANNEL: "beta"
    });

    expect(config.publicKey).toBe("-----BEGIN PUBLIC KEY-----");
    expect(config.manifestUrl).toBe("https://x.test/m.json");
    expect(config.channel).toBe("beta");
  });

  it("ignores an unrecognised channel rather than guessing", () => {
    const config = loadUpdaterConfig({ LECODING_UPDATE_CHANNEL: "nightly" });
    expect(config.channel).toBeUndefined();
  });

  it("refuses to guess a signature URL from a manifest URL alone", () => {
    // A derived URL for an unrelated signature would let the wrong key verify.
    const config = loadUpdaterConfig({
      LECODING_UPDATE_PUBLIC_KEY: "k",
      LECODING_UPDATE_MANIFEST_URL: "https://x.test/m.json"
    });
    const up = createDesktopUpdater({
      config,
      currentVersion: "1.0.0",
      platform: "win32",
      arch: "x64",
      stagePath: "/tmp/stage",
      fetchBytes: async () => new Uint8Array(0),
      runInstaller: async () => undefined
    });

    expect(up.enabled()).toBe(false);
  });

  it("never runs the installer for a rejection", async () => {
    const { publicKey: other } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const pkg = signedPackage();
    const { up, runs } = desktopUpdater(
      {
        publicKey: other,
        manifestUrl: "https://example.test/manifest.json",
        signatureUrl: "https://example.test/manifest.sig"
      },
      {
        fetchBytes: async (url: string) => {
          if (url === ARTIFACT_URL) return ARTIFACT;
          if (url.endsWith(".sig")) return new TextEncoder().encode(pkg.signature);
          return pkg.bytes;
        }
      }
    );

    const outcome = await up.checkAndInstall();

    expect(outcome.installed).toBe(false);
    expect(runs).toEqual([]);
  });
});
});
