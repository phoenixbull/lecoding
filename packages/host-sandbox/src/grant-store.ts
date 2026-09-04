/**
 * Durable store for the file-access grants this desktop issued.
 *
 * `selected_directories` authorizations must survive a restart: the user
 * granted a folder to a Run, and losing that on relaunch would either strand
 * the Run (no grant) or prompt again (annoying, and it widens the surface by
 * asking for consent that was already given). It must also be revocable, so
 * a folder the user no longer wants shared stops being shared.
 *
 * Grants are stored per Run and written as canonical, already-minimal sets —
 * the store never widens what was authorized, and reading one back revalidates
 * it, so editing the file on disk cannot upgrade a Run to `host_full`.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseFileAccessGrant, type FileAccessGrant } from "./file-access-grant.js";

export interface GrantStoreOptions {
  /** Absolute path of the JSON document. Created mode 0600. */
  filePath: string;
  /** Injected filesystem so tests never touch disk. */
  fs?: GrantFileSystem;
}

/** The narrow filesystem surface the store needs. */
export interface GrantFileSystem {
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
  ensureDirectory(path: string): Promise<void>;
}

export interface GrantStore {
  /** Grants currently authorized, keyed by Run. */
  all(): Promise<FileAccessGrant[]>;
  /** The grant for one Run, or undefined when it was never issued or revoked. */
  forRun(runId: string): Promise<FileAccessGrant | undefined>;
  /** Persists one grant, replacing any earlier grant for the same Run. */
  put(grant: FileAccessGrant): Promise<void>;
  /** Drops a Run's grant. A later command for that Run is refused. */
  revoke(runId: string): Promise<void>;
  /** Drops every grant, used on logout and device revocation. */
  clear(): Promise<void>;
}

export function createGrantStore(options: GrantStoreOptions): GrantStore {
  const fs = options.fs ?? createNodeGrantFileSystem();
  // Cached so a command can resolve its grant without a disk read per frame.
  const cache = new Map<string, FileAccessGrant>();
  let loaded: Promise<void> | undefined;

  async function ensureLoaded(): Promise<void> {
    loaded ??= (async () => {
      let contents: string;
      try {
        contents = await fs.read(options.filePath);
      } catch {
        // Absent file means "no grants yet", not an error.
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(contents) as unknown;
      } catch {
        return;
      }
      if (typeof decoded !== "object" || decoded === null) {
        return;
      }
      for (const [runId, value] of Object.entries(decoded)) {
        // Each entry is validated on load: a grant edited on disk must not
        // widen what the sandbox enforces.
        try {
          cache.set(runId, parseFileAccessGrant(value));
        } catch {
          // An invalid entry is dropped, not trusted.
        }
      }
    })();
    return loaded;
  }

  async function persist(): Promise<void> {
    const encoded: Record<string, FileAccessGrant> = {};
    for (const [runId, grant] of cache) {
      encoded[runId] = grant;
    }
    await fs.ensureDirectory(dirname(options.filePath));
    await fs.write(options.filePath, JSON.stringify(encoded, null, 2));
  }

  return {
    async all() {
      await ensureLoaded();
      return [...cache.values()];
    },

    async forRun(runId) {
      await ensureLoaded();
      return cache.get(runId);
    },

    async put(grant) {
      await ensureLoaded();
      cache.set(grant.runId, grant);
      await persist();
    },

    async revoke(runId) {
      await ensureLoaded();
      if (cache.delete(runId)) {
        await persist();
      }
    },

    async clear() {
      await ensureLoaded();
      cache.clear();
      await persist();
    }
  };
}

/**
 * Removes the grant file outright.
 *
 * Distinct from `clear()` for the teardown path, where there is nothing to
 * preserve and no reason to leave an empty document behind.
 */
export async function deleteGrantFile(options: GrantStoreOptions): Promise<void> {
  const fs = options.fs ?? createNodeGrantFileSystem();
  await fs.remove(options.filePath);
}

function createNodeGrantFileSystem(): GrantFileSystem {
  return {
    async read(path) {
      return await readFile(path, "utf8");
    },
    async write(path, contents) {
      await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
    },
    async remove(path) {
      await rm(path, { force: true });
    },
    async ensureDirectory(path) {
      await mkdir(path, { recursive: true });
    }
  };
}

/** In-memory grant filesystem for tests. */
export function createMemoryGrantFileSystem(): GrantFileSystem & {
  contents(path: string): string;
} {
  const files = new Map<string, string>();
  return {
    async read(path) {
      const contents = files.get(path);
      if (contents === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return contents;
    },
    async write(path, contents) {
      files.set(path, contents);
    },
    async remove(path) {
      files.delete(path);
    },
    async ensureDirectory() {
      // Directories are implicit in the in-memory model.
    },
    contents(path) {
      return files.get(path) ?? "";
    }
  };
}
