/**
 * `ws` adapter for the Runner transport (server side).
 *
 * This is one of exactly two places in the repository allowed to import `ws`.
 * Everything above it — the gateway, the session, the codec — is transport-free
 * and tested without a network, which is what keeps the recovery guarantees
 * provable rather than merely plausible.
 *
 * The adapter's whole job is translation: `ws` events become `RunnerSocket`
 * callbacks, and nothing else. Any protocol decision made here would be a
 * decision that cannot be unit tested.
 */

import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { createQueuedRunnerSocket } from "@lecoding/runner-protocol";
import type { RunnerSocket, RunnerSocketClose } from "@lecoding/runner-protocol";

/** Path the desktop Local Runner connects to. */
export const RUNNER_WS_PATH = "/api/v1/runner";

export interface AttachRunnerWsServerOptions {
  server: Server;
  /** Receives each upgraded connection. */
  onConnection(socket: RunnerSocket): void;
  /**
   * Rejects a request before the WebSocket handshake completes.
   *
   * Returning false closes the TCP socket. Origin checking lives here because
   * a browser can be made to open a WebSocket cross-origin; the Runner is a
   * desktop client with no origin, so an unexpected one is suspicious.
   */
  allowRequest?(request: IncomingMessage): boolean;
}

export interface RunnerWsServer {
  close(): Promise<void>;
}

export function attachRunnerWsServer(
  options: AttachRunnerWsServerOptions
): RunnerWsServer {
  const wss = new WebSocketServer({
    // `noServer` keeps HTTP routing in `http-server.ts`: the upgrade only
    // reaches us for the exact Runner path, and every other request is
    // untouched.
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
    // Compression is refused on the server too, matching the client. If either
    // side enabled it while the other did not, the negotiated result would
    // still surprise whoever audited the transport.
    perMessageDeflate: false
  });

  const onUpgrade = (request: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== RUNNER_WS_PATH) {
      // Not ours: another upgrade handler may claim it.
      return;
    }
    if (options.allowRequest && !options.allowRequest(request)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      options.onConnection(adaptWebSocket(client));
    });
  };

  options.server.on("upgrade", onUpgrade);

  return {
    async close() {
      options.server.off("upgrade", onUpgrade);
      for (const client of wss.clients) {
        client.close(4003, "worker shutting down");
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    }
  };
}

/**
 * Adapts a `ws` client to the transport-agnostic `RunnerSocket` interface.
 *
 * Uses the same shared queue as the desktop client, so both ends treat
 * "not yet open" identically. A server socket is open as soon as the upgrade
 * completes, but `welcome` is emitted from inside an async `authenticate`, and
 * queueing removes any ordering dependency on when that resolves.
 */
export function adaptWebSocket(client: WebSocket): RunnerSocket {
  return createQueuedRunnerSocket({
    send(text) {
      client.send(text);
    },
    close(code, reason) {
      client.close(code, reason ?? "");
    },
    onOpen(listener) {
      if (client.readyState === client.OPEN) {
        queueMicrotask(listener);
        return () => undefined;
      }
      client.on("open", listener);
      return () => client.off("open", listener);
    },
    onMessage(listener) {
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
    onClose(listener) {
      const handler = (code: number, reason: Buffer) => {
        listener({ code, reason: reason.toString("utf8") });
      };
      client.on("close", handler);
      // A transport error always ends in close; the protocol's only recovery
      // action for a broken transport is reconnect, so it needs no other signal.
      client.on("error", () => undefined);
      return () => client.off("close", handler);
    }
  });
}
