import { describe, expect, it } from "vitest";
import {
  findDuplicateAssetNames,
  validateReleaseAssets
} from "../src/build/release-assets.js";

const DARWIN_ARM64 = [
  "zip/darwin/arm64/LeCoding-darwin-arm64-1.2.3.zip",
  "dmg/arm64/LeCoding-1.2.3-arm64.dmg"
];

describe("findDuplicateAssetNames", () => {
  it("reports nothing when every file name is distinct", () => {
    expect(findDuplicateAssetNames(DARWIN_ARM64)).toEqual([]);
  });

  it("reports a name that appears more than once", () => {
    // Uploading two files called LeCoding.dmg silently keeps only the last one.
    expect(
      findDuplicateAssetNames([
        "zip/darwin/arm64/LeCoding.dmg",
        "dmg/x64/LeCoding.dmg",
        "dmg/arm64/other.dmg"
      ])
    ).toEqual(["LeCoding.dmg"]);
  });

  it("compares basenames, not full paths", () => {
    expect(findDuplicateAssetNames(["a/RELEASES", "b/RELEASES"])).toEqual([
      "RELEASES"
    ]);
  });
});

describe("validateReleaseAssets", () => {
  it("accepts a well-formed darwin arm64 job", () => {
    expect(() =>
      validateReleaseAssets({
        version: "1.2.3",
        platform: "darwin",
        arch: "arm64",
        assets: DARWIN_ARM64
      })
    ).not.toThrow();
  });

  it("accepts a Windows job whose update feed carries no version", () => {
    expect(() =>
      validateReleaseAssets({
        version: "1.2.3",
        platform: "win32",
        arch: "x64",
        assets: [
          "squirrel.windows/x64/LeCoding-Setup-1.2.3.exe",
          "squirrel.windows/x64/lecode-1.2.3-full.nupkg",
          "squirrel.windows/x64/RELEASES"
        ]
      })
    ).not.toThrow();
  });

  it("rejects an empty artefact list", () => {
    expect(() =>
      validateReleaseAssets({
        version: "1.2.3",
        platform: "darwin",
        arch: "arm64",
        assets: []
      })
    ).toThrow(/produced no artefacts/);
  });

  it("rejects artefacts that would overwrite each other", () => {
    expect(() =>
      validateReleaseAssets({
        version: "1.2.3",
        platform: "darwin",
        arch: "arm64",
        assets: [
          "zip/darwin/arm64/LeCoding-1.2.3.zip",
          "dmg/x64/LeCoding-1.2.3.zip"
        ]
      })
    ).toThrow(/would overwrite each other/);
  });

  it("rejects an artefact left over from a different version", () => {
    expect(() =>
      validateReleaseAssets({
        version: "1.2.3",
        platform: "darwin",
        arch: "arm64",
        assets: [
          "zip/darwin/arm64/LeCoding-darwin-arm64-1.2.3.zip",
          "dmg/arm64/LeCoding-9.9.9-arm64.dmg"
        ]
      })
    ).toThrow(/9\.9\.9/);
  });

  it("rejects an arm64 job carrying an x64-named artefact", () => {
    // This is the exact shape of the historical defect: the file says x64
    // while the Mach-O inside says arm64.
    expect(() =>
      validateReleaseAssets({
        version: "1.2.3",
        platform: "darwin",
        arch: "arm64",
        assets: [
          "zip/darwin/arm64/LeCoding-darwin-arm64-1.2.3.zip",
          "dmg/arm64/LeCoding-1.2.3-x64.dmg"
        ]
      })
    ).toThrow(/produced artefacts naming x64/);
  });

  it("rejects a macOS artefact that names neither architecture", () => {
    expect(() =>
      validateReleaseAssets({
        version: "1.2.3",
        platform: "darwin",
        arch: "arm64",
        assets: ["zip/darwin/arm64/LeCoding-1.2.3.zip"]
      })
    ).toThrow(/arm64 is missing/);
  });
});
