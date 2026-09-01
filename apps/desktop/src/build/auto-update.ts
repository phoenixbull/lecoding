/**
 * Auto-update feed builder.
 *
 * PRD § 10.1: "自动更新只接受签名清单和签名包". The updater must refuse
 * unsigned manifests and unsigned artifacts. The factory here builds the
 * feed configuration that electron-updater consumes; it never trusts the
 * server's word that an artifact is safe — signatures are checked
 * against a pinned public key baked into the desktop main process.
 *
 * Version comparison follows SemVer 2.0.0 with deterministic pre-release
 * ordering so dev builds can be promoted to beta without manual sorting.
 */

export type AutoUpdateChannel = "stable" | "beta";

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pre?: string;
}

export interface AutoUpdateFeed {
  provider: "github";
  url: string;
  tagPrefix: string;
  verifyManifestSignature: true;
  verifyArtifactSignatures: true;
}

export interface FeedInputs {
  repository: string;
  channel: AutoUpdateChannel;
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
  if (av.pre === bv.pre) {
    return 0;
  }
  return av.pre < bv.pre ? -1 : 1;
}

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
    verifyManifestSignature: true,
    verifyArtifactSignatures: true
  };
}