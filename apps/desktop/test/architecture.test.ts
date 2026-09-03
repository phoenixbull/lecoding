import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectBinaries,
  describeArchitectures,
  describeRunnerArch,
  isBinaryCandidate,
  isReleaseArch,
  readBinaryArch,
  readBinaryArchitectures,
  readFileArch,
  validateArchitectures,
  type ArchitectureEntry,
  type BinaryArch,
  type ReleaseArch
} from "../src/build/architecture.js";

/** Builds one entry from a set of release architectures. */
function entry(
  relativePath: string,
  architectures: ReadonlyArray<ReleaseArch>
): ArchitectureEntry {
  const set = new Set(architectures);
  return {
    relativePath,
    architectures: set,
    arch: architectures.length === 1 ? architectures[0]! : "unknown"
  };
}

/** Builds a minimal Mach-O image with the requested CPU type. */
function machO(cputype: number, options: { bigEndian?: boolean } = {}): Uint8Array {
  const bytes = new Uint8Array(32);
  const bigEndian = options.bigEndian ?? true;
  const write32 = (offset: number, value: number) => {
    if (bigEndian) {
      bytes[offset] = (value >>> 24) & 0xff;
      bytes[offset + 1] = (value >>> 16) & 0xff;
      bytes[offset + 2] = (value >>> 8) & 0xff;
      bytes[offset + 3] = value & 0xff;
    } else {
      bytes[offset] = value & 0xff;
      bytes[offset + 1] = (value >>> 8) & 0xff;
      bytes[offset + 2] = (value >>> 16) & 0xff;
      bytes[offset + 3] = (value >>> 24) & 0xff;
    }
  };
  // Writing 0xFEEDFACF in the header's own byte order is what a real Mach-O
  // does: big-endian produces FE ED FA CF, little-endian produces CF FA ED FE,
  // which the reader sees as the byte-swapped (CIGAM) magic.
  write32(0, 0xfeedfacf);
  write32(4, cputype);
  return bytes;
}

/**
 * Builds a universal Mach-O containing one or more slices.
 *
 * The entry size must match the reader's: fat_arch is 20 bytes, fat_arch_64
 * is 32. A mismatch here would make the fixture pass while the reader read
 * the wrong bytes.
 */
function fatMachO(cputypes: number[], is64 = false): Uint8Array {
  const entrySize = is64 ? 32 : 20;
  const bytes = new Uint8Array(8 + cputypes.length * entrySize);
  const write32BE = (offset: number, value: number) => {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
  };
  write32BE(0, is64 ? 0xcafebabf : 0xcafebabe);
  write32BE(4, cputypes.length);
  cputypes.forEach((cputype, index) => {
    write32BE(8 + index * entrySize, cputype);
  });
  return bytes;
}

/** Builds a minimal PE image with the requested machine type. */
function portableExecutable(machine: number): Uint8Array {
  const bytes = new Uint8Array(0x80);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  const peOffset = 0x60;
  bytes[0x3c] = peOffset;
  bytes[peOffset] = 0x50;
  bytes[peOffset + 1] = 0x45;
  bytes[peOffset + 2] = 0x00;
  bytes[peOffset + 3] = 0x00;
  bytes[peOffset + 4] = machine & 0xff;
  bytes[peOffset + 5] = (machine >>> 8) & 0xff;
  return bytes;
}

function elf(machine: number, littleEndian = true): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes[0] = 0x7f;
  bytes[1] = 0x45;
  bytes[2] = 0x4c;
  bytes[3] = 0x46;
  bytes[4] = 2;
  bytes[5] = littleEndian ? 1 : 2;
  if (littleEndian) {
    bytes[18] = machine & 0xff;
    bytes[19] = (machine >>> 8) & 0xff;
  } else {
    bytes[18] = (machine >>> 8) & 0xff;
    bytes[19] = machine & 0xff;
  }
  return bytes;
}

