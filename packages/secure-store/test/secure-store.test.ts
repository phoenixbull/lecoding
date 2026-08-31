import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createInMemorySecureStore,
  createEncryptedFileSecureStore,
  SecureStoreUnavailableError,
  type SecureStore
} from "../src/index.js";

function freshRoot(): string {
  const root = join(
    tmpdir(),
    `secure-store-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(root, { recursive: true });
  return root;
}

describe("SecureStore contract", () => {
  function runContractTests(
    make: () => { store: SecureStore; cleanup: () => void }
  ): void {
    let store: SecureStore;
    let cleanup: () => void;
    beforeEach(() => {
      const created = make();
      store = created.store;
      cleanup = created.cleanup;
    });
    afterEach(() => cleanup());

    it("returns undefined for an unknown key", async () => {
      await expect(store.getItem("missing")).resolves.toBeUndefined();
    });

    it("round-trips a value through setItem + getItem", async () => {
      await store.setItem("device-1", "secret-token");
      await expect(store.getItem("device-1")).resolves.toBe("secret-token");
    });

    it("deleteItem makes the key disappear from subsequent reads", async () => {
      await store.setItem("device-1", "secret-token");
      await store.deleteItem("device-1");
      await expect(store.getItem("device-1")).resolves.toBeUndefined();
    });

    it("deleteItem is idempotent and does not throw on missing keys", async () => {
      await expect(store.deleteItem("never-existed")).resolves.toBeUndefined();
    });

    it("listKeys returns every key in the namespace", async () => {
      await store.setItem("device-1", "a");
      await store.setItem("device-2", "b");
      await store.setItem("other", "c");
      const keys = await store.listKeys("device-");
      expect(keys.sort()).toEqual(["device-1", "device-2"]);
    });

    it("setItem is idempotent: setting the same key replaces the value", async () => {
      await store.setItem("device-1", "first");
      await store.setItem("device-1", "second");
      await expect(store.getItem("device-1")).resolves.toBe("second");
    });

    it("rejects an empty key", async () => {
      await expect(store.setItem("", "value")).rejects.toThrow(/key/);
      await expect(store.getItem("")).rejects.toThrow(/key/);
      await expect(store.deleteItem("")).rejects.toThrow(/key/);
    });

    it("rejects a key that exceeds the length limit", async () => {
      const huge = "x".repeat(513);
      await expect(store.setItem(huge, "value")).rejects.toThrow(/key/);
    });

    it("rejects a value that exceeds the size limit", async () => {
      const huge = "x".repeat(65_537);
      await expect(store.setItem("device-1", huge)).rejects.toThrow(/value/);
    });
  }

  runContractTests(() => ({
    store: createInMemorySecureStore(),
    cleanup: () => {}
  }));
});

describe("createEncryptedFileSecureStore", () => {
  let root: string;
  const passphrase = "correct horse battery staple";
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    root = freshRoot();
    cleanup = undefined;
  });
  afterEach(() => {
    cleanup?.();
    if (root) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort; tmpdir may be locked by other processes on macOS
      }
    }
  });

  function makeStore(
    overrides: Partial<Parameters<typeof createEncryptedFileSecureStore>[0]> = {}
  ): SecureStore {
    const filePath = join(root, "secrets.json");
    return createEncryptedFileSecureStore({
      filePath,
      passphrase,
      ...overrides
    });
  }

  it("round-trips a value through the encrypted file", async () => {
    const store = makeStore();
    await store.setItem("device-1", "secret-token");
    await expect(store.getItem("device-1")).resolves.toBe("secret-token");
  });

  it("persists values across re-opening the store with the same passphrase", async () => {
    const filePath = join(root, "secrets.json");
    const first = createEncryptedFileSecureStore({ filePath, passphrase });
    await first.setItem("device-1", "secret-token");

    const second = createEncryptedFileSecureStore({ filePath, passphrase });
    await expect(second.getItem("device-1")).resolves.toBe("secret-token");
  });

  it("rejects the wrong passphrase on open", async () => {
    const filePath = join(root, "secrets.json");
    const first = createEncryptedFileSecureStore({ filePath, passphrase });
    await first.setItem("device-1", "secret-token");

    const second = createEncryptedFileSecureStore({
      filePath,
      passphrase: "wrong-passphrase"
    });
    await expect(second.getItem("device-1")).rejects.toBeInstanceOf(
      SecureStoreUnavailableError
    );
  });

  it("does not write the plaintext value to disk", async () => {
    const filePath = join(root, "secrets.json");
    const store = createEncryptedFileSecureStore({ filePath, passphrase });
    const secret = "this-should-never-appear-in-bytes";
    await store.setItem("device-1", secret);
    const bytes = readFileSync(filePath);
    expect(Buffer.from(bytes).toString("utf8")).not.toContain(secret);
  });

  it("returns undefined for an unknown key in the encrypted store", async () => {
    const store = makeStore();
    await expect(store.getItem("missing")).resolves.toBeUndefined();
  });

  it("deletes keys through the encrypted store", async () => {
    const store = makeStore();
    await store.setItem("device-1", "secret-token");
    await store.deleteItem("device-1");
    await expect(store.getItem("device-1")).resolves.toBeUndefined();
  });

  it("listKeys returns only the keys in the requested namespace", async () => {
    const store = makeStore();
    await store.setItem("device-1", "a");
    await store.setItem("device-2", "b");
    await store.setItem("other", "c");
    const keys = await store.listKeys("device-");
    expect(keys.sort()).toEqual(["device-1", "device-2"]);
  });

  it("rejects an empty passphrase (a passphrase of zero entropy is not acceptable)", () => {
    expect(() =>
      createEncryptedFileSecureStore({
        filePath: join(root, "secrets.json"),
        passphrase: ""
      })
    ).toThrow(/passphrase/);
  });

  it("rejects an empty file path", () => {
    expect(() =>
      createEncryptedFileSecureStore({
        filePath: "",
        passphrase: "good-passphrase"
      })
    ).toThrow(/path/);
  });

  it("creates the parent directory if it does not exist", async () => {
    const nested = join(root, "nested", "deep", "secrets.json");
    const store = createEncryptedFileSecureStore({
      filePath: nested,
      passphrase
    });
    await store.setItem("device-1", "secret-token");
    await expect(store.getItem("device-1")).resolves.toBe("secret-token");
  });

  it("refuses to start when the file exists but is not parseable JSON", () => {
    const filePath = join(root, "secrets.json");
    writeFileSync(filePath, "this is not json");
    expect(() =>
      createEncryptedFileSecureStore({ filePath, passphrase })
    ).toThrow();
  });

  it("returns undefined when the file does not exist yet", async () => {
    const store = createEncryptedFileSecureStore({
      filePath: join(root, "absent.json"),
      passphrase
    });
    await expect(store.getItem("missing")).resolves.toBeUndefined();
  });
});