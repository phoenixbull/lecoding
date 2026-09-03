import type {
  CredentialStatePush,
  IpcRequestByChannel,
  IpcChannel,
  RunEventPush,
  StreamStatePush
} from "../../shared/ipc-contract.js";

/**
 * Typed view of the object the preload installs on `window.lecoding`.
 *
 * Declared here rather than re-exported from the preload module so the
 * Renderer bundle stays independent of main-process code — the two are
 * separate Vite/tsc outputs and must never share a runtime import.
 */
export type LeCodingBridge = {
  [C in IpcChannel]: (payload: IpcRequestByChannel[C]) => Promise<unknown>;
} & {
  onRunEvent(listener: (push: RunEventPush) => void): () => void;
  onStreamState(listener: (push: StreamStatePush) => void): () => void;
  onCredentialState(listener: (push: CredentialStatePush) => void): () => void;
};

/**
 * Reads the bridge installed by the preload.
 *
 * Throws a named error when it is missing: a Renderer without the bridge is a
 * packaging failure (the preload was not mounted), and failing loudly beats
 * rendering a console that cannot do anything.
 */
export function readBridge(): LeCodingBridge {
  const bridge = (globalThis as { lecoding?: LeCodingBridge }).lecoding;
  if (!bridge) {
    throw new Error(
      "window.lecoding is unavailable: the preload bridge was not mounted"
    );
  }
  return bridge;
}
