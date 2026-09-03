/**
 * Preload bridge tests.
 *
 * The preload bridge exposes a typed, narrow surface to the Renderer. PRD
 * § 10.1 requires:
 * - `contextBridge.exposeInMainWorld` is the only way out
 * - ipcRenderer itself is never handed to the Renderer
 * - the Renderer cannot call channels outside the documented IPC_CHANNELS
 * - the Renderer cannot subscribe to arbitrary push traffic: it gets three
 *   named subscribe functions instead of `ipcRenderer.on`
 *
 * Tests inject a fake `PreloadHost` that mirrors the small preload API
 * (contextBridge + ipcRenderer). The bridge wrapper is verified to call the
 * documented channels, validate inputs, and never hand the raw ipcRenderer
 * to consumers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreloadBridge } from "../src/preload/index.js";
import type { PreloadHost } from "../src/preload/index.js";
import type {
  CredentialStatePush,
  IpcRequest,
  IpcResponse,
  RunEventPush,
  StreamStatePush
} from "../src/shared/ipc-contract.js";
import { IPC_CHANNELS, PUSH_CHANNELS } from "../src/shared/ipc-contract.js";

/** Names of the subscribe functions exposed for the whitelisted push channels. */
const PUSH_METHODS = ["onRunEvent", "onStreamState", "onCredentialState"];

function createFakeHost(): PreloadHost & {
  exposed: Record<string, unknown> | null;
  invokes: Array<{ channel: string; payload: unknown }>;
  listeners: Map<string, Set<(payload: unknown) => void>>;
  emit(channel: string, payload: unknown): void;
} {
  const invokes: Array<{ channel: string; payload: unknown }> = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
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
      }),
      on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
        const existing = listeners.get(channel) ?? new Set();
        existing.add(listener);
        listeners.set(channel, existing);
      }),
      removeListener: vi.fn((channel: string, listener: (payload: unknown) => void) => {
        listeners.get(channel)?.delete(listener);
      })
    }
  };
  const result = Object.assign(host, { invokes, listeners }) as PreloadHost & {
    exposed: Record<string, unknown> | null;
    invokes: Array<{ channel: string; payload: unknown }>;
    listeners: Map<string, Set<(payload: unknown) => void>>;
    emit(channel: string, payload: unknown): void;
  };
  result.emit = (channel: string, payload: unknown) => {
    for (const listener of listeners.get(channel) ?? []) {
      listener(payload);
    }
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

function lecoding(host: ReturnType<typeof createFakeHost>): Record<string, unknown> {
  return (host.exposed as { lecoding: Record<string, unknown> }).lecoding;
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
    createPreloadBridge({ host }).install();
    expect(Object.keys(host.exposed ?? {})).toEqual(["lecoding"]);
    const api = lecoding(host);
    // The raw ipcRenderer MUST NOT be reachable from the Renderer.
    expect("ipcRenderer" in api).toBe(false);
    expect("require" in api).toBe(false);
    expect("process" in api).toBe(false);
    expect("on" in api).toBe(false);
    expect("removeListener" in api).toBe(false);
  });

  it("exposes one invoke method per documented channel plus the push subscriptions", () => {
    createPreloadBridge({ host }).install();
    const api = lecoding(host);
    expect(Object.keys(api).sort()).toEqual(
      [...IPC_CHANNELS, ...PUSH_METHODS].sort()
    );
  });

  it("never exposes a push channel as an invokable method", () => {
    createPreloadBridge({ host }).install();
    const api = lecoding(host);
    for (const channel of PUSH_CHANNELS) {
      // Push channels must not be callable; only their named subscribe
      // function may reach the main process.
      expect(channel in api).toBe(false);
    }
  });

  it("forwards a typed call to ipcRenderer.invoke with the channel and payload", async () => {
    createPreloadBridge({ host }).install();
    const api = lecoding(host) as { "runs.create": (payload: unknown) => Promise<unknown> };
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
    const api = lecoding(host) as { "runs.create": (payload: unknown) => Promise<unknown> };
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
    const api = lecoding(host) as { "runs.create": (payload: unknown) => Promise<unknown> };
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
    const api = lecoding(host) as { "runs.create": (payload: unknown) => Promise<unknown> };
    await expect(
      api["runs.create"]({ projectId: "project-1", input: { prompt: "x" } })
    ).rejects.toMatchObject({
      code: "upstream_error",
      message: "server down"
    });
  });

  it("each method has a parameter validator that rejects non-object payloads", async () => {
    createPreloadBridge({ host }).install();
    const api = lecoding(host) as Record<string, (payload: unknown) => Promise<unknown>>;
    for (const channel of IPC_CHANNELS) {
      // Sending a non-object payload must throw a typed validation error.
      const method = api[channel]!;
      await expect(method("not-an-object")).rejects.toThrow(
        new RegExp(channel.replace(".", "\\."))
      );
    }
  });
});

