/**
 * Auto-update feed builder.
 *
 * PRD § 10.1: "自动更新只接受签名清单和签名包". Feed discovery metadata is
 * deliberately separate from `installVerifiedUpdate`, the mandatory gate that
 * verifies an exact manifest signature and artifact digest before any installer
 * callback can observe executable bytes.
 *
 * Version comparison follows SemVer 2.0.0 with deterministic pre-release
 * ordering so dev builds can be promoted to beta without manual sorting.
 */

import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature
} from "node:crypto";

/** Release stream whose tag prefix controls discovery and downgrade policy. */
export type AutoUpdateChannel = "stable" | "beta";

/** Parsed SemVer components used for deterministic update precedence. */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pre?: string;
}

/** GitHub discovery metadata paired with the mandatory cryptographic policy. */
export interface AutoUpdateFeed {
  provider: "github";
  url: string;
  tagPrefix: string;
  signaturePolicy: "ed25519-manifest-sha256-artifact";
}

/** Repository and channel selected by the release/update composition root. */
export interface FeedInputs {
  repository: string;
  channel: AutoUpdateChannel;
}

/** Exact signed metadata that binds one release to one platform artifact. */
export interface SignedUpdateManifest {
  version: string;
  platform: "darwin" | "win32";
  arch: "arm64" | "x64";
  artifactUrl: string;
  sha256: string;
}

/** Inputs to the fail-closed boundary immediately preceding installation. */
export interface InstallVerifiedUpdateInputs {
  manifest: Uint8Array;
  signature: string;
  artifact: Uint8Array;
  /** Ed25519 SPKI public key pinned by the desktop composition root. */
  publicKey: string;
  currentVersion: string;
  platform: SignedUpdateManifest["platform"];
  arch: SignedUpdateManifest["arch"];
  /** Receives bytes only after every authenticity and targeting check passes. */
  install(artifact: Uint8Array): Promise<void>;
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

export function parseVersion(value: string): ParsedVersion {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) {
    throw new Error(`parseVersion: "${value}" is not strict semver`);
  }
  const [, major, minor, patch, pre] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    ...(pre !== undefined ? { pre } : {})
  };
}

/** Compare two SemVer strings. Returns positive if `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  if (av.major !== bv.major) {
    return av.major - bv.major;
  }
  if (av.minor !== bv.minor) {
    return av.minor - bv.minor;
  }
  if (av.patch !== bv.patch) {
    return av.patch - bv.patch;
  }
  // Per SemVer: a version WITHOUT a pre-release tag has higher precedence
  // than the same triple WITH a pre-release tag (1.0.0-alpha < 1.0.0).
  if (av.pre === undefined && bv.pre === undefined) {
    return 0;
  }
  if (av.pre === undefined) {
    return 1;
  }
  if (bv.pre === undefined) {
    return -1;
  }
  return comparePreRelease(av.pre, bv.pre);
}

/**
 * Orders two dot-separated pre-release identifiers per SemVer 2.0.0 § 11.4.
 *
 * A plain string comparison is wrong in two ways that matter for updates:
 * `rc10` would sort below `rc2`, and `alpha.10` below `alpha.9` — both would
 * make the updater refuse a genuinely newer release candidate.
 */
function comparePreRelease(a: string, b: string): number {
  const aParts = a.split(".");
  const bParts = b.split(".");
  const length = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = aParts[index];
    const bPart = bParts[index];
    // § 11.4.2: a larger set of fields wins when every preceding field ties.
    if (aPart === undefined) {
      return -1;
    }
    if (bPart === undefined) {
      return 1;
    }
    if (aPart === bPart) {
      continue;
    }
    const aNumeric = isNumericIdentifier(aPart);
    const bNumeric = isNumericIdentifier(bPart);
    if (aNumeric && bNumeric) {
      return Number(aPart) - Number(bPart);
    }
    // § 11.4.3: numeric identifiers always rank below alphanumeric ones.
    if (aNumeric) {
      return -1;
    }
    if (bNumeric) {
      return 1;
    }
    return aPart < bPart ? -1 : 1;
  }
  return 0;
}

