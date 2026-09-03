/**
 * Issues Run-level `FileAccessGrant`s from OS-native interaction.
 *
 * Desktop Main is the only component that may create a grant, and it may only
 * do so from a real OS dialog. This module is deliberately the whole path: if a
 * dialog cannot be shown, no grant is produced. There is no "type a path into
 * the Renderer" fallback, because a path typed into a sandboxed web view is not
 * an authorization by the operating system or by the user's file manager.
 *
 * The sandbox in the Local Runner enforces the grant. Nothing here enforces
 * anything — it records a decision the user actually made.
 */

import { realpath } from "node:fs/promises";
import {
  createFileAccessGrant,
  FileAccessGrantError,
  type FileAccessGrant
} from "@lecoding/host-sandbox";
import type { FileAccessScope } from "@lecoding/contracts";
import type { DangerConfirmationInput, ElectronHost } from "./host.js";

export interface GrantRequest {
  runId: string;
  scope: FileAccessScope;
  worktreePath: string;
  /** Pre-selected directories, used only when the scope does not need a picker. */
  selectedDirectories?: readonly string[];
}

export type GrantOutcome =
  | { granted: true; grant: FileAccessGrant }
  /** The user cancelled, or the dialog could not be shown. Never fatal. */
  | { granted: false; reason: "cancelled" | "dialog_unavailable" };

/** Why a directory selection did not produce a usable set of paths. */
type DirectoryCollection =
  | { ok: true; paths: string[] }
  | { ok: false; reason: "cancelled" | "dialog_unavailable" };

export interface FileAccessGrantService {
  /** Issues a grant, opening OS dialogs only when the scope requires them. */
  issue(request: GrantRequest): Promise<GrantOutcome>;
}

export interface FileAccessGrantServiceOptions {
  host: ElectronHost;
  /** Injected clock so grant timestamps are deterministic in tests. */
  now(): string;
  /** Canonicalizes a chosen path. Defaults to `fs.realpath`. */
  canonicalize?(path: string): Promise<string>;
}

const HOST_FULL_DETAIL =
  "Commands in this Run may read, modify or delete any file your account can " +
  "reach, including files outside this project. The local sandbox will not " +
  "restrict them.";

export function createFileAccessGrantService(
  options: FileAccessGrantServiceOptions
): FileAccessGrantService {
  const canonicalizeOne = options.canonicalize ?? ((path: string) => realpath(path));

  async function canonicalizeAll(paths: readonly string[]): Promise<string[]> {
    const canonical: string[] = [];
    for (const path of paths) {
      try {
        canonical.push(await canonicalizeOne(path));
      } catch {
        // A path that cannot be resolved cannot be authorized: skipping it is
        // safer than storing a spelling the sandbox would compare differently.
      }
    }
    return canonical;
  }

  async function collectDirectories(): Promise<DirectoryCollection> {
    if (!options.host.selectDirectories) {
      return { ok: false, reason: "dialog_unavailable" };
    }
    const selection = await options.host.selectDirectories({
      title: "Choose the folders this Run may access"
    });
    if (!selection.shown) {
      return { ok: false, reason: "dialog_unavailable" };
    }
    if (selection.paths.length === 0) {
      return { ok: false, reason: "cancelled" };
    }
    const canonical = await canonicalizeAll(selection.paths);
    if (canonical.length === 0) {
      return { ok: false, reason: "cancelled" };
    }
    return { ok: true, paths: canonical };
  }

  async function confirmHostFull(): Promise<boolean> {
    if (!options.host.confirmDanger) {
      // No dialog means no consent. Returning true here would grant unrestricted
      // host access on the strength of a config value.
      return false;
    }
    const input: DangerConfirmationInput = {
      title: "Allow this Run to access your whole computer?",
      message: "This Run is requesting full host file access.",
      detail: HOST_FULL_DETAIL,
      acknowledgementLabel: "I understand this Run can modify files outside this project"
    };
    return await options.host.confirmDanger(input);
  }

  return {
    async issue(request) {
      const canonicalWorktree = (await canonicalizeAll([request.worktreePath]))[0];
      if (canonicalWorktree === undefined) {
        return { granted: false, reason: "dialog_unavailable" };
      }

      if (request.scope === "selected_directories") {
        const selection = await collectDirectories();
        if (!selection.ok) {
          return { granted: false, reason: selection.reason };
        }
        return build(request, canonicalWorktree, selection.paths, false);
      }

      if (request.scope === "host_full") {
        if (!(await confirmHostFull())) {
          return { granted: false, reason: "cancelled" };
        }
        return build(request, canonicalWorktree, [], true);
      }

      return build(request, canonicalWorktree, [], false);
    }
  };

  function build(
    request: GrantRequest,
    worktreePath: string,
    directories: string[],
    dangerAcknowledged: boolean
  ): GrantOutcome {
    try {
      return {
        granted: true,
        grant: createFileAccessGrant({
          runId: request.runId,
          scope: request.scope,
          worktreePath,
          selectedDirectories: directories,
          dangerAcknowledged,
          now: options.now
        })
      };
    } catch (error) {
      // A rejected grant is a refusal, not a crash: the Run must not start, and
      // the caller reports the reason rather than retrying.
      if (error instanceof FileAccessGrantError) {
        return { granted: false, reason: "dialog_unavailable" };
      }
      throw error;
    }
  }
}
