import { Server, createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { RunnerSocket } from "@lecoding/runner-protocol";
import { attachRunnerWsServer, RUNNER_WS_PATH } from "../src/runner-ws-server.js";

/**
 * The Runner adapter is reachable through a real listener.
 *
 * Scope note: this suite calls `attachRunnerWsServer` directly, so it proves
 * the adapter and its upgrade handling — not the composition in `main.ts` that
 * decides whether it is mounted at all. The composition is covered by
 * `worker-runtime.test.ts`, which asserts `configureServer` is supplied.
 * Together they cover the mount and the wiring; either alone leaves a gap.
 *
 * The WSS endpoint is attached to the raw `node:http` server's `upgrade`
 * event, which the Web-standard API handler cannot express. That makes it the
 * one part of the transport a request-level test cannot reach — and therefore
 * the one part that can silently be left unmounted while every other test
 * still passes.
 *
 * So this suite uses a real client against a real listener. It deliberately
 * does not use `globalThis.WebSocket`: that is absent on Node 20, and a
 * version guard would turn these into tests that pass by not running.
 */

const servers: Server[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
  // `terminate()` rather than `close()`: close() throws on a socket that never
  // finished connecting, which is exactly the state a rejected upgrade leaves
  // behind. A throwing teardown is how a test run ends up hanging on cleanup.
  while (clients.length > 0) {
    clients.pop()?.terminate();
  }
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) {
      continue;
    }
    // An upgrade the Runner does not claim leaves a raw socket that
    // `closeAllConnections()` does not track, so `close()` would never call
    // back. Bounding teardown is what keeps this suite from hanging the run.
    server.closeAllConnections();
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000))
    ]);
  }
});

/** Starts a real HTTP server with the Runner endpoint attached. */
async function startWithRunner(): Promise<{
  port: number;
  connections: RunnerSocket[];
}> {
  const connections: RunnerSocket[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  servers.push(server);

  attachRunnerWsServer({
    server,
    onConnection: (socket) => connections.push(socket)
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, connections };
}

/** Opens a real client and resolves once the server has accepted it. */
async function connect(port: number, path: string): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    perMessageDeflate: false
  });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", (error) => reject(error));
  });
  return client;
}

/** Waits for the server-side adapter to surface the accepted connection. */
async function waitForConnection(
  connections: RunnerSocket[]
): Promise<RunnerSocket> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const socket = connections[0];
    if (socket) {
      return socket;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The server never reported the connection");
}

describe("runner endpoint mounting", () => {
  it("accepts a WebSocket upgrade on the Runner path", async () => {
    const { port, connections } = await startWithRunner();
    await connect(port, RUNNER_WS_PATH);

    const socket = await waitForConnection(connections);
    expect(socket).toBeDefined();
    expect(connections).toHaveLength(1);
  });

  it("ignores upgrades for other paths", async () => {
    // Not every upgrade on this server belongs to the Runner; claiming them
    // all would break any future transport sharing the listener.
    const { port, connections } = await startWithRunner();
    const rejected = new WebSocket(`ws://127.0.0.1:${port}/api/v1/something-else`, {
      perMessageDeflate: false
    });
    clients.push(rejected);
    // The server is expected to hang up on this one; without a listener the
    // resulting error surfaces as an unhandled rejection.
    rejected.on("error", () => undefined);
    // The upgrade is not ours, so the socket ends up torn down rather than
    // handed to the Runner.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(connections).toHaveLength(0);
    // The server never answers this upgrade, so the socket would otherwise
    // outlive the test and keep the listener from closing.
    rejected.terminate();
  });

  it("delivers a frame sent before the socket opens", async () => {
    // The regression this guards: `hello` was dropped because the client socket
    // was still CONNECTING when the session sent it, so the Runner never
    // authenticated. In-memory sockets are open from the outset and could not
    // reproduce it.
    const { port, connections } = await startWithRunner();
    const client = await connect(port, RUNNER_WS_PATH);
    const socket = await waitForConnection(connections);

    const received = new Promise<string>((resolve, reject) => {
      client.once("message", (data) => resolve(data.toString("utf8")));
      setTimeout(() => reject(new Error("no frame received")), 500);
    });

    // Sent immediately after accept, while the transport may still be settling.
    socket.send(JSON.stringify({ v: 1, kind: "heartbeat", cursor: 0 }));

    expect(await received).toContain("heartbeat");
  });
});