function isNumericIdentifier(value: string): boolean {
  return /^\d+$/u.test(value);
}

/** Channel policy controlling whether an older beta may be installed. */
export interface DowngradeInputs {
  channel: AutoUpdateChannel;
  allowDowngrade: boolean;
}

/**
 * Decide whether the updater is allowed to roll back to an older version.
 * The stable channel never downgrades; the beta channel honours the
 * manifest's `allowDowngrade` flag so testers can chase regressions.
 */
export function isDowngradeAllowed(
  inputs: DowngradeInputs,
  currentVersion: string,
  candidateVersion: string
): boolean {
  if (inputs.channel === "stable") {
    return false;
  }
  const delta = compareVersions(candidateVersion, currentVersion);
  // delta > 0 means the candidate is newer; downgrade is only the inverse.
  return delta < 0 && inputs.allowDowngrade;
}

export function buildAutoUpdateFeed(inputs: FeedInputs): AutoUpdateFeed {
  const { repository, channel } = inputs;
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`auto-update: invalid repository "${repository}"`);
  }
  if (channel !== "stable" && channel !== "beta") {
    throw new Error(`auto-update: unsupported channel "${channel}"`);
  }
  return {
    provider: "github",
    url: `https://api.github.com/repos/${owner}/${repo}/releases`,
    tagPrefix: channel === "stable" ? "v" : "beta-v",
    signaturePolicy: "ed25519-manifest-sha256-artifact"
  };
}

/**
 * Verifies and installs one update without exposing untrusted bytes to the
 * installer seam. Signature verification covers the exact manifest bytes;
 * the manifest's SHA-256 then binds those bytes to the downloaded artifact.
 */
export async function installVerifiedUpdate(
  inputs: InstallVerifiedUpdateInputs
): Promise<SignedUpdateManifest> {
  const manifestBytes = Buffer.from(inputs.manifest);
  let signature: Buffer;
  try {
    signature = Buffer.from(inputs.signature, "base64");
  } catch {
    throw new Error("Update manifest signature is not valid base64");
  }
  const verified = verifySignature(
    null,
    manifestBytes,
    createPublicKey(inputs.publicKey),
    signature
  );
  if (!verified) {
    throw new Error("Update manifest signature verification failed");
  }

  const manifest = parseSignedManifest(manifestBytes);
  if (manifest.platform !== inputs.platform || manifest.arch !== inputs.arch) {
    throw new Error("Update manifest does not target this platform architecture");
  }
  if (compareVersions(manifest.version, inputs.currentVersion) <= 0) {
    throw new Error("Update manifest version is not newer than the installed version");
  }
  const expectedDigest = Buffer.from(manifest.sha256, "hex");
  const actualDigest = createHash("sha256").update(inputs.artifact).digest();
  if (
    expectedDigest.length !== actualDigest.length ||
    !timingSafeEqual(expectedDigest, actualDigest)
  ) {
    throw new Error("Update artifact SHA-256 does not match the signed manifest");
  }

  await inputs.install(inputs.artifact);
  return manifest;
}

function parseSignedManifest(bytes: Buffer): SignedUpdateManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Signed update manifest is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Signed update manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  const { version, platform, arch, artifactUrl, sha256 } = record;
  if (typeof version !== "string") {
    throw new Error("Signed update manifest version is missing");
  }
  parseVersion(version);
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("Signed update manifest platform is invalid");
  }
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error("Signed update manifest architecture is invalid");
  }
  if (typeof artifactUrl !== "string" || new URL(artifactUrl).protocol !== "https:") {
    throw new Error("Signed update manifest artifact URL must use HTTPS");
  }
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error("Signed update manifest SHA-256 is invalid");
  }
  return { version, platform, arch, artifactUrl, sha256 };
}
