import { describe, expect, it, vi } from "vitest";
import { createClient, LeCodingHttpError } from "../src/index.js";

describe("LeCodingClient", () => {
  it("attaches one bearer token to ordinary, command, and SSE requests", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization")
      });
      if (String(input).endsWith("/events")) {
        return new Response("");
      }
      if (String(input).endsWith("/commands")) {
        return new Response(null, { status: 202 });
      }
      return Response.json({
        id: "run-1",
        projectId: "project-1",
        environmentId: "server-docker",
        task: "Protected",
        status: "running"
      });
    };
    const client = createClient({
      baseUrl: "https://agent.example",
      accessToken: "browser-session-token",
      fetch
    });

    await client.inspectRun("run-1");
    await client.cancelRun("run-1");
    await client.openRunEventStream("run-1");

    expect(requests).toEqual([
      expect.objectContaining({ authorization: "Bearer browser-session-token" }),
      expect.objectContaining({ authorization: "Bearer browser-session-token" }),
      expect.objectContaining({ authorization: "Bearer browser-session-token" })
    ]);
    expect(requests.every(({ url }) => !url.includes("browser-session-token"))).toBe(true);
  });

  it("exposes an authentication status without copying the response body", async () => {
    const client = createClient({
      baseUrl: "https://agent.example",
      fetch: async () =>
        new Response("provider or proxy detail must stay opaque", { status: 401 })
    });

    const failure = await client.getControlPlaneConfig().catch((error) => error);

    expect(failure).toBeInstanceOf(LeCodingHttpError);
    expect(failure).toMatchObject({ status: 401 });
    expect(String(failure)).not.toContain("proxy detail");
  });

  it("inspects a run through the versioned public endpoint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "run-1",
          projectId: "project-1",
          environmentId: "environment-1",
          task: "Add a health endpoint",
          status: "succeeded"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const client = createClient({ baseUrl: "https://agent.example", fetch });

    await expect(client.inspectRun("run-1")).resolves.toMatchObject({
      id: "run-1",
      status: "succeeded"
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://agent.example/api/v1/runs/run-1",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("lists recent Runs for refresh recovery", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        runs: [
          {
            id: "run-2",
            projectId: "project-1",
            environmentId: "server-docker",
            task: "Recover me",
            status: "running",
            updatedAt: "2026-08-26T07:00:00.000Z"
          }
        ]
      })
    );
    const client = createClient({ baseUrl: "https://agent.example", fetch });

    await expect(client.listRuns("project-1", 20)).resolves.toMatchObject({
      runs: [{ id: "run-2", status: "running" }]
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://agent.example/api/v1/projects/project-1/runs?limit=20",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("loads a bounded Git change projection for a Run", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        changedFiles: ["src/main.ts"],
        unifiedDiff: "@@ -1 +1 @@\n-old\n+new\n",
        truncated: false
      })
    );
    const client = createClient({ baseUrl: "https://agent.example", fetch });

    await expect(client.getRunChanges("run/1")).resolves.toMatchObject({
      changedFiles: ["src/main.ts"],
      truncated: false
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://agent.example/api/v1/runs/run%2F1/changes",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("opens a resumable run event stream with the last delivered event ID", async () => {
    let request: { url: string; lastEventId: string | null } | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      request = {
        url: String(input),
        lastEventId: headers.get("last-event-id")
      };
      return new Response("id: 5\nevent: status_changed\ndata: {}\n\n");
    };
    const client = createClient({ baseUrl: "https://agent.example/", fetch });

    const stream = await client.openRunEventStream("run/1", {
      lastEventId: "4"
    });
    // Reading through Response exercises the standard browser ReadableStream contract.
    const body = await new Response(stream).text();

    expect({ request, body }).toEqual({
      request: {
        url: "https://agent.example/api/v1/runs/run%2F1/events",
        lastEventId: "4"
      },
      body: "id: 5\nevent: status_changed\ndata: {}\n\n"
    });
  });

  it("creates and cancels a run through versioned public commands", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      return String(input).endsWith("/commands")
        ? new Response(null, { status: 202 })
        : Response.json({ runId: "run-2" }, { status: 202 });
    };
    const client = createClient({ baseUrl: "https://agent.example", fetch });

    await expect(
      client.createRun("project/1", {
        environmentId: "server-docker",
        task: "Add a health endpoint",
        acceptanceCriteria: ["Tests pass"],
        approvalMode: "manual",
        fileAccessScope: "workspace_only"
      })
    ).resolves.toEqual({ runId: "run-2" });
    await expect(client.cancelRun("run-2")).resolves.toBeUndefined();

    expect(requests).toEqual([
      {
        url: "https://agent.example/api/v1/projects/project%2F1/runs",
        method: "POST",
        body: {
          environmentId: "server-docker",
          task: "Add a health endpoint",
          acceptanceCriteria: ["Tests pass"],
          approvalMode: "manual",
          fileAccessScope: "workspace_only"
        }
      },
      {
        url: "https://agent.example/api/v1/runs/run-2/commands",
        method: "POST",
        body: { type: "cancel" }
      }
    ]);
  });

  it("approves or rejects exactly one pending tool call", async () => {
    const commands: unknown[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      commands.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    };
    const client = createClient({ baseUrl: "https://agent.example", fetch });

    await client.approveRun("run-1", "approval-1");
    await client.rejectRun("run-1", "approval-2");

    expect(commands).toEqual([
      { type: "approve", approvalId: "approval-1", scope: "once" },
      { type: "reject", approvalId: "approval-2", scope: "once" }
    ]);
  });

  it("answers a pending question or steers that waiting turn", async () => {
    const commands: unknown[] = [];
    const client = createClient({
      baseUrl: "https://agent.example",
      fetch: async (_input, init) => {
        commands.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 202 });
      }
    });

    await client.answerRun(
      "run-1",
      "question-1",
      "Keep /api/v1",
      "answer-command-1"
    );
    await client.steerRun(
      "run-1",
      "Also preserve error codes",
      "steer-command-1"
    );

    expect(commands).toEqual([
      {
        type: "answer",
        commandId: "answer-command-1",
        requestId: "question-1",
        value: "Keep /api/v1"
      },
      {
        type: "steer",
        commandId: "steer-command-1",
        message: "Also preserve error codes"
      }
    ]);
  });

  it("decodes fragmented SSE frames into validated Run events", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'id: 1\nevent: status_changed\ndata: {"version":1,"sequence":1,',
      '"runId":"run-1","type":"status_changed","occurredAt":"2026-08-26T00:00:00.000Z",',
      '"data":{"status":"running"}}\n\n'
    ];
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
            controller.close();
          }
        }),
        { headers: { "content-type": "text/event-stream" } }
      );
    const client = createClient({ baseUrl: "https://agent.example", fetch });
    const events = [];

    for await (const event of client.subscribeRunEvents("run-1")) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        sequence: 1,
        type: "status_changed",
        data: { status: "running" }
      })
    ]);
  });
});
