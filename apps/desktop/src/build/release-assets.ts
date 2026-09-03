/** Release asset names and matrix dimensions checked before GitHub publication. */
export interface ValidateReleaseAssetsInput {
  version: string;
  platform: "darwin" | "win32";
  arch: "x64" | "arm64";
  /** Artefact paths, POSIX-separated, as produced under `out/make`. */
  assets: string[];
}

/**
 * Files whose name is fixed by the update format and therefore carries no
 * version. Squirrel's `RELEASES` feed is the only one: the package it points
 * at is versioned, the feed itself is a stable pointer.
 */
const VERSION_EXEMPT_FILE_NAMES = new Set(["RELEASES"]);

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * Finds file names that would collide when uploaded.
 *
 * GitHub release assets are addressed by name, so two jobs uploading
 * `LeCoding.dmg` silently overwrite each other and the release ends up with
 * one architecture pretending to be both.
 */
export function findDuplicateAssetNames(assets: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const asset of assets) {
    const name = baseName(asset);
    if (seen.has(name)) {
      duplicates.add(name);
    }
    seen.add(name);
  }
  return [...duplicates].sort();
}

/**
 * Validates one matrix job's artefacts before anything is published.
 *
 * Three rules, each fail-closed:
 *   - No two artefacts may share a file name (silent overwrite).
 *   - Every artefact except the update feed must carry the release version, so
 *     a stale file from an earlier build cannot ride along.
 *   - Every macOS artefact must name its architecture and must not name the
 *     other one, which is what makes the two macOS installers distinguishable.
 */
export function validateReleaseAssets(input: ValidateReleaseAssetsInput): void {
  const { version, platform, arch, assets } = input;

  if (assets.length === 0) {
    throw new Error("release assets: the make directory produced no artefacts");
  }

  const duplicates = findDuplicateAssetNames(assets);
  if (duplicates.length > 0) {
    throw new Error(
      `release assets: these file names would overwrite each other on upload: ${duplicates.join(", ")}`
    );
  }

  const missingVersion = assets.filter(
    (asset) =>
      !VERSION_EXEMPT_FILE_NAMES.has(baseName(asset)) &&
      !baseName(asset).includes(version)
  );
  if (missingVersion.length > 0) {
    throw new Error(
      `release assets: ${version} is missing from ${missingVersion.join(", ")}; ` +
        "a stale artefact from another build would be published"
    );
  }

  if (platform !== "darwin") {
    return;
  }
  const otherArch = arch === "arm64" ? "x64" : "arm64";
  const wrongArch = assets.filter((asset) => baseName(asset).includes(otherArch));
  if (wrongArch.length > 0) {
    throw new Error(
      `release assets: a ${arch} job produced artefacts naming ${otherArch}: ${wrongArch.join(", ")}`
    );
  }
  const missingArch = assets.filter(
    (asset) =>
      !VERSION_EXEMPT_FILE_NAMES.has(baseName(asset)) &&
      !baseName(asset).includes(arch)
  );
  if (missingArch.length > 0) {
    throw new Error(
      `release assets: ${arch} is missing from ${missingArch.join(", ")}; ` +
        "the two macOS installers would be indistinguishable"
    );
  }
}
