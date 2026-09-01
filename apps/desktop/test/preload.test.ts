/**
 * Preload bridge tests.
 *
 * The preload bridge exposes a typed, narrow surface to the Renderer. PRD
 * § 10.1 requires:
 * - `contextBridge.exposeInMainWorld` is the only way out
 * - ipcRenderer itself is never handed to the Renderer
 * - the Renderer cannot call channels outside the documented IPC_CHANNELS
 *
 * Tests inject a fake `PreloadHost` that mirrors the small preload API
 * (contextBridge + ipcRenderer). The bridge wrapper is verified to call the
 * documented channels, validate inputs, and never hand the raw ipcRenderer
 * to consumers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreloadBridge } from "../src/preload/index.js";
import type { PreloadHost } from "../src/preload/index.js";
import type { IpcRequest, IpcResponse } from "../src/shared/ipc-contract.js";
import { IPC_CHANNELS } from "../src/shared/ipc-contract.js";

function createFakeHost(): PreloadHost & {
  exposed: Record<string, unknown> | null;
  invokes: Array<{ channel: string; payload: unknown }>;
} {
  const invokes: Array<{ channel: string; payload: unknown }> = [];
  const exposedState: { value: Record<string, unknown> | null } = { value: null };
  const host: PreloadHost = {
    contextBridge: {
      exposeInMainWorld: (name: string, api: unknown) => {
        exposedState.value = { [name]: api };
      }
    },
    ipcRenderer: {
      invoke: vi.fn(async (channel: string, payload: unknown) => {
        invokes.push({ channel, payload });
        return {
          ok: true,
          data: { channel, payload }
        } satisfies IpcResponse;
      })
    }
  };
  const result = Object.assign(host, { invokes }) as PreloadHost & {
    exposed: Record<string, unknown> | null;
    invokes: Array<{ channel: string; payload: unknown }>;
  };
  Object.defineProperty(result, "exposed", {
    get(): Record<string, unknown> | null {
      return exposedState.value;
    },
    enumerable: true,
    configurable: true
  });
  return result;
}

describe("createPreloadBridge", () => {
  let host: ReturnType<typeof createFakeHost>;

  beforeEach(() => {
    host = createFakeHost();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes exactly one global namespace, never ipcRenderer", () => {
    const localHost = host;
    createPreloadBridge({ host: localHost }).install();
    console.error("[test] localHost==host?", localHost === host, "exposed=", localHost.exposed);
    expect(Object.keys(host.exposed ?? {})).toEqual(["lecoding"]);
    const api = (host.exposed as { lecoding: Record<string, unknown> }).lecoding;
    // The raw ipcRenderer MUST NOT be reachable from the Renderer.
    expect("ipcRenderer" in api).toBe(false);
    expect("require" in api).toBe(false);
    expect("process" in api).toBe(false);
  });

  it("only exposes methods that map to a documented IPC channel", () => {
    createPreloadBridge({ host }).install();
    const api = (host.exposed as { lecoding: Record<string, Function> }).lecoding;
    expect(Object.keys(api).sort()).toEqual([...IPC_CHANNELS].sort());
  });

  it("forwards a typed call to ipcRenderer.invoke with the channel and payload", async () => {
    createPreloadBridge({ host }).install();
    const api = (host.exposed as { lecoding: { "runs.create": Function } }).lecoding;
    await api["runs.create"]({
      projectId: "project-1",
      input: {
        task: "hi",
        environmentId: "sandbox-v1",
        acceptanceCriteria: [],
        approvalMode: "manual",
        fileAccessScope: "workspace_only"
      }
    });
    expect(host.invokes.length).toBe(1);
    expect(host.invokes[0]!.channel).toBe("runs.create");
    expect(host.invokes[0]!.payload).toEqual({
      channel: "runs.create",
      payload: {
        projectId: "project-1",
        input: {
          task: "hi",
          environmentId: "sandbox-v1",
          acceptanceCriteria: [],
          approvalMode: "manual",
          fileAccessScope: "workspace_only"
        }
      }
    });
  });

  it("rejects malformed payloads before they reach ipcRenderer", async () => {
    createPreloadBridge({ host }).install();
    const api = (host.exposed as { lecoding: { "runs.create": Function } }).lecoding;
    // Missing required fields; the bridge must reject locally.
    await expect(api["runs.create"]({})).rejects.toThrow(/runs.create/);
    expect(host.invokes.length).toBe(0);
  });

  it("unwraps a successful response into the data payload", async () => {
    host.ipcRenderer.invoke = vi.fn(async () => ({
      ok: true,
      data: { runId: "run-1" }
    } satisfies IpcResponse));
    createPreloadBridge({ host }).install();
    const api = (host.exposed as { lecoding: { "runs.create": Function } }).lecoding;
    const data = await api["runs.create"]({ projectId: "project-1", input: { prompt: "x" } });
    expect(data).toEqual({ runId: "run-1" });
  });

  it("raises a typed BridgeError when the main process returns an error code", async () => {
    host.ipcRenderer.invoke = vi.fn(async () => ({
      ok: false,
      code: "upstream_error",
      message: "server down"
    } satisfies IpcResponse));
    createPreloadBridge({ host }).install();
    const api = (host.exposed as { lecoding: { "runs.create": Function } }).lecoding;
    await expect(
      api["runs.create"]({ projectId: "project-1", input: { prompt: "x" } })
    ).rejects.toMatchObject({
      code: "upstream_error",
      message: "server down"
    });
  });

  it("each method has a parameter validator that rejects non-object payloads", async () => {
    createPreloadBridge({ host }).install();
    const api = (host.exposed as { lecoding: Record<string, Function> }).lecoding;
    for (const channel of IPC_CHANNELS) {
      // Sending a non-object payload must throw a typed validation error.
      const method = api[channel]!;
      await expect(method("not-an-object")).rejects.toThrow(
        new RegExp(channel.replace(".", "\\."))
      );
    }
  });
});