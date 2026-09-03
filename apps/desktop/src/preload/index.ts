/**
 * Preload bridge for the Electron desktop shell.
 *
 * Runs in an isolated context with contextIsolation=true (PRD § 10.1). The
 * bridge is the ONLY path through which the Renderer reaches the main
 * process; raw `ipcRenderer`, `require`, and `process` are deliberately
 * kept out of the exposed surface.
 *
 * Each request channel maps to one strongly-typed method on
 * `window.lecoding`. The method:
 *   1. Validates the payload against the shared schema
 *   2. Forwards to `ipcRenderer.invoke(channel, validatedPayload)`
 *   3. Unwraps the response and rejects with a typed `BridgeError` when
 *      the main process returns an error code
 *
 * Push channels are exposed as three named subscribe functions that return an
 * unsubscribe closure. A generic `ipcRenderer.on` is never exposed, so a
 * compromised Renderer cannot subscribe to arbitrary internal traffic.
 *
 * Tests inject a `PreloadHost` that mirrors the Electron preload API.
 */

import {
  IPC_CHANNELS,
  ipcRequestSchema,
  PUSH_CHANNELS,
  type CredentialStatePush,
  type IpcChannel,
  type IpcErrorCode,
  type IpcRequest,
  type IpcResponse,
  type PushChannel,
  type RunEventPush,
  type StreamStatePush
} from "../shared/ipc-contract.js";

/** The slice of Electron's `contextBridge` the bridge needs. */
export interface PreloadContextBridge {
  exposeInMainWorld(name: string, api: unknown): void;
}

/** Receives one pushed payload; the preload casts it to the typed shape. */
export type PushListener = (payload: unknown) => void;

/**
 * The slice of `ipcRenderer` the bridge needs.
 *
 * `on` / `removeListener` are deliberately kept internal to this module: the
 * exposed surface only offers one named subscribe function per push channel,
 * so a compromised Renderer cannot listen on arbitrary internal traffic.
 */
export interface PreloadIpcRenderer {
  invoke(channel: string, payload: unknown): Promise<IpcResponse>;
  on(channel: string, listener: PushListener): void;
  removeListener(channel: string, listener: PushListener): void;
}

/** Everything the preload touches from the Electron preload sandbox. */
export interface PreloadHost {
  contextBridge: PreloadContextBridge;
  ipcRenderer: PreloadIpcRenderer;
}

/** Installs the frozen `window.lecoding` surface exactly once. */
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

/** Named push subscriptions exposed to the Renderer instead of `ipcRenderer.on`. */
export interface PushSubscriptions {
  onRunEvent(listener: (push: RunEventPush) => void): () => void;
  onStreamState(listener: (push: StreamStatePush) => void): () => void;
  onCredentialState(listener: (push: CredentialStatePush) => void): () => void;
}

/** Maps each push channel to the subscribe method name exposed on the bridge. */
const PUSH_SUBSCRIPTIONS: Record<
  PushChannel,
  keyof PushSubscriptions
> = {
  "runs.event": "onRunEvent",
  "runs.streamState": "onStreamState",
  "session.credentialState": "onCredentialState"
};

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

  /**
   * Wraps one push channel in a subscribe function.
   *
   * The returned closure removes exactly the listener that was registered, so
   * unmounting a Renderer view cannot detach another view's subscription.
   */
  function buildPushApi(): PushSubscriptions {
    const api: Record<string, (listener: (push: never) => void) => () => void> = {};
    for (const channel of PUSH_CHANNELS) {
      const method = PUSH_SUBSCRIPTIONS[channel];
      api[method] = (listener: (push: never) => void) => {
        const wrapped: PushListener = (payload: unknown) => {
          listener(payload as never);
        };
        host.ipcRenderer.on(channel, wrapped);
        return () => {
          host.ipcRenderer.removeListener(channel, wrapped);
        };
      };
    }
    return api as unknown as PushSubscriptions;
  }

  return {
    install(): void {
      // Single global namespace; never expose the raw ipcRenderer.
      const api = { ...buildApi(), ...buildPushApi() };
      host.contextBridge.exposeInMainWorld("lecoding", Object.freeze(api));
    }
  };
}
