/**
 * Preload bridge for the Electron desktop shell.
 *
 * Runs in an isolated context with contextIsolation=true (PRD § 10.1). The
 * bridge is the ONLY path through which the Renderer reaches the main
 * process; raw `ipcRenderer`, `require`, and `process` are deliberately
 * kept out of the exposed surface.
 *
 * Each channel maps to one strongly-typed method on `window.lecoding`. The
 * method:
 *   1. Validates the payload against the shared schema
 *   2. Forwards to `ipcRenderer.invoke(channel, validatedPayload)`
 *   3. Unwraps the response and rejects with a typed `BridgeError` when
 *      the main process returns an error code
 *
 * Tests inject a `PreloadHost` that mirrors the Electron preload API.
 */

import {
  IPC_CHANNELS,
  ipcRequestSchema,
  type IpcChannel,
  type IpcErrorCode,
  type IpcRequest,
  type IpcResponse
} from "../shared/ipc-contract.js";

export interface PreloadContextBridge {
  exposeInMainWorld(name: string, api: unknown): void;
}

export interface PreloadIpcRenderer {
  invoke(channel: string, payload: unknown): Promise<IpcResponse>;
}

export interface PreloadHost {
  contextBridge: PreloadContextBridge;
  ipcRenderer: PreloadIpcRenderer;
}

export interface PreloadBridge {
  install(): void;
}

/** Typed error raised by the bridge when the main process returns a code. */
export class BridgeError extends Error {
  public readonly code: IpcErrorCode;
  public constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "BridgeError";
  }
}

export function createPreloadBridge(options: { host: PreloadHost }): PreloadBridge {
  const { host } = options;

  function validateOrThrow(channel: IpcChannel, payload: unknown): unknown {
    const validator = ipcRequestSchema(channel);
    if (!validator) {
      throw new BridgeError(
        "unknown_channel",
        `No schema registered for channel ${channel}`
      );
    }
    try {
      return validator(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "validation_failed";
      throw new BridgeError("validation_failed", message);
    }
  }

  async function call<C extends IpcChannel>(
    channel: C,
    payload: unknown
  ): Promise<unknown> {
    const validated = validateOrThrow(channel, payload);
    const request = { channel, payload: validated } as IpcRequest;
    const response = await host.ipcRenderer.invoke(channel, request);
    if (response.ok) {
      return response.data;
    }
    throw new BridgeError(response.code as IpcErrorCode, response.message);
  }

  function buildApi(): Record<string, (payload: unknown) => Promise<unknown>> {
    const api: Record<string, (payload: unknown) => Promise<unknown>> = {};
    for (const channel of IPC_CHANNELS) {
      api[channel] = (payload: unknown) => call(channel, payload);
    }
    return api;
  }

  return {
    install(): void {
      // Single global namespace; never expose the raw ipcRenderer.
      const api = buildApi();
      host.contextBridge.exposeInMainWorld("lecoding", Object.freeze(api));
    }
  };
}