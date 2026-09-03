/**
 * Auto-update feed tests.
 *
 * The updater must:
 * - read the GitHub feed from a single, versioned URL
 * - verify the manifest signature and individual artifact signatures
 * - never allow downgrade unless explicitly permitted by the channel
 * - never silently accept an unsigned payload
 * - emit a deterministic version comparison so dev builds can roll forward
 */

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildAutoUpdateFeed,
  compareVersions,
  installVerifiedUpdate,
  isDowngradeAllowed,
  parseVersion,
  type AutoUpdateChannel
} from "../src/build/auto-update.js";

describe("installVerifiedUpdate", () => {
  it("installs only an artifact covered by a valid signed manifest", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const artifact = Buffer.from("signed desktop package");
    const manifest = Buffer.from(
      JSON.stringify({
        version: "1.2.0",
        platform: "darwin",
        arch: "arm64",
        artifactUrl: "https://downloads.example/LeCoding-1.2.0-arm64.zip",
        sha256: createHash("sha256").update(artifact).digest("hex")
      })
    );
    const signature = sign(null, manifest, privateKey).toString("base64");
    const install = vi.fn(async () => undefined);

    await installVerifiedUpdate({
      manifest,
      signature,
      artifact,
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      currentVersion: "1.1.0",
      platform: "darwin",
      arch: "arm64",
      install
    });

    expect(install).toHaveBeenCalledWith(artifact);
  });

  it("rejects an invalid signature before the installer receives any bytes", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const artifact = Buffer.from("untrusted package");
    const manifest = Buffer.from(
      JSON.stringify({
        version: "1.2.0",
        platform: "win32",
        arch: "x64",
        artifactUrl: "https://downloads.example/LeCoding-Setup-1.2.0.exe",
        sha256: createHash("sha256").update(artifact).digest("hex")
      })
    );
    const install = vi.fn(async () => undefined);

    await expect(
      installVerifiedUpdate({
        manifest,
        signature: Buffer.from("forged").toString("base64"),
        artifact,
        publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
        currentVersion: "1.1.0",
        platform: "win32",
        arch: "x64",
        install
      })
    ).rejects.toThrow(/signature/i);
    expect(install).not.toHaveBeenCalled();
  });
});

describe("parseVersion", () => {
  it("splits semver into numeric triple + pre-release", () => {
    expect(parseVersion("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      pre: undefined
    });
  });

  it("captures pre-release tags without losing them", () => {
    expect(parseVersion("1.2.3-rc.4")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      pre: "rc.4"
    });
  });

  it("throws on malformed strings", () => {
    expect(() => parseVersion("v1.2.3")).toThrow(/semver/);
    expect(() => parseVersion("1.2")).toThrow(/semver/);
    expect(() => parseVersion("1.2.3.4")).toThrow(/semver/);
  });
});

describe("compareVersions", () => {
  it("orders 1.2.4 above 1.2.3", () => {
    expect(compareVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
  });

  it("orders 1.2.10 above 1.2.9 (numeric patch, not lexicographic)", () => {
    expect(compareVersions("1.2.10", "1.2.9")).toBeGreaterThan(0);
  });

  it("marks a release ahead of the same triple with a pre-release tag", () => {
    expect(compareVersions("1.2.3", "1.2.3-rc.1")).toBeGreaterThan(0);
  });

  it("orders pre-release tags by suffix length then alphabetically", () => {
    expect(compareVersions("1.2.3-alpha.2", "1.2.3-alpha.1")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3-beta", "1.2.3-alpha")).toBeGreaterThan(0);
  });

  it("compares dot-separated numeric identifiers numerically, not as text", () => {
    // A lexicographic comparison would put rc.10 below rc.2, making the
    // updater refuse a genuinely newer release candidate.
    expect(compareVersions("1.2.3-rc.10", "1.2.3-rc.2")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3-rc.2", "1.2.3-rc.10")).toBeLessThan(0);
  });

  it("compares single alphanumeric identifiers in ASCII order (SemVer 2.0.0 § 11.4.2)", () => {
    // `rc10` is ONE alphanumeric identifier, not `rc` + `10`, so ASCII order
    // applies and `rc10` legitimately precedes `rc2`.
    expect(compareVersions("1.2.3-rc10", "1.2.3-rc2")).toBeLessThan(0);
  });

  it("ranks a longer pre-release field set above its prefix (SemVer 2.0.0 § 11.4)", () => {
    expect(compareVersions("1.2.3-alpha.1", "1.2.3-alpha")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3-alpha", "1.2.3-alpha.1")).toBeLessThan(0);
  });

  it("ranks numeric identifiers below alphanumeric ones (SemVer 2.0.0 § 11.4.3)", () => {
    expect(compareVersions("1.2.3-alpha.beta", "1.2.3-alpha.1")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3-alpha.1", "1.2.3-alpha.beta")).toBeLessThan(0);
  });

  it("reports identical versions as equal, including their pre-release tags", () => {
    expect(compareVersions("1.2.3-rc.1", "1.2.3-rc.1")).toBe(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });
});

describe("isDowngradeAllowed", () => {
  it("never allows downgrade on the stable channel", () => {
    expect(
      isDowngradeAllowed(
        { channel: "stable", allowDowngrade: true },
        "1.0.0",
        "1.1.0"
      )
    ).toBe(false);
  });

  it("allows downgrade on the beta channel when the manifest opts in", () => {
    // current=1.1.0, candidate=1.0.0 — candidate is older, so this IS a downgrade.
    expect(
      isDowngradeAllowed(
        { channel: "beta", allowDowngrade: true },
        "1.1.0",
        "1.0.0"
      )
    ).toBe(true);
  });

  it("rejects downgrade on the beta channel when the manifest opts out", () => {
    expect(
      isDowngradeAllowed(
        { channel: "beta", allowDowngrade: false },
        "1.1.0",
        "1.0.0"
      )
    ).toBe(false);
  });

  it("compares versions correctly when the new build is older (stable always refuses)", () => {
    expect(
      isDowngradeAllowed(
        { channel: "stable", allowDowngrade: true },
        "1.2.0",
        "1.1.0"
      )
    ).toBe(false);
  });
});

describe("buildAutoUpdateFeed", () => {
  it("returns the GitHub releases feed for the configured repo", () => {
    const feed = buildAutoUpdateFeed({
      repository: "phoenixbull/lecoding",
      channel: "stable" as AutoUpdateChannel
    });
    expect(feed.url).toBe("https://api.github.com/repos/phoenixbull/lecoding/releases");
  });

  it("pins the channel via a release tag prefix", () => {
    const stable = buildAutoUpdateFeed({
      repository: "phoenixbull/lecoding",
      channel: "stable" as AutoUpdateChannel
    });
    const beta = buildAutoUpdateFeed({
      repository: "phoenixbull/lecoding",
      channel: "beta" as AutoUpdateChannel
    });
    expect(stable.tagPrefix).toBe("v");
    expect(beta.tagPrefix).toBe("beta-v");
  });

  it("declares the mandatory manifest and artifact signature policy", () => {
    const feed = buildAutoUpdateFeed({
      repository: "phoenixbull/lecoding",
      channel: "stable" as AutoUpdateChannel
    });
    expect(feed.signaturePolicy).toBe(
      "ed25519-manifest-sha256-artifact"
    );
  });

  it("rejects unsupported channel strings so misconfiguration is loud", () => {
    expect(() =>
      buildAutoUpdateFeed({
        repository: "phoenixbull/lecoding",
        channel: "sneaky" as AutoUpdateChannel
      })
    ).toThrow(/channel/);
  });
});
