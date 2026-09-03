import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Release architectures the desktop matrix actually publishes. */
export type ReleaseArch = "x64" | "arm64";

/**
 * Collapsed architecture of one image, for reporting only.
 *
 * `unknown` means the image was not recognisable, or its only slices fall
 * outside the release matrix. Validation never trusts this field alone — it
 * checks the full architecture set — because a universal (fat) Mach-O
 * legitimately runs natively on more than one architecture and must not be
 * rejected for it.
 */
export type BinaryArch = ReleaseArch | "unknown";

export interface ArchitectureEntry {
  /** Path relative to the validated root, in POSIX form. */
  relativePath: string;
  /** Every architecture this image can execute natively. */
  architectures: ReadonlySet<ReleaseArch>;
  /** Collapsed view used in error messages. */
  arch: BinaryArch;
}

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MH_MAGIC = 0xfeedface;
const MH_CIGAM = 0xcefaedfe;
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;

const CPU_TYPE_X86 = 7;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM = 12;
const CPU_TYPE_ARM64 = 0x0100000c;

const IMAGE_FILE_MACHINE_I386 = 0x014c;
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;

const EM_386 = 3;
const EM_X86_64 = 62;
const EM_ARM = 40;
const EM_AARCH64 = 183;

/** Extensions that always denote a loadable native image. */
const BINARY_EXTENSIONS = [".node", ".dll", ".exe", ".dylib", ".so"];

/**
 * Directories whose contents are Mach-O executables without a file extension.
 *
 * On macOS the app binary and every bundled helper live under
 * `Contents/MacOS`, and bundled frameworks under `Contents/Frameworks` ship
 * extension-less images — an extension-only walk would silently skip them.
 */
const MACHO_DIRECTORIES = ["Contents/MacOS/", "Contents/Frameworks/"];

/** Directories that hold unpacked native addons inside an Electron app. */
const UNPACKED_DIRECTORIES = ["app.asar.unpacked/", "Resources/app.asar.unpacked/"];

/**
 * Reads every architecture one in-memory image can execute natively.
 *
 * Implemented with plain header parsing instead of shelling out to `lipo` or
 * `file` so the same check runs on macOS and Windows runners with zero external
 * dependencies — the Windows job has no `lipo` at all.
 *
 * An empty result means "not a recognisable, publishable image", which
 * validation treats as a failure.
 */
export function readBinaryArchitectures(
  bytes: Uint8Array
): ReadonlySet<ReleaseArch> {
  if (bytes.length < 8) {
    return new Set();
  }
  const magic = readUInt32BE(bytes, 0);

  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    return readFatArchitectures(bytes, magic === FAT_MAGIC_64);
  }
  if (
    magic === MH_MAGIC ||
    magic === MH_CIGAM ||
    magic === MH_MAGIC_64 ||
    magic === MH_CIGAM_64
  ) {
    // FEEDFACE/FEEDFACF are read big-endian; the CIGAM forms are byte-swapped.
    const bigEndian = magic === MH_MAGIC || magic === MH_MAGIC_64;
    const cputype = bigEndian ? readUInt32BE(bytes, 4) : readUInt32LE(bytes, 4);
    return singleArch(machoCpuTypeArch(cputype));
  }
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) {
    return singleArch(readPeArch(bytes));
  }
  if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    return singleArch(readElfArch(bytes));
  }
  return new Set();
}

/** Collapses an architecture set into the reporting value. */
export function readBinaryArch(bytes: Uint8Array): BinaryArch {
  const architectures = readBinaryArchitectures(bytes);
  if (architectures.size !== 1) {
    // Either unrecognisable, or a universal binary that runs natively on more
    // than one architecture; both need the full set to be judged.
    return "unknown";
  }
  return [...architectures][0]!;
}

function singleArch(arch: BinaryArch): ReadonlySet<ReleaseArch> {
  return arch === "unknown" ? new Set() : new Set([arch]);
}

