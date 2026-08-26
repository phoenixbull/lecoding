import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "@lecoding/client-sdk";
import type { Engine } from "@lecoding/run-engine";
import { encodeRunEventSse } from "@lecoding/run-events";
import {
  loadWorkerHttpConfig,
  startWorkerHttpServer
} from "../src/http-server.js";

describe("Worker HTTP server", () => {
  it("refuses a non-loopback bind before the single-user API has authentication", () => {
    expect(() =>
      loadWorkerHttpConfig({ LECODING_HTTP_HOST: "0.0.0.0" })
    ).toThrow("loopback");
  });

  it("serves the Web shell and versioned Run API on one origin", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "lecoding-web-root-"));
    await mkdir(join(webRoot, "assets"));
    await writeFile(join(webRoot, "index.html"), "<main>LeCoding</main>", "utf8");
    await writeFile(join(webRoot, "assets", "app.js"), "export {};", "utf8");
    const runs = {
      start: vi.fn(async () => "run-1"),
      resume: vi.fn(async () => undefined),
      command: vi.fn(async () => undefined),
      inspect: vi.fn(async () => ({
        id: "run-1",
        projectId: "project-1",
        environmentId: "server-docker",
        task: "Test",
        status: "queued" as const
      }))
    };
    const server = await startWorkerHttpServer({
      host: "127.0.0.1",
      port: 0,
      webRoot,
      control: {
        projectId: "project-1",
        runs: runs as unknown as Engine,
        history: { list: vi.fn(async () => []) },
        changes: { read: vi.fn(async () => ({ changedFiles: [], unifiedDiff: "", truncated: false })) },
        eventStream: {
          handle: vi.fn(async () => new Response("", { status: 200 }))
        }
      }
    });
    try {
      const shell = await fetch(`${server.origin}/`);
      const created = await fetch(
        `${server.origin}/api/v1/projects/project-1/runs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            environmentId: "server-docker",
            task: "Test",
            acceptanceCriteria: ["Pass"],
            approvalMode: "manual",
            fileAccessScope: "workspace_only"
          })
        }
      );

      expect(await shell.text()).toContain("LeCoding");
      expect(shell.headers.get("content-security-policy")).toContain(
        "default-src 'self'"
      );
      expect(created.status).toBe(202);
      await expect(created.json()).resolves.toEqual({ runId: "run-1" });
    } finally {
      await server.stop();
      await rm(webRoot, { recursive: true, force: true });
    }
  });

  it("closes the SDK loop across create, SSE, evidence inspection, and cancel", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "lecoding-web-root-"));
    await writeFile(join(webRoot, "index.html"), "<main>LeCoding</main>", "utf8");
    const command = vi.fn(async () => undefined);
    const event = {
      version: 1 as const,
      sequence: 1,
      runId: "run-loop",
      type: "verification_completed" as const,
      occurredAt: "2026-08-26T05:00:00.000Z",
      data: { outcome: "passed" }
    };
    const runs = {
      start: vi.fn(async () => "run-loop"),
      resume: vi.fn(async () => undefined),
      command,
      inspect: vi.fn(async () => ({
        id: "run-loop",
        projectId: "project-1",
        environmentId: "server-docker",
        task: "Close the loop",
        status: "running" as const,
        verification: {
          outcome: "passed" as const,
          checks: [{ name: "tests", outcome: "passed" as const, detail: "11 passed" }]
        }
      }))
    };
    const server = await startWorkerHttpServer({
      host: "127.0.0.1",
      port: 0,
      webRoot,
      control: {
        projectId: "project-1",
        runs: runs as unknown as Engine,
        history: { list: vi.fn(async () => []) },
        changes: { read: vi.fn(async () => ({ changedFiles: [], unifiedDiff: "", truncated: false })) },
        eventStream: {
          handle: vi.fn(async () =>
            new Response(encodeRunEventSse(event), {
              headers: { "content-type": "text/event-stream" }
            })
          )
        }
      }
    });
    try {
      // Exercise only the public client surface over a real loopback listener.
      const client = createClient({ baseUrl: server.origin });
      const config = await client.getControlPlaneConfig();
      const created = await client.createRun(config.projectId, {
        environmentId: config.defaultEnvironmentId,
        task: "Close the loop",
        acceptanceCriteria: ["Tests pass"],
        approvalMode: "manual",
        fileAccessScope: "workspace_only"
      });
      const events = [];
      for await (const received of client.subscribeRunEvents(created.runId)) {
        events.push(received);
      }
      const view = await client.inspectRun(created.runId);
      await client.cancelRun(created.runId);

      expect(events).toEqual([event]);
      expect(view.verification?.checks[0]?.detail).toBe("11 passed");
      expect(command).toHaveBeenCalledWith("run-loop", { type: "cancel" });
    } finally {
      await server.stop();
      await rm(webRoot, { recursive: true, force: true });
    }
  });
});
