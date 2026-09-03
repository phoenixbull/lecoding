/**
 * Append-only audit log for host file access.
 *
 * M2.2 requires that every access outside the workspace lands in an immutable
 * record. "Immutable" is enforced by the interface: there is no update and no
 * delete, only `append` and `read`. A log that can be rewritten is not evidence.
 *
 * The file is created with mode 0600 because the paths it records reveal the
 * user's directory layout, and the log is never forwarded to the Renderer in
 * full — the UI receives a bounded, redacted projection.
 */

import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type HostAccessKind = "read" | "write" | "execute";

/** Where the access was observed, which determines how much it can be trusted. */
export type HostAccessOrigin =
  /** Derived from a path in the command's arguments. */
  | "command_argv"
  /** Reported by the policy engine's decision. */
  | "policy_engine"
  /** Named directly by the user, e.g. through a directory picker. */
  | "user_supplied";

export interface HostAccessAuditEntry {
  runId: string;
  kind: HostAccessKind;
  /** Canonical path that was touched, or attempted. */
  path: string;
  origin: HostAccessOrigin;
  /** True when the path lay outside the Run's grant. */
  outOfScope: boolean;
  /** ISO timestamp from an injected clock. */
  recordedAt: string;
}

export interface AccessAuditLogOptions {
  /** Absolute path of the JSONL file. */
  filePath: string;
  /** Injected clock so recorded timestamps are deterministic in tests. */
  now(): string;
  /** Injected filesystem so tests never write to disk. */
  fs?: AuditFileSystem;
}

/** The narrow filesystem surface the log needs; tests substitute an in-memory map. */
export interface AuditFileSystem {
  append(path: string, chunk: string): Promise<void>;
  read(path: string): Promise<string>;
  ensurePrivateFile(path: string): Promise<void>;
}

export interface AccessAuditLog {
  /** Appends one record. There is no update or delete by design. */
  append(entry: Omit<HostAccessAuditEntry, "recordedAt">): Promise<HostAccessAuditEntry>;
  /** Reads every record, skipping any line that is not a valid entry. */
  read(): Promise<HostAccessAuditEntry[]>;
  /** Only the out-of-scope records, which are the ones a reviewer must see. */
  readOutOfScope(): Promise<HostAccessAuditEntry[]>;
}

export function createAccessAuditLog(options: AccessAuditLogOptions): AccessAuditLog {
  const fs = options.fs ?? createNodeAuditFileSystem();

  return {
    async append(entry) {
      const record: HostAccessAuditEntry = { ...entry, recordedAt: options.now() };
      await fs.ensurePrivateFile(options.filePath);
      // One JSON object per line: a partially written last line can be skipped
      // on read, whereas a truncated JSON array would corrupt the whole log.
      await fs.append(options.filePath, `${JSON.stringify(record)}\n`);
      return record;
    },

    async read() {
      let contents: string;
      try {
        contents = await fs.read(options.filePath);
      } catch {
        return [];
      }
      const entries: HostAccessAuditEntry[] = [];
      for (const line of contents.split("\n")) {
        if (line.trim() === "") {
          continue;
        }
        const parsed = parseEntry(line);
        if (parsed) {
          entries.push(parsed);
        }
      }
      return entries;
    },

    async readOutOfScope() {
      return (await this.read()).filter((entry) => entry.outOfScope);
    }
  };
}

/** Validates one line, returning undefined rather than throwing on corruption. */
function parseEntry(line: string): HostAccessAuditEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  const origin = record["origin"];
  if (
    typeof record["runId"] !== "string" ||
    typeof record["path"] !== "string" ||
    typeof record["outOfScope"] !== "boolean" ||
    typeof record["recordedAt"] !== "string" ||
    (kind !== "read" && kind !== "write" && kind !== "execute") ||
    (origin !== "command_argv" && origin !== "policy_engine" && origin !== "user_supplied")
  ) {
    return undefined;
  }
  return {
    runId: record["runId"],
    path: record["path"],
    outOfScope: record["outOfScope"],
    recordedAt: record["recordedAt"],
    kind,
    origin
  };
}

function createNodeAuditFileSystem(): AuditFileSystem {
  const ensured = new Set<string>();
  return {
    async append(path, chunk) {
      await appendFile(path, chunk, "utf8");
    },
    async read(path) {
      return await readFile(path, "utf8");
    },
    async ensurePrivateFile(path) {
      if (ensured.has(path)) {
        return;
      }
      ensured.add(path);
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, "", { mode: 0o600 });
      // `appendFile` only applies the mode when creating, so force it in case
      // the file already existed with looser permissions.
      await chmod(path, 0o600).catch(() => undefined);
    }
  };
}

/** In-memory audit filesystem for tests. */
export function createMemoryAuditFileSystem(): AuditFileSystem & {
  contents(path: string): string;
} {
  const files = new Map<string, string>();
  return {
    async append(path, chunk) {
      files.set(path, (files.get(path) ?? "") + chunk);
    },
    async read(path) {
      const contents = files.get(path);
      if (contents === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return contents;
    },
    async ensurePrivateFile(path) {
      if (!files.has(path)) {
        files.set(path, "");
      }
    },
    contents(path) {
      return files.get(path) ?? "";
    }
  };
}