/**
 * Resolves a universal (fat) Mach-O into the union of its slices.
 *
 * A universal file is publishable under any architecture it contains: the
 * defect this gate exists to catch is a *thin* binary of the wrong
 * architecture hiding behind a correct-looking file name, not a binary that
 * genuinely runs on both.
 */
function readFatArchitectures(
  bytes: Uint8Array,
  is64: boolean
): ReadonlySet<ReleaseArch> {
  const count = readUInt32BE(bytes, 4);
  if (count === 0 || count > 8) {
    return new Set();
  }
  // fat_arch is 20 bytes (cputype, cpusubtype, offset, size, align — all
  // uint32). fat_arch_64 widens offset and size to uint64, which makes the
  // entry 32 bytes. Getting this wrong reads the wrong bytes for every slice
  // after the first, so a universal binary would be judged on garbage.
  const entrySize = is64 ? 32 : 20;
  const architectures = new Set<ReleaseArch>();
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * entrySize;
    if (offset + 4 > bytes.length) {
      return new Set();
    }
    const arch = machoCpuTypeArch(readUInt32BE(bytes, offset));
    if (arch === "unknown") {
      // One unsupported slice (a 32-bit leftover, say) makes the whole image
      // unpublishable rather than silently shipping a partial binary.
      return new Set();
    }
    architectures.add(arch);
  }
  return architectures;
}

function machoCpuTypeArch(cputype: number): BinaryArch {
  switch (cputype) {
    case CPU_TYPE_X86_64:
      return "x64";
    case CPU_TYPE_ARM64:
      return "arm64";
    case CPU_TYPE_X86:
    case CPU_TYPE_ARM:
      // 32-bit slices are not in the release matrix.
      return "unknown";
    default:
      return "unknown";
  }
}

function readPeArch(bytes: Uint8Array): BinaryArch {
  if (bytes.length < 0x40) {
    return "unknown";
  }
  const peOffset = readUInt32LE(bytes, 0x3c);
  if (peOffset + 6 > bytes.length) {
    return "unknown";
  }
  if (
    bytes[peOffset] !== 0x50 ||
    bytes[peOffset + 1] !== 0x45 ||
    bytes[peOffset + 2] !== 0x00 ||
    bytes[peOffset + 3] !== 0x00
  ) {
    return "unknown";
  }
  const machine = readUInt16LE(bytes, peOffset + 4);
  switch (machine) {
    case IMAGE_FILE_MACHINE_AMD64:
      return "x64";
    case IMAGE_FILE_MACHINE_ARM64:
      return "arm64";
    case IMAGE_FILE_MACHINE_I386:
      return "unknown";
    default:
      return "unknown";
  }
}

function readElfArch(bytes: Uint8Array): BinaryArch {
  if (bytes.length < 20) {
    return "unknown";
  }
  const littleEndian = bytes[5] === 1;
  const machine = littleEndian ? readUInt16LE(bytes, 18) : readUInt16BE(bytes, 18);
  switch (machine) {
    case EM_X86_64:
      return "x64";
    case EM_AARCH64:
      return "arm64";
    case EM_386:
    case EM_ARM:
      return "unknown";
    default:
      return "unknown";
  }
}

// Every reader ends with `>>> 0`: JS bitwise operators work on signed 32-bit
// integers, so a Mach-O magic like 0xFEEDFACF would otherwise come back
// negative and never match its constant.
function readUInt16BE(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)) >>> 0;
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

/** True when a path names a file this validator must inspect. */
export function isBinaryCandidate(relativePath: string): boolean {
  const normalized = relativePath.split(sep).join("/");
  if (normalized.endsWith(".asar")) {
    return false;
  }
  const lower = normalized.toLowerCase();
  if (BINARY_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return true;
  }
  if (MACHO_DIRECTORIES.some((directory) => normalized.includes(directory))) {
    // Only extension-less files matter here; extended ones were handled above.
    const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
    return !fileName.includes(".");
  }
  return false;
}

