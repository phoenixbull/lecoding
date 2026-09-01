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

import { describe, expect, it } from "vitest";
import {
  buildAutoUpdateFeed,
  compareVersions,
  isDowngradeAllowed,
  parseVersion,
  type AutoUpdateChannel
} from "../src/build/auto-update.js";

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

  it("forces signature verification on every artifact", () => {
    const feed = buildAutoUpdateFeed({
      repository: "phoenixbull/lecoding",
      channel: "stable" as AutoUpdateChannel
    });
    expect(feed.verifyManifestSignature).toBe(true);
    expect(feed.verifyArtifactSignatures).toBe(true);
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