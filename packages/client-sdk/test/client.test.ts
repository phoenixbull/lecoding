import { describe, expect, it, vi } from "vitest";
import { createInMemorySecureStore } from "@lecoding/secure-store";
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

  it("owns the GitHub login URL and cookie-session logout endpoint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, { status: 204 })
    );
    const client = createClient({ baseUrl: "https://agent.example/", fetch });

    expect(client.getGitHubLoginUrl()).toBe(
      "https://agent.example/api/v1/auth/github/start"
    );
    await expect(client.logout()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      "https://agent.example/api/v1/auth/logout",
      expect.objectContaining({ method: "POST" })
    );
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

  it("manages project memberships through admin-only versioned endpoints", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      return init?.method === "GET" || init?.method === undefined
        ? Response.json({
            memberships: [{ userId: "user-alice", role: "developer" }]
          })
        : new Response(null, { status: 204 });
    };
    const client = createClient({ baseUrl: "https://agent.example", fetch });

    await expect(client.listProjectMemberships("project/1")).resolves.toEqual({
      memberships: [{ userId: "user-alice", role: "developer" }]
    });
    await client.setProjectMembership("project/1", "user/alice", "admin");
    await client.removeProjectMembership("project/1", "user/alice");

    expect(requests).toEqual([
      {
        url: "https://agent.example/api/v1/projects/project%2F1/memberships",
        method: "GET",
        body: undefined
      },
      {
        url: "https://agent.example/api/v1/projects/project%2F1/memberships/user%2Falice",
        method: "PUT",
        body: { role: "admin" }
      },
      {
        url: "https://agent.example/api/v1/projects/project%2F1/memberships/user%2Falice",
        method: "DELETE",
        body: undefined
      }
    ]);
  });

  it("lists and revokes exact project policy rules through admin endpoints", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({
            rules: [
              {
                id: "rule-1",
                projectId: "project-1",
                capabilityType: "network_egress",
                capabilityHash: "a".repeat(64),
                constraints: { host: "registry.npmjs.org", port: 443 },
                decision: "allow",
                createdBy: "user-admin",
                sourceApprovalId: "approval-1",
                createdAt: "2026-08-28T00:00:00.000Z"
              }
            ]
          });
    };
    const client = createClient({ baseUrl: "https://agent.example", fetch });

    await expect(client.listProjectPolicyRules("project/1")).resolves.toMatchObject({
      rules: [{ id: "rule-1", decision: "allow" }]
    });
    await client.revokeProjectPolicyRule("project/1", "rule/1");

    expect(requests).toEqual([
      {
        url: "https://agent.example/api/v1/projects/project%2F1/policy-rules",
        method: "GET"
      },
      {
        url: "https://agent.example/api/v1/projects/project%2F1/policy-rules/rule%2F1",
        method: "DELETE"
      }
    ]);
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

  it("loads the content-free operational projection for a Run", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        runId: "run/1",
        observedAt: "2026-08-28T08:00:10.000Z",
        statusDwellMs: { running: 9_000 },
        tools: { total: 2, failed: 1, totalDurationMs: 3_000, outputTruncated: 1 },
        approvals: { requested: 1, decided: 1, denied: 0, totalWaitMs: 2_000 },
        userActions: { steers: 0, answers: 0, cancellations: 0, keeps: 0, discards: 0 },
        worktree: { created: true, disposition: "unresolved", cleanupFailures: 0 },
        verification: { attempts: 0, passed: 0, failed: 0, inconclusive: 0 },
        failures: {}
      })
    );
    const client = createClient({ baseUrl: "https://agent.example", fetch });

    await expect(client.getRunMetrics("run/1")).resolves.toMatchObject({
      runId: "run/1",
      tools: { total: 2, failed: 1 }
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://agent.example/api/v1/runs/run%2F1/metrics",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("loads retained command output through the owning Run path", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("redacted output", { status: 200 }));
    const client = createClient({ baseUrl: "https://agent.example", fetch });

    await expect(client.getRunArtifact("run/1", "artifact/1")).resolves.toBe(
      "redacted output"
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://agent.example/api/v1/runs/run%2F1/artifacts/artifact%2F1",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("resolves a terminal Run result through the versioned endpoint", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const client = createClient({
      baseUrl: "https://agent.example",
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined
        });
        return new Response(null, { status: 204 });
      }
    });

    await expect(client.resolveRunResult("run/1", "discard")).resolves.toBeUndefined();

    expect(requests).toEqual([
      {
        url: "https://agent.example/api/v1/runs/run%2F1/result",
        method: "POST",
        body: { outcome: "discard" }
      }
    ]);
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

  it("approves or rejects a pending capability with an explicit bounded scope", async () => {
    const commands: unknown[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      commands.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    };
    const client = createClient({ baseUrl: "https://agent.example", fetch });

    await client.approveRun("run-1", "approval-1", "run");
    await client.rejectRun("run-1", "approval-2", "run");

    expect(commands).toEqual([
      { type: "approve", approvalId: "approval-1", scope: "run" },
      { type: "reject", approvalId: "approval-2", scope: "run" }
    ]);
  });

  it("submits a user-narrowed capability as edit-and-allow-once", async () => {
    const commands: unknown[] = [];
    const client = createClient({
      baseUrl: "https://agent.example",
      fetch: async (_input, init) => {
        commands.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 202 });
      }
    });

    await client.editAndApproveRun("run-1", "approval-1", {
      type: "network_egress",
      scheme: "https",
      domain: "registry.example.com",
      port: 443
    });

    expect(commands).toEqual([
      {
        type: "edit_approve",
        approvalId: "approval-1",
        replacement: {
          type: "network_egress",
          scheme: "https",
          domain: "registry.example.com",
          port: 443
        }
      }
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

  it("creates a device code with the bearer session", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer browser-session"
      );
      return Response.json({
        code: "ABCDEFGHI",
        payload: "lecoding://device-binding?code=ABCDEFGHI",
        expiresAt: "2026-09-01T10:00:00.000Z",
        projectId: "project-1",
        projectName: "Project One"
      });
    });
    const client = createClient({
      baseUrl: "https://agent.example",
      accessToken: "browser-session",
      fetch: fetch as unknown as typeof globalThis.fetch
    });
    const result = await client.createDeviceCode("project-1", { ttlMs: 600_000 });
    expect(result.code).toBe("ABCDEFGHI");
    expect(result.projectId).toBe("project-1");
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/api/v1/devices/code");
  });

  it("exchanges a device code WITHOUT sending the bearer token", async () => {
    let observedAuthorization: string | null = null;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      observedAuthorization = new Headers(init?.headers).get("authorization");
      return Response.json({
        deviceId: "device-1",
        accessToken: "x".repeat(64),
        userId: "user-1",
        email: "alice@example.com",
        projectId: "project-1",
        projectName: "Project One",
        deviceLabel: "Alice's laptop",
        platform: "darwin",
        expiresAt: "2026-09-01T10:00:00.000Z",
        createdAt: "2026-08-31T10:00:00.000Z"
      });
    });
    const client = createClient({
      baseUrl: "https://agent.example",
      accessToken: "browser-session",
      fetch: fetch as unknown as typeof globalThis.fetch
    });
    const exchanged = await client.exchangeDeviceCode({
      code: "ABCDEFGHI",
      deviceLabel: "Alice's laptop",
      platform: "darwin"
    });
    expect(exchanged.deviceId).toBe("device-1");
    expect(exchanged.accessToken).toBe("x".repeat(64));
    // The exchange MUST NOT carry the browser bearer token, otherwise the
    // device would inherit the user's full session authority.
    expect(observedAuthorization).toBeNull();
    const [url] = fetch.mock.calls[0] as [string];
    expect(url).toContain("/api/v1/devices/exchange");
  });

  it("authenticates later API requests with the persisted device credential", async () => {
    const secureStore = createInMemorySecureStore();
    const token = "d".repeat(64);
    const exchangeClient = createClient({
      baseUrl: "https://agent.example",
      secureStore,
      fetch: async () =>
        Response.json({
          deviceId: "device-1",
          accessToken: token,
          userId: "user-1",
          email: "alice@example.com",
          projectId: "project-1",
          projectName: "Project One",
          deviceLabel: "Alice's laptop",
          platform: "darwin",
          expiresAt: "2099-09-01T10:00:00.000Z",
          createdAt: "2026-08-31T10:00:00.000Z"
        })
    });
    await exchangeClient.exchangeDeviceCode({ code: "ABCDEFGHI" });

    let authorization: string | null = null;
    const restartedClient = createClient({
      baseUrl: "https://agent.example",
      secureStore,
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return Response.json({
          projectId: "project-1",
          projects: [{ id: "project-1", role: "developer" }],
          defaultEnvironmentId: "sandbox-v1"
        });
      }
    });

    await restartedClient.getControlPlaneConfig();
    expect(authorization).toBe(`Bearer ${token}`);
  });

  it("lists and revokes devices through the bearer session", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return Response.json({
        devices: [
          {
            deviceId: "device-1",
            projectId: "project-1",
            projectName: "Project One",
            deviceLabel: "Alice's laptop",
            platform: "darwin",
            createdAt: "2026-08-31T10:00:00.000Z",
            lastUsedAt: "2026-08-31T10:00:00.000Z",
            expiresAt: "2026-09-01T10:00:00.000Z"
          }
        ]
      });
    });
    const client = createClient({
      baseUrl: "https://agent.example",
      accessToken: "browser-session",
      fetch: fetch as unknown as typeof globalThis.fetch
    });
    const listing = await client.listDevices();
    expect(listing.devices).toHaveLength(1);
    expect(listing.devices[0]?.deviceId).toBe("device-1");

    await client.revokeDevice("device-1");
    const deleteCall = (fetch.mock.calls[1] ?? []) as [string, RequestInit?];
    expect(deleteCall[0]).toContain("/api/v1/devices/device-1");
    expect(deleteCall[1]?.method).toBe("DELETE");
  });

  it("surfaces the pre-existing device credential when the Client was constructed with one", async () => {
    const client = createClient({
      baseUrl: "https://agent.example",
      deviceCredential: {
        deviceId: "device-1",
        accessToken: "x".repeat(64),
        userId: "user-1",
        email: "alice@example.com",
        projectId: "project-1",
        projectName: "Project One",
        deviceLabel: "Alice's laptop",
        platform: "darwin",
        expiresAt: "2026-09-01T10:00:00.000Z",
        createdAt: "2026-08-31T10:00:00.000Z"
      }
    });
    expect((await client.deviceCredential())?.deviceId).toBe("device-1");
  });

  it("returns undefined for deviceCredential when none was supplied", async () => {
    const client = createClient({ baseUrl: "https://agent.example" });
    expect(await client.deviceCredential()).toBeUndefined();
  });

  it("maps non-OK responses on device endpoints to LeCodingHttpError", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "code_consumed" }), {
        status: 404,
        headers: { "content-type": "application/json" }
      })
    );
    const client = createClient({
      baseUrl: "https://agent.example",
      fetch: fetch as unknown as typeof globalThis.fetch
    });
    await expect(client.listDevices()).rejects.toBeInstanceOf(LeCodingHttpError);
    await expect(client.createDeviceCode("project-1")).rejects.toBeInstanceOf(
      LeCodingHttpError
    );
    await expect(client.revokeDevice("device-1")).rejects.toBeInstanceOf(
      LeCodingHttpError
    );
    await expect(
      client.exchangeDeviceCode({ code: "ABCDEFGHI" })
    ).rejects.toBeInstanceOf(LeCodingHttpError);
  });
});