/** Walks a packaged app (or an extracted archive) and reads every binary. */
export function collectBinaries(rootDir: string): ArchitectureEntry[] {
  const entries: ArchitectureEntry[] = [];
  walk(rootDir, rootDir, entries);
  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function walk(rootDir: string, currentDir: string, entries: ArchitectureEntry[]): void {
  if (!existsSync(currentDir)) {
    return;
  }
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const absolutePath = join(currentDir, entry.name);
    const relativePath = relative(rootDir, absolutePath).split(sep).join("/");
    if (entry.isDirectory()) {
      walk(rootDir, absolutePath, entries);
      continue;
    }
    if (!entry.isFile() || !isBinaryCandidate(relativePath)) {
      continue;
    }
    // A zero-byte or unreadable file is a packaging failure, not a pass.
    if (statSync(absolutePath).size === 0) {
      entries.push({ relativePath, architectures: new Set(), arch: "unknown" });
      continue;
    }
    entries.push({ relativePath, ...readFileArch(absolutePath) });
  }
}

/**
 * Reads one file on disk into its architecture set plus the reporting value.
 */
export function readFileArch(filePath: string): {
  architectures: ReadonlySet<ReleaseArch>;
  arch: BinaryArch;
} {
  return readEntryArch(new Uint8Array(readFileSync(filePath)));
}

function readEntryArch(bytes: Uint8Array): {
  architectures: ReadonlySet<ReleaseArch>;
  arch: BinaryArch;
} {
  const architectures = readBinaryArchitectures(bytes);
  const arch = architectures.size === 1 ? ([...architectures][0]! as BinaryArch) : "unknown";
  return { architectures, arch };
}

export interface ValidateArchitecturesInput {
  /** Architecture the release matrix promised for this job. */
  expected: ReleaseArch;
  entries: ArchitectureEntry[];
  /** Human-readable origin (job name, archive path) used in the error. */
  source: string;
}

/**
 * Fails closed when any binary disagrees with the promised architecture.
 *
 * This is the guard that stops the historical defect where a `darwin/x64` job
 * produced an arm64 artefact: the runner image was arm64, so the file name said
 * x64 while every Mach-O slice said arm64.
 */
export function validateArchitectures(
  input: ValidateArchitecturesInput
): void {
  const { expected, entries, source } = input;
  if (entries.length === 0) {
    throw new Error(
      `architecture: ${source} contains no native binaries; the package is missing its runtime`
    );
  }
  const mismatches = entries.filter((entry) => !entry.architectures.has(expected));
  if (mismatches.length > 0) {
    const sample = mismatches
      .slice(0, 5)
      .map(
        (entry) =>
          `${entry.relativePath} (${describeArchitectures(entry.architectures)})`
      )
      .join(", ");
    throw new Error(
      `architecture: ${source} targets ${expected} but ${mismatches.length} ` +
        `binary/binaries disagree: ${sample}`
    );
  }
}

/**
 * Reports whether the current Node process matches the target architecture.
 *
 * A job that runs under Rosetta (or an arm64 runner asked to build x64) would
 * otherwise produce a mislabelled artefact, so the runner itself is part of the
 * check.
 */
export function describeRunnerArch(): {
  nodeArch: string;
  platform: string;
} {
  return { nodeArch: process.arch, platform: process.platform };
}

/**
 * True when a Node arch string maps onto a release arch.
 *
 * `process.arch` reports `x64` / `arm64` on both platforms; anything else
 * (ia32, ppc64, …) cannot publish a desktop artefact.
 */
export function isReleaseArch(value: string): value is ReleaseArch {
  return value === "x64" || value === "arm64";
}

/** Renders an architecture set for an error message. */
export function describeArchitectures(
  architectures: ReadonlySet<ReleaseArch>
): string {
  return architectures.size === 0 ? "unknown" : [...architectures].sort().join("+");
}

/** Native addon directories that must survive asar unpacking. */
export const NATIVE_UNPACK_DIRECTORIES: readonly string[] = UNPACKED_DIRECTORIES;
