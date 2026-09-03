import { mkdtempSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@lecoding/client-sdk";
import type { RunEventV1, RunSummary, RunView } from "@lecoding/contracts";
import {
  createDeviceBindingHttpHandler,
  createDeviceBindingService,
  createInMemoryDeviceBindingStore
} from "@lecoding/device-binding";
import { encodeRunEventSse } from "@lecoding/run-events";
import type { Engine } from "@lecoding/run-engine";
import { startWorkerHttpServer } from "@lecoding/worker";
import type { ElectronHost, IpcHandler } from "../src/main/host.js";
import { createDesktopMain } from "../src/main/index.js";
import type { IpcRequest, IpcResponse } from "../src/shared/ipc-contract.js";

/**
 * Deep business end-to-end coverage for the desktop shell.
 *
 * Everything below the preload is real: a real Worker HTTP server on loopback,
 * a real client SDK, the real device-binding service, and the real main-process
 * IPC dispatcher. Only Electron itself is faked (no display server on CI), and
 * only the Run state machine is scripted — RunEngine behaviour is covered by
 * its own suite.
 *
 * Environment gate: the sandbox this repository is developed in forbids
 * loopback listeners, so the server start is attempted up front and the whole
 * suite reports as skipped with an explicit reason instead of failing. CI jobs
 * that permit loopback run it for real.
 */

interface LoopbackServer {
  origin: string;
  stop(): Promise<void>;
}

let skipReason: string | undefined;
let server: LoopbackServer | undefined;

/** Starts the Worker HTTP transport, recording why it could not if it cannot. */
async function tryStartServer(): Promise<void> {
  try {
    const webRoot = realpathSync(mkdtempSync(join(tmpdir(), "lecoding-e2e-web-")));
    writeFileSync(join(webRoot, "index.html"), "<main>LeCoding</main>", "utf8");
    const started = await startWorkerHttpServer({
      host: "127.0.0.1",
      port: 0,
      auth: { mode: "none" },
      webRoot,
      control: controlPlane()
    });
    server = { origin: started.origin, stop: () => started.stop() };
  } catch (error) {
    skipReason = `loopback listener unavailable: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

// ---------------------------------------------------------------------------
// Scripted control plane
// ---------------------------------------------------------------------------

const PROJECT_ID = "project-1";
const eventLog: RunEventV1[] = [];
const eventWaiters = new Set<(event: RunEventV1) => void>();
const runs = new Map<string, RunView>();
let sequence = 0;

/**
 * Appends an event to the durable log and wakes every open SSE response.
 *
 * The sequence is server-owned: callers must not supply it, otherwise the
 * `id:` field and the envelope can disagree and the SDK rejects the frame.
 */
function publish(
  event: Omit<RunEventV1, "version" | "occurredAt" | "sequence">
): RunEventV1 {
  sequence += 1;
  const full: RunEventV1 = {
    ...event,
    version: 1,
    sequence,
    occurredAt: new Date().toISOString()
  } as RunEventV1;
  eventLog.push(full);
  for (const waiter of eventWaiters) {
    waiter(full);
  }
  return full;
}

/**
 * Moves the scripted Run into a new status.
 *
 * `clear` exists because `exactOptionalPropertyTypes` forbids assigning
 * `undefined` to an optional field: clearing a pending approval has to delete
 * the key rather than blank it.
 */
function setRun(
  runId: string,
  patch: Partial<RunView>,
  clear: ReadonlyArray<keyof RunView> = []
): void {
  const current = runs.get(runId);
  if (!current) {
    return;
  }
  const next: RunView = { ...current, ...patch };
  for (const key of clear) {
    delete next[key];
  }
  runs.set(runId, next);
}

function controlPlane() {
  const deviceStore = createInMemoryDeviceBindingStore();
  return {
    defaultProjectId: PROJECT_ID,
    projectIds: [PROJECT_ID],
    runs: {
      // The API expects `start` to hand back the durable RunId itself, then
      // resumes execution off the request path.
      async start(input: { task: string; environmentId: string }): Promise<string> {
        const runId = `run-${runs.size + 1}`;
        runs.set(runId, {
          id: runId,
          projectId: PROJECT_ID,
          environmentId: input.environmentId,
          task: input.task,
          status: "queued"
        });
        publish({ runId, type: "status_changed", data: { status: "queued" } } as never);
        return runId;
      },
      async resume() {
        return undefined;
      },
      async command(runId: string, command: { type: string }) {
        const run = runs.get(runId);
        if (!run) {
          throw new Error(`unknown run ${runId}`);
        }
        if (command.type === "cancel") {
          setRun(runId, { status: "cancelled" }, ["pendingApproval"]);
          return;
        }
        if (command.type === "approve" || command.type === "reject") {
          setRun(runId, { status: "running" }, ["pendingApproval"]);
          return;
        }
        setRun(runId, { status: "running" }, ["pendingUserRequest"]);
      },
      async inspect(runId: string) {
        const run = runs.get(runId);
        if (!run) {
          throw Object.assign(new Error("unknown run"), { status: 404 });
        }
        return run;
      }
    } as unknown as Engine,
    history: {
      async list(): Promise<RunSummary[]> {
        return [...runs.values()].map((run) => ({
          id: run.id,
          projectId: run.projectId,
          environmentId: run.environmentId,
          task: run.task,
          status: run.status,
          updatedAt: new Date().toISOString()
        }));
      }
    },
    changes: {
      async read() {
        return {
          changedFiles: ["src/health.ts"],
          unifiedDiff: "diff --git a/src/health.ts b/src/health.ts",
          truncated: false
        };
      }
    },
    results: {
      async resolve() {
        return undefined;
      }
    },
    access: {
      async authenticate() {
        return { userId: "user-1", email: "agent@example.com" };
      },
      async roleFor() {
        return "admin" as const;
      }
    },
    projectPolicy: {
      async list() {
        return [];
      },
      async revoke() {
        return undefined;
      }
    },
    eventStream: {
      async handle(request: Request) {
        const lastEventId = request.headers.get("last-event-id");
        let cursor = lastEventId ? Number(lastEventId) : 0;
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (event: RunEventV1): void => {
              if (event.sequence <= cursor) {
                return;
              }
              cursor = event.sequence;
              controller.enqueue(encoder.encode(encodeRunEventSse(event)));
            };
            for (const event of eventLog) {
              send(event);
            }
            const listener = (event: RunEventV1): void => {
              try {
                send(event);
              } catch {
                // The client disconnected between publish and enqueue.
                eventWaiters.delete(listener);
              }
            };
            eventWaiters.add(listener);
            // The stream stays open until the client disconnects: a real SSE
            // endpoint never closes on its own, and closing here would spin
            // the broker's reconnect loop.
            request.signal.addEventListener(
              "abort",
              () => {
                eventWaiters.delete(listener);
              },
              { once: true }
            );
          }
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-store"
          }
        });
      }
    },
    devices: createDeviceBindingHttpHandler({
      service: createDeviceBindingService({ store: deviceStore }),
      principal: {
        async authenticate() {
          return { userId: "user-1", email: "agent@example.com" };
        }
      },
      projectIds: [PROJECT_ID],
      projectName: (projectId) => (projectId === PROJECT_ID ? "Project One" : undefined)
    })
  };
}

// ---------------------------------------------------------------------------
// Fake Electron host
// ---------------------------------------------------------------------------

interface FakeWindow {
  webPreferences: Record<string, unknown>;
  webContents: {
    id: string;
    on: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    session: { webRequest: { onHeadersReceived: ReturnType<typeof vi.fn> } };
  };
  loadURL: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

function createFakeHost(): ElectronHost & {
  windows: FakeWindow[];
  handlers: Map<string, IpcHandler>;
  pushes: Array<{ channel: string; payload: unknown }>;
  closeWindow(): void;
} {
  const handlers = new Map<string, IpcHandler>();
  const windows: FakeWindow[] = [];
  const pushes: Array<{ channel: string; payload: unknown }> = [];
  const host = {
    app: {
      on: vi.fn(),
      quit: vi.fn(),
      whenReady: () => Promise.resolve()
    },
    ipcMain: {
      handle: (channel: string, handler: IpcHandler) => {
        handlers.set(channel, handler);
      }
    },
    BrowserWindow: class {
      public webPreferences: Record<string, unknown>;
      public webContents: FakeWindow["webContents"];
      public loadURL: ReturnType<typeof vi.fn>;
      public loadFile: ReturnType<typeof vi.fn>;
      public on: ReturnType<typeof vi.fn>;
      constructor(options: { webPreferences: Record<string, unknown> }) {
        this.webPreferences = options.webPreferences;
        this.loadURL = vi.fn(async () => undefined);
        this.loadFile = vi.fn(async () => undefined);
        this.on = vi.fn();
        this.webContents = {
          id: "webcontents-1",
          on: vi.fn(),
          setWindowOpenHandler: vi.fn(() => ({ action: "deny" as const })),
          send: vi.fn((channel: string, payload: unknown) => {
            pushes.push({ channel, payload });
          }),
          session: { webRequest: { onHeadersReceived: vi.fn() } }
        };
        windows.push(this as unknown as FakeWindow);
      }
    } as unknown as ElectronHost["BrowserWindow"],
    setCspHeader: vi.fn()
  } satisfies ElectronHost;
  return Object.assign(host, {
    windows,
    handlers,
    pushes,
    closeWindow() {
      const window = windows[0];
      const closed = window?.on.mock.calls.find((call) => call[0] === "closed");
      (closed?.[1] as (() => void) | undefined)?.();
    }
  }) as ElectronHost & {
    windows: FakeWindow[];
    handlers: Map<string, IpcHandler>;
    pushes: Array<{ channel: string; payload: unknown }>;
    closeWindow(): void;
  };
}

const SENDER = { senderId: "webcontents-1" };

async function settle(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

/** Boots a desktop main wired to the real Worker over loopback. */
async function bootDesktop() {
  const host = createFakeHost();
  const main = createDesktopMain({
    host,
    createClientSdk: (config) =>
      createClient({ baseUrl: config.baseUrl }) as never,
    rendererEntry: "dist/renderer/index.html",
    preloadEntry: "/preload.js"
  });
  await main.start();
  const bootstrap = host.handlers.get("session.bootstrap")!;
  const response = (await bootstrap(
    { channel: "session.bootstrap", payload: { baseUrl: server!.origin } },
    SENDER
  )) as IpcResponse;
  expect(response.ok).toBe(true);
  return { host, main };
}

/** Runs one IPC channel through the registered handler. */
async function call(
  host: ReturnType<typeof createFakeHost>,
  request: IpcRequest
): Promise<unknown> {
  const handler = host.handlers.get(request.channel as string)!;
  const response = (await handler(request, SENDER)) as IpcResponse;
  if (!response.ok) {
    throw new Error(`${request.channel}: ${response.code} ${response.message}`);
  }
  return response.data;
}

await tryStartServer();

afterAll(async () => {
  await server?.stop().catch(() => undefined);
});

describe.skipIf(skipReason !== undefined)(
  `desktop Run loop integration${skipReason ? ` (skipped: ${skipReason})` : ""}`,
  () => {
    it("drives device binding, Run creation, approvals, diff, and disposal over real HTTP", async () => {
      const { host } = await bootDesktop();

      const config = (await call(host, {
        channel: "config.load",
        payload: {}
      })) as { projectId: string; projects: Array<{ role: string }> };
      expect(config.projectId).toBe(PROJECT_ID);
      expect(config.projects[0]?.role).toBe("admin");

      // --- device binding -------------------------------------------------
      const issued = (await call(host, {
        channel: "devices.createCode",
        payload: { projectId: PROJECT_ID }
      })) as { code: string; expiresAt: string };
      expect(issued.code).toMatch(/^[A-Z0-9]{9}$/);

      const exchanged = (await call(host, {
        channel: "devices.exchange",
        payload: {
          code: issued.code,
          deviceLabel: "office-mac",
          platform: "darwin",
          projectId: PROJECT_ID
        }
      })) as { deviceId: string; projectName: string };
      expect(exchanged.deviceId).toBeTruthy();
      expect(exchanged.projectName).toBe("Project One");

      const listing = (await call(host, {
        channel: "devices.list",
        payload: {}
      })) as { devices: Array<{ deviceId: string; deviceLabel: string }> };
      expect(listing.devices.map((device) => device.deviceLabel)).toEqual([
        "office-mac"
      ]);

      // --- create a Run ---------------------------------------------------
      const created = (await call(host, {
        channel: "runs.create",
        payload: {
          projectId: PROJECT_ID,
          input: {
            task: "为 API 增加健康检查端点",
            environmentId: "server-docker",
            acceptanceCriteria: ["测试全部通过"],
            approvalMode: "manual",
            fileAccessScope: "workspace_only"
          }
        }
      })) as { runId: string };

      await call(host, { channel: "runs.subscribe", payload: { runId: created.runId } });

      // --- SSE reaches the Renderer through the push channel ---------------
      publish({
        runId: created.runId,
        type: "status_changed",
        data: { status: "running" }
      } as never);
      await settle();
      const events = host.pushes.filter((push) => push.channel === "runs.event");
      expect(events.length).toBeGreaterThan(0);
      // The device token must never cross into Renderer traffic.
      expect(JSON.stringify(host.pushes)).not.toContain("accessToken");

      // --- approval -------------------------------------------------------
      setRun(created.runId, {
        status: "waiting_approval",
        pendingApproval: {
          id: "approval-1",
          callId: "call-1",
          summary: "运行 pnpm test",
          capabilityType: "command_exec",
          capabilityHash: "hash",
          riskLevel: "low",
          allowedScopes: ["once"]
        }
      });
      publish({
        runId: created.runId,
        type: "approval_requested",
        data: { summary: "运行 pnpm test" }
      } as never);
      await settle();

      const waiting = (await call(host, {
        channel: "runs.inspect",
        payload: { runId: created.runId }
      })) as RunView;
      expect(waiting.status).toBe("waiting_approval");

      await call(host, {
        channel: "runs.approve",
        payload: { runId: created.runId, approvalId: "approval-1", scope: "once" }
      });
      const approved = (await call(host, {
        channel: "runs.inspect",
        payload: { runId: created.runId }
      })) as RunView;
      expect(approved.status).toBe("running");

      // --- diff evidence --------------------------------------------------
      const changes = (await call(host, {
        channel: "runs.changes",
        payload: { runId: created.runId }
      })) as { changedFiles: string[] };
      expect(changes.changedFiles).toEqual(["src/health.ts"]);

      // --- result disposal ------------------------------------------------
      setRun(created.runId, { status: "succeeded" });
      publish({
        runId: created.runId,
        type: "status_changed",
        data: { status: "succeeded" }
      } as never);
      await settle();
      await call(host, {
        channel: "runs.resolve",
        payload: { runId: created.runId, outcome: "discard" }
      });

      // --- device revocation clears the server-side device ----------------
      await call(host, {
        channel: "devices.revoke",
        payload: { deviceId: exchanged.deviceId }
      });
      const afterRevoke = (await call(host, {
        channel: "devices.list",
        payload: {}
      })) as { devices: unknown[] };
      expect(afterRevoke.devices).toEqual([]);

      host.closeWindow();
    });

    it("rejects IPC requests from a sender that is not the active Renderer", async () => {
      const { host } = await bootDesktop();
      const handler = host.handlers.get("runs.inspect")!;
      const response = (await handler(
        { channel: "runs.inspect", payload: { runId: "run-1" } },
        { senderId: "stranger" }
      )) as IpcResponse;
      expect(response.ok).toBe(false);
      if (response.ok === false) {
        expect(response.code).toBe("untrusted_sender");
      }
      host.closeWindow();
    });

    it("blocks popups, external navigation, and loads only the packaged Renderer", async () => {
      const { host } = await bootDesktop();
      const window = host.windows[0]!;
      expect(window.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);

      const navigate = window.webContents.on.mock.calls.find(
        (call) => call[0] === "will-navigate"
      );
      expect(navigate).toBeDefined();
      let prevented = false;
      (navigate?.[1] as (event: unknown, url: string) => void)(
        { preventDefault: () => {
          prevented = true;
        } },
        "https://evil.example"
      );
      // The Renderer must never navigate off the packaged origin.
      expect(prevented).toBe(true);
      expect(window.webPreferences.nodeIntegration).toBe(false);
      expect(window.webPreferences.sandbox).toBe(true);
      host.closeWindow();
    });
  }
);