describe("readBinaryArch", () => {
  it("identifies arm64 and x64 Mach-O images", () => {
    expect(readBinaryArch(machO(0x0100000c))).toBe("arm64");
    expect(readBinaryArch(machO(0x01000007))).toBe("x64");
  });

  it("handles a byte-swapped (little-endian) Mach-O header", () => {
    expect(readBinaryArch(machO(0x0100000c, { bigEndian: false }))).toBe("arm64");
  });

  it("rejects 32-bit slices that the release matrix cannot publish", () => {
    expect(readBinaryArch(machO(7))).toBe("unknown");
    expect(readBinaryArch(machO(12))).toBe("unknown");
  });

  it("collects every slice of a universal binary", () => {
    // A universal binary runs natively on each architecture it contains, so
    // the set — not a single collapsed value — is what decides publishability.
    expect([...readBinaryArchitectures(fatMachO([0x0100000c, 0x01000007]))].sort()).toEqual(
      ["arm64", "x64"]
    );
    expect([...readBinaryArchitectures(fatMachO([0x0100000c]))]).toEqual(["arm64"]);
    expect(readBinaryArch(fatMachO([0x01000007, 0x01000007], true))).toBe("x64");
  });

  it("rejects a universal binary carrying an unsupported slice", () => {
    // A 32-bit leftover means the image cannot be published as-is rather than
    // shipping something that only sometimes runs.
    expect(readBinaryArchitectures(fatMachO([0x0100000c, 7])).size).toBe(0);
  });

  it("reads every slice of a real universal binary", () => {
    // macOS ships universal system tools (x86_64 + arm64). Guessing the
    // fat_arch_64 entry size used to misread every slice after the first.
    const universal = ["/bin/echo", "/bin/ls", "/usr/bin/true"].find((path) => {
      const bytes = new Uint8Array(readFileSync(path));
      return readBinaryArchitectures(bytes).size > 1;
    });
    if (!universal) {
      // Not a universal-capable host; the fixture cases above still cover it.
      return;
    }
    const architectures = readBinaryArchitectures(
      new Uint8Array(readFileSync(universal))
    );
    expect(architectures.has("arm64")).toBe(true);
    expect(architectures.has("x64")).toBe(true);
  });

  it("identifies PE machine types", () => {
    expect(readBinaryArch(portableExecutable(0xaa64))).toBe("arm64");
    expect(readBinaryArch(portableExecutable(0x8664))).toBe("x64");
    expect(readBinaryArch(portableExecutable(0x014c))).toBe("unknown");
  });

  it("identifies ELF machine types", () => {
    expect(readBinaryArch(elf(183))).toBe("arm64");
    expect(readBinaryArch(elf(62))).toBe("x64");
  });

  it("reports unknown for text, truncated, and empty inputs", () => {
    expect(readBinaryArch(new TextEncoder().encode("#!/bin/sh\necho hi"))).toBe(
      "unknown"
    );
    expect(readBinaryArch(new Uint8Array(2))).toBe("unknown");
    expect(readBinaryArch(new Uint8Array(0))).toBe("unknown");
  });

  it("parses the real Node binary running this test suite", () => {
    // Proves the parser works on a genuine image rather than only on fixtures.
    const runner = describeRunnerArch();
    const parsed = readFileArch(process.execPath);
    if (isReleaseArch(runner.nodeArch)) {
      expect(parsed.architectures.has(runner.nodeArch)).toBe(true);
    } else {
      // A non-publishable host arch still parses to something finite.
      expect(parsed.arch).toBeDefined();
    }
  });
});

describe("isBinaryCandidate", () => {
  it("accepts native extensions", () => {
    expect(isBinaryCandidate("app.asar.unpacked/node_modules/fsevents/fse.node")).toBe(
      true
    );
    expect(isBinaryCandidate("LeCoding.exe")).toBe(true);
    expect(isBinaryCandidate("libfoo.dylib")).toBe(true);
  });

  it("accepts extension-less macOS executables and frameworks", () => {
    expect(isBinaryCandidate("LeCoding.app/Contents/MacOS/LeCoding")).toBe(true);
    expect(
      isBinaryCandidate(
        "LeCoding.app/Contents/Frameworks/Electron Framework.framework/Electron Framework"
      )
    ).toBe(true);
  });

  it("ignores the asar archive and plain assets", () => {
    expect(isBinaryCandidate("resources/app.asar")).toBe(false);
    expect(isBinaryCandidate("resources/app.asar.unpacked/package.json")).toBe(false);
    expect(isBinaryCandidate("assets/index.js")).toBe(false);
  });
});