describe("push subscriptions", () => {
  let host: ReturnType<typeof createFakeHost>;

  beforeEach(() => {
    host = createFakeHost();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function installed(): {
    onRunEvent: (listener: (push: RunEventPush) => void) => () => void;
    onStreamState: (listener: (push: StreamStatePush) => void) => () => void;
    onCredentialState: (listener: (push: CredentialStatePush) => void) => () => void;
  } {
    createPreloadBridge({ host }).install();
    return lecoding(host) as never;
  }

  it("registers a listener on the matching push channel only", () => {
    const api = installed();
    const listener = vi.fn();
    api.onRunEvent(listener);
    expect(host.listeners.get("runs.event")?.size).toBe(1);
    expect(host.listeners.get("runs.streamState")?.size ?? 0).toBe(0);
  });

  it("delivers a Run event pushed by the main process", () => {
    const api = installed();
    const listener = vi.fn();
    api.onRunEvent(listener);
    const push: RunEventPush = {
      runId: "run-1",
      event: {
        version: 1,
        sequence: 1,
        runId: "run-1",
        type: "status_changed",
        occurredAt: "2026-01-01T00:00:00.000Z",
        data: { status: "running" }
      }
    };
    host.emit("runs.event", push);
    expect(listener).toHaveBeenCalledWith(push);
  });

  it("delivers a stream-state push to its own subscriber", () => {
    const api = installed();
    const listener = vi.fn();
    api.onStreamState(listener);
    host.emit("runs.streamState", { runId: "run-1", phase: "reconnecting" });
    expect(listener).toHaveBeenCalledWith({ runId: "run-1", phase: "reconnecting" });
  });

  it("delivers a credential-state push so a degraded backend stays visible", () => {
    const api = installed();
    const listener = vi.fn();
    api.onCredentialState(listener);
    host.emit("session.credentialState", {
      backend: "encryptedFile",
      degraded: true,
      reason: "safeStorage 不可用"
    });
    expect(listener).toHaveBeenCalledWith({
      backend: "encryptedFile",
      degraded: true,
      reason: "safeStorage 不可用"
    });
  });

  it("removes exactly the registered listener on unsubscribe", () => {
    const api = installed();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = api.onRunEvent(first);
    api.onRunEvent(second);
    unsubscribeFirst();
    host.emit("runs.event", { runId: "run-1", event: {} });
    // Detaching one view's subscription must not silence another's.
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("ignores traffic on a channel that has no whitelisted subscriber", () => {
    const api = installed();
    const listener = vi.fn();
    api.onRunEvent(listener);
    // A push on an undeclared channel must never reach the Renderer.
    host.emit("shell.output", { secret: "leaked" });
    expect(listener).not.toHaveBeenCalled();
  });
});

/** Keeps the unused import referenced so the contract types stay in the test surface. */
export type { IpcRequest };
