import type {
  CredentialStatePush,
  RunEventPush,
  StreamStatePush
} from "../src/shared/ipc-contract.js";
import { IPC_CHANNELS, PUSH_CHANNELS } from "../src/shared/ipc-contract.js";
import type { LeCodingBridge } from "../src/renderer/gateway/bridge.js";

export interface FakeBridge extends LeCodingBridge {
  calls: Array<{ channel: string; payload: unknown }>;
  /** Sets the value a channel resolves with. */
  respond(channel: string, value: unknown): void;
  emitRunEvent(push: RunEventPush): void;
  emitStreamState(push: StreamStatePush): void;
  emitCredentialState(push: CredentialStatePush): void;
}

type Listener = (payload: unknown) => void;

/**
 * In-memory stand-in for the preload bridge.
 *
 * Lets a component test drive the Renderer end to end — invoke channels,
 * push Run events, and assert what the controller asked for — without
 * Electron, a display server, or a real Worker.
 */
export function createFakeBridge(): FakeBridge {
  const calls: Array<{ channel: string; payload: unknown }> = [];
  const responses = new Map<string, unknown>();
  const listeners = new Map<string, Set<Listener>>();

  function emit(channel: string, payload: unknown): void {
    for (const listener of listeners.get(channel) ?? []) {
      listener(payload);
    }
  }

  function subscribe(channel: string, listener: Listener): () => void {
    const existing = listeners.get(channel) ?? new Set<Listener>();
    existing.add(listener);
    listeners.set(channel, existing);
    return () => {
      existing.delete(listener);
    };
  }

  const api: Record<string, unknown> = {};
  for (const channel of IPC_CHANNELS) {
    api[channel] = async (payload: unknown) => {
      calls.push({ channel, payload });
      if (responses.has(channel)) {
        return responses.get(channel);
      }
      return {};
    };
  }
  // One subscribe function per whitelisted push channel, mirroring the real
  // preload: a Renderer can only receive, never invoke, these.
  void PUSH_CHANNELS;
  api["onRunEvent"] = (listener: Listener) => subscribe("runs.event", listener);
  api["onStreamState"] = (listener: Listener) => subscribe("runs.streamState", listener);
  api["onCredentialState"] = (listener: Listener) =>
    subscribe("session.credentialState", listener);

  const bridge = {
    ...api,
    calls,
    respond(channel: string, value: unknown) {
      responses.set(channel, value);
    },
    emitRunEvent(push: RunEventPush) {
      emit("runs.event", push);
    },
    emitStreamState(push: StreamStatePush) {
      emit("runs.streamState", push);
    },
    emitCredentialState(push: CredentialStatePush) {
      emit("session.credentialState", push);
    }
  };

  return bridge as unknown as FakeBridge;
}
