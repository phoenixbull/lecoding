/**
 * `ws` adapter for the Runner transport (desktop side).
 *
 * One of exactly two places in the repository allowed to import `ws`. It opens
 * the WSS connection to the Worker and adapts it to `RunnerSocket`; every
 * protocol decision lives in `@lecoding/runner-protocol`, which neither knows
 * nor cares that a WebSocket is involved.
 *
 * The URL carries no credential. The device access token is sent in the first
 * `hello` frame instead, so it never lands in a URL, and therefore never lands
 * in a proxy log, a shell history, or a crash report.
 */

import WebSocket from "ws";
import type { RunnerSocket, RunnerSocketClose } from "@lecoding/runner-protocol";

/** Path the Worker serves the Runner endpoint on. */
export const RUNNER_WS_PATH = "/api/v1/runner";

/** Builds the WSS URL for a base HTTP(S) origin. */
export function runnerWebSocketUrl(baseUrl: string): string {
  const url = new URL(RUNNER_WS_PATH, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Opens a WSS connection and adapts it to the transport-agnostic interface. */
export function createRunnerWebSocket(url: string): RunnerSocket {
  const client = new WebSocket(url);
  return adaptRunnerWebSocket(client);
}

/** Adapts an already-constructed `ws` client to `RunnerSocket`. */
export function adaptRunnerWebSocket(client: WebSocket): RunnerSocket {
  return {
    send(text: string): void {
      // A send during teardown must be a silent no-op: the session routinely
      // races its own shutdown (a heartbeat firing as the app quits).
      if (client.readyState !== WebSocket.OPEN) {
        return;
      }
      client.send(text);
    },

    close(code: number, reason?: string): void {
      client.close(code, reason ?? "");
    },

    onMessage(listener: (text: string) => void): () => void {
      const handler = (data: unknown) => {
        if (typeof data === "string") {
          listener(data);
          return;
        }
        if (Buffer.isBuffer(data)) {
          listener(data.toString("utf8"));
          return;
        }
        if (Array.isArray(data)) {
          listener(Buffer.concat(data).toString("utf8"));
        }
      };
      client.on("message", handler);
      return () => client.off("message", handler);
    },

    onClose(listener: (info: RunnerSocketClose) => void): () => void {
      const handler = (code: number, reason: Buffer) => {
        listener({ code, reason: reason.toString("utf8") });
      };
      client.on("close", handler);
      // Transport errors always end in a close. The protocol has exactly one
      // recovery action for a broken transport — reconnect — so `RunnerSocket`
      // deliberately exposes no separate error channel.
      client.on("error", () => undefined);
      return () => client.off("close", handler);
    }
  };
}
