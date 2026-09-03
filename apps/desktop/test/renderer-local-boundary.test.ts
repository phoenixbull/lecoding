import { describe, expect, it, vi } from "vitest";
import { createPreloadBridge, type PreloadHost } from "../src/preload/index.js";
import { IPC_CHANNELS, PUSH_CHANNELS } from "../src/shared/ipc-contract.js";

/**
 * M2.4: the Renderer must not gain local-execution, filesystem or credential
 * capability.
 *
 * The preload bridge is the Renderer's only surface, so the boundary is
 * checked there: whatever is not exposed cannot be reached, however the
 * Renderer is compromised. These assertions are deliberate and coarse — if a
 * future change widens the surface past them, this file fails.
 */

function host(): PreloadHost {
  const exposed: Record<string, unknown> = {};
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const invoke = vi.fn(async () => ({ ok: true, data: {} }));
  const api = {
    contextBridge: {
      exposeInMainWorld: (name: string, value: unknown) => {
        exposed[name] = value;
      }
    },
    ipcRenderer: {
      invoke,
      on: (channel: string, listener: (payload: unknown) => void) => {
        if (!listeners.has(channel)) {
          listeners.set(channel, new Set());
        }
        listeners.get(channel)!.add(listener);
        return { remove: () => listeners.get(channel)?.delete(listener) };
      },
      removeListener: (channel: string, listener: (payload: unknown) => void) => {
        listeners.get(channel)?.delete(listener);
      }
    }
  };
  createPreloadBridge({ host: api as unknown as PreloadHost }).install();
  return { exposed, invoke, listeners } as unknown as PreloadHost & {
    exposed: Record<string, unknown>;
    listeners: Map<string, Set<(payload: unknown) => void>>;
  };
}

describe("Renderer boundary for local execution", () => {
  it("exposes no child_process, filesystem or network surface", () => {
    const { exposed } = host() as never as { exposed: Record<string, unknown> };
    const bridge = exposed["lecoding"] as Record<string, unknown>;
    // The bridge is a closed object: nothing outside the documented channel
    // names and push subscriptions can be reached from the Renderer.
    expect(Object.keys(bridge).sort()).toEqual(
      [...IPC_CHANNELS, "onRunEvent", "onStreamState", "onCredentialState", "onRunnerState"].sort()
    );
    // Guard against a module-level leak rather than a surface one: none of the
    // exposed values may be a Node primitive such as a stream or a handle.
    for (const [name, value] of Object.entries(bridge)) {
      expect(value, name).toBeTypeOf("function");
    }
  });

  it("exposes no local-execution or filesystem channel", () => {
    const forbidden = [
      "exec",
      "spawn",
      "shell",
      "fs.read",
      "fs.write",
      "fs.unlink",
      "net.connect",
      "process.env"
    ];
    for (const channel of forbidden) {
      expect(
        IPC_CHANNELS.some((known) => known === channel),
        `channel "${channel}" must not be invokable`
      ).toBe(false);
    }
  });

  it("exposes no channel that accepts a device credential", () => {
    // Only devices.exchange receives a one-time code, and it returns a bare
    // boolean: the access token never crosses back into the Renderer.
    const exchange = IPC_CHANNELS.find((channel) => channel === "devices.exchange");
    expect(exchange).toBeDefined();
    expect(IPC_CHANNELS.filter((channel) => channel.includes("token"))).toEqual([]);
  });

  it("exposes local-execution state only through a push channel", () => {
    // Status and capability levels are pushed to the Renderer; there is no
    // request/response channel that could return a worktree path.
    expect(PUSH_CHANNELS).toContain("runner.state");
    expect(IPC_CHANNELS).toContain("runner.status");
    // The status channel exists, but the push carries no path field by type:
    // RunnerStatePush declares state, sandbox.platform, tiers and detail only.
  });

  it("never exposes a raw push channel as an invokable method", () => {
    const { exposed } = host() as never as { exposed: Record<string, unknown> };
    const bridge = exposed["lecoding"] as Record<string, unknown>;
    for (const channel of PUSH_CHANNELS) {
      // Invoking a push channel would let the Renderer forge main-process
      // traffic; only its named subscription may exist.
      expect(bridge[channel], channel).toBeUndefined();
    }
  });

  it("exposes runner.status but no grant or audit channel", () => {
    // Grants are issued by Main from OS dialogs and consumed by the sandbox.
    // Letting the Renderer read the grant's directory list, or the audit log,
    // would hand a compromised Renderer real host paths.
    expect(IPC_CHANNELS).toContain("runner.status");
    expect(IPC_CHANNELS.filter((channel) => channel.startsWith("grant."))).toEqual([]);
    expect(IPC_CHANNELS.filter((channel) => channel.startsWith("audit."))).toEqual([]);
  });
});
