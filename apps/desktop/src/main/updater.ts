/**
 * Production auto-update wiring.
 *
 * `installVerifiedUpdate` is the mandatory gate, but a gate nothing calls
 * stops nothing: before this module existed, no update could be installed or
 * rejected in a real app. This module owns everything around the gate —
 * discovery timing, download, the pinned key, and handing verified bytes to
 * the platform installer.
 *
 * Two rules shape it:
 *
 * - The public key comes from the desktop's own configuration, never from the
 *   payload. A key delivered alongside the artifact it authenticates proves
 *   nothing, so a missing key disables updating rather than trusting the feed.
 * - Every failure is a refusal. Nothing falls back to installing anyway.
 */

import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildAutoUpdateFeed,
  createAutoUpdater,
  type AutoUpdateChannel,
  type UpdateOutcome
} from "../build/auto-update.js";

/** Where the update configuration comes from; all of it is trusted input. */
export interface UpdaterConfig {
  /** Ed25519 SPKI public key PEM pinned by the release, not the feed. */
  publicKey?: string;
  repository?: string;
  channel?: AutoUpdateChannel;
  /** Explicit URLs win over feed discovery, which keeps tests deterministic. */
  manifestUrl?: string;
  signatureUrl?: string;
}

export interface DesktopUpdaterOptions {
  config: UpdaterConfig;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Directory the verified artifact is staged in before installation. */
  stagePath: string;
  fetchBytes(url: string): Promise<Uint8Array>;
  /** Runs the staged artifact. Injected so tests never launch an installer. */
  runInstaller(input: { filePath: string; platform: NodeJS.Platform }): Promise<void>;
  onOutcome?(outcome: UpdateOutcome): void;
  onError?(error: unknown): void;
}

export interface DesktopUpdater {
  /** True when a pinned key and a target are configured. */
  enabled(): boolean;
  checkAndInstall(): Promise<UpdateOutcome>;
}

/** Reads and validates the update configuration from the environment. */
export function loadUpdaterConfig(
  env: NodeJS.ProcessEnv = process.env
): UpdaterConfig {
  const publicKey = env["LECODING_UPDATE_PUBLIC_KEY"]?.trim();
  const repository = env["LECODING_REPOSITORY"]?.trim();
  const channel = env["LECODING_UPDATE_CHANNEL"]?.trim();
  return {
    ...(publicKey ? { publicKey } : {}),
    ...(repository ? { repository } : {}),
    ...(channel === "stable" || channel === "beta" ? { channel } : {}),
    ...(env["LECODING_UPDATE_MANIFEST_URL"]?.trim()
      ? { manifestUrl: env["LECODING_UPDATE_MANIFEST_URL"]!.trim() }
      : {}),
    ...(env["LECODING_UPDATE_SIGNATURE_URL"]?.trim()
      ? { signatureUrl: env["LECODING_UPDATE_SIGNATURE_URL"]!.trim() }
      : {})
  };
}

/**
 * Derives the two URLs the updater needs.
 *
 * Feed discovery yields only the releases API endpoint; the manifest and
 * signature live beside the release assets. Without explicit URLs there is no
 * safe way to guess them, so updating stays disabled rather than probing.
 */
function targetUrls(config: UpdaterConfig):
  | { manifestUrl: string; signatureUrl: string }
  | undefined {
  if (config.manifestUrl && config.signatureUrl) {
    return { manifestUrl: config.manifestUrl, signatureUrl: config.signatureUrl };
  }
  if (!config.manifestUrl || !config.repository) {
    return undefined;
  }
  // One explicit URL is honoured and the sibling derived, so a partial
  // configuration cannot silently point at an unrelated signature.
  const base = config.manifestUrl.replace(/\/[^/]*$/u, "");
  return {
    manifestUrl: config.manifestUrl,
    signatureUrl: config.signatureUrl ?? `${base}/manifest.sig`
  };
}

export function createDesktopUpdater(options: DesktopUpdaterOptions): DesktopUpdater {
  const { config } = options;

  const platform =
    options.platform === "darwin" || options.platform === "win32"
      ? options.platform
      : undefined;
  const arch = options.arch === "arm64" || options.arch === "x64" ? options.arch : undefined;
  const urls = targetUrls(config);

  const enabled = Boolean(config.publicKey && platform && arch && urls);

  return {
    enabled: () => enabled,

    async checkAndInstall() {
      if (!enabled || !platform || !arch || !urls) {
        // Disabled is not an error: the app runs normally and simply never
        // offers an update. It must never degrade to trusting the feed.
        const outcome: UpdateOutcome = {
          installed: false,
          reason: "Auto-update is not configured: pin LECODING_UPDATE_PUBLIC_KEY"
        };
        options.onOutcome?.(outcome);
        return outcome;
      }

      const updater = createAutoUpdater({
        manifestUrl: urls.manifestUrl,
        signatureUrl: urls.signatureUrl,
        publicKey: config.publicKey!,
        currentVersion: options.currentVersion,
        platform,
        arch,
        fetchBytes: options.fetchBytes,
        install: async (artifact) => {
          await mkdir(options.stagePath, { recursive: true });
          const filePath = join(options.stagePath, `lecodex-update-${artifact.byteLength}`);
          // Staged 0700: it is an executable about to be run, and a writable
          // staging file is a straightforward way in for anything else on the
          // machine to substitute it between verification and execution.
          await writeFile(filePath, artifact, { mode: 0o700 });
          await chmod(filePath, 0o700);
          await options.runInstaller({ filePath, platform });
        }
      });

      try {
        const outcome = await updater.checkAndInstall();
        options.onOutcome?.(outcome);
        return outcome;
      } catch (error) {
        options.onError?.(error);
        return {
          installed: false,
          reason: error instanceof Error ? error.message : "Update failed"
        };
      }
    }
  };
}

/**
 * Runs the staged, already-verified artifact.
 *
 * Injected into the updater so the verification path is testable without ever
 * launching an installer. The real behaviour is platform-specific and is not
 * yet backed by target-platform evidence: it needs signed artifacts to prove.
 */
export async function runPlatformInstaller(input: {
  filePath: string;
  platform: NodeJS.Platform;
}): Promise<void> {
  if (input.platform === "darwin") {
    // `open` hands the disk image to the OS; the user completes the install.
    await new Promise<void>((resolve, reject) => {
      const child = spawn("open", [input.filePath], { stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`open exited with ${String(code)}`))
      );
    });
    return;
  }
  if (input.platform === "win32") {
    // Detached so the installer outlives the app it is replacing.
    const child = spawn(input.filePath, ["/SILENT"], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }
  throw new Error(`Auto-update installation is not supported on ${input.platform}`);
}

/** Builds the feed a release publishes to; exported so Main need not know the shape. */
export function feedFor(config: UpdaterConfig) {
  if (!config.repository) {
    return undefined;
  }
  return buildAutoUpdateFeed({
    repository: config.repository,
    channel: config.channel ?? "stable"
  });
}
