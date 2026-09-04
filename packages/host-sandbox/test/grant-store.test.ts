import { describe, expect, it } from "vitest";
import {
  createFileAccessGrant,
  createGrantStore,
  createMemoryGrantFileSystem
} from "../src/index.js";

const now = () => "2026-09-04T00:00:00.000Z";
const PATH = "/state/grants.json";

function harness() {
  const fs = createMemoryGrantFileSystem();
  return { fs, store: createGrantStore({ filePath: PATH, fs }) };
}

function grant(runId: string, scope: "workspace_only" | "host_full" = "workspace_only") {
  return createFileAccessGrant({
    runId,
    scope,
    worktreePath: "/work/run-1",
    dangerAcknowledged: scope === "host_full",
    now
  });
}

describe("createGrantStore", () => {
  it("returns and persists a grant for its Run", async () => {
    const { store } = harness();
    await store.put(grant("run-1"));

    const found = await store.forRun("run-1");
    expect(found?.runId).toBe("run-1");
    expect(await store.all()).toHaveLength(1);
  });

  it("survives a restart by reading the same durable document", async () => {
    // A restart is a fresh store over the same file.
    const { fs, store } = harness();
    await store.put(grant("run-1"));

    const relaunched = createGrantStore({ filePath: PATH, fs });
    await expect(relaunched.forRun("run-1")).resolves.toBeDefined();
  });

  it("revokes a grant so a later command is refused", async () => {
    const { store } = harness();
    await store.put(grant("run-1"));
    await store.revoke("run-1");

    await expect(store.forRun("run-1")).resolves.toBeUndefined();
  });

  it("replaces an earlier grant for the same Run", async () => {
    const { store } = harness();
    await store.put(grant("run-1", "workspace_only"));
    await store.put(grant("run-1", "host_full"));

    const found = await store.forRun("run-1");
    expect(found?.scope).toBe("host_full");
    expect(await store.all()).toHaveLength(1);
  });

  it("drops every grant on clear", async () => {
    // Used on logout and device revocation, where nothing should survive.
    const { store } = harness();
    await store.put(grant("run-1"));
    await store.put(grant("run-2"));
    await store.clear();

    expect(await store.all()).toEqual([]);
  });

  it("treats a missing file as no grants rather than an error", async () => {
    const { store } = harness();
    await expect(store.all()).resolves.toEqual([]);
  });

  it("drops an entry that was edited on disk to widen it", async () => {
    // A persisted grant is untrusted input: without revalidation, editing the
    // file would upgrade a Run to unrestricted host access.
    const { fs, store } = harness();
    await store.put(grant("run-1"));
    fs.write(PATH, JSON.stringify({ "run-1": { forged: true } }));

    const relaunched = createGrantStore({ filePath: PATH, fs });
    await expect(relaunched.forRun("run-1")).resolves.toBeUndefined();
  });
});