describe("collectBinaries", () => {
  let root: string;

  function seed(relativePath: string, bytes: Uint8Array): void {
    const target = join(root, relativePath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, bytes);
  }

  it("reads every binary under a packaged app", () => {
    root = mkdtempSync(join(tmpdir(), "lecoding-arch-"));
    seed("LeCoding.app/Contents/MacOS/LeCoding", machO(0x0100000c));
    seed(
      "LeCoding.app/Contents/Resources/app.asar.unpacked/node_modules/fsevents/fse.node",
      machO(0x0100000c)
    );
    seed("LeCoding.app/Contents/Resources/app.asar", new Uint8Array([1, 2, 3]));

    const entries = collectBinaries(root);
    expect(entries.map((entry) => entry.relativePath)).toEqual([
      "LeCoding.app/Contents/MacOS/LeCoding",
      "LeCoding.app/Contents/Resources/app.asar.unpacked/node_modules/fsevents/fse.node"
    ]);
    expect(entries.every((entry) => entry.arch === "arm64")).toBe(true);
  });

  it("marks an empty file as unknown instead of skipping it", () => {
    root = mkdtempSync(join(tmpdir(), "lecoding-arch-empty-"));
    seed("LeCoding.app/Contents/MacOS/LeCoding", new Uint8Array(0));
    const entries = collectBinaries(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.arch).toBe("unknown");
    expect(entries[0]!.architectures.size).toBe(0);
  });

  it("returns an empty list for a missing directory", () => {
    expect(collectBinaries(join(tmpdir(), "lecoding-absent-arch-dir"))).toEqual([]);
  });
});

describe("validateArchitectures", () => {
  const entries = (arch: ReleaseArch, count = 2): ArchitectureEntry[] =>
    Array.from({ length: count }, (_, index) =>
      entry(`Contents/MacOS/helper-${index}`, [arch])
    );

  it("accepts a tree where every binary matches", () => {
    expect(() =>
      validateArchitectures({
        expected: "arm64",
        entries: entries("arm64"),
        source: "macOS arm64"
      })
    ).not.toThrow();
  });

  it("accepts a universal binary that contains the target architecture", () => {
    // macOS ships universal system tools; a binary that runs natively on the
    // target is not the defect this gate exists to catch.
    expect(() =>
      validateArchitectures({
        expected: "arm64",
        entries: [entry("Contents/MacOS/LeCoding", ["x64", "arm64"])],
        source: "macOS arm64"
      })
    ).not.toThrow();
  });

  it("rejects a mismatched binary with the offending path", () => {
    expect(() =>
      validateArchitectures({
        expected: "x64",
        entries: [
          entry("Contents/MacOS/LeCoding", ["x64"]),
          entry("Contents/MacOS/Helper", ["arm64"])
        ],
        source: "macOS x64"
      })
    ).toThrow(/targets x64 but 1 binary\/binaries disagree: Contents\/MacOS\/Helper \(arm64\)/);
  });

  it("rejects unknown binaries rather than assuming they are fine", () => {
    expect(() =>
      validateArchitectures({
        expected: "arm64",
        entries: [entry("Contents/MacOS/LeCoding", [])],
        source: "macOS arm64"
      })
    ).toThrow(/disagree/);
  });

  it("rejects a package with no binaries at all", () => {
    // A missing runtime means the package step produced something unusable.
    expect(() =>
      validateArchitectures({ expected: "arm64", entries: [], source: "win32 x64" })
    ).toThrow(/contains no native binaries/);
  });
});

describe("release arch helpers", () => {
  it("accepts only the two published architectures", () => {
    expect(isReleaseArch("x64")).toBe(true);
    expect(isReleaseArch("arm64")).toBe(true);
    expect(isReleaseArch("ia32")).toBe(false);
    expect(isReleaseArch("")).toBe(false);
  });

  it("reports the runner architecture for CI pre-flight checks", () => {
    const runner = describeRunnerArch();
    expect(runner.nodeArch).toBe(process.arch);
    expect(runner.platform).toBe(process.platform);
  });

  it("treats ReleaseArch as a subset of BinaryArch", () => {
    const arch: ReleaseArch = "arm64";
    const candidate: BinaryArch = arch;
    expect(candidate).toBe("arm64");
  });

  it("describes an architecture set for error messages", () => {
    expect(describeArchitectures(new Set<ReleaseArch>(["arm64"]))).toBe("arm64");
    expect(describeArchitectures(new Set<ReleaseArch>(["arm64", "x64"]))).toBe(
      "arm64+x64"
    );
    expect(describeArchitectures(new Set<ReleaseArch>())).toBe("unknown");
  });
});
