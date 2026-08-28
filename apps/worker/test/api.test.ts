import { describe, expect, it, vi } from "vitest";
import type { RunId, RunView, StartRun } from "@lecoding/contracts";
import {
  createInMemoryRunEventJournal,
  createRunEventLiveBroadcaster,
  createRunEventSseHandler
} from "@lecoding/run-events";
import {
  createRunApiHandler,
  type RunApiAccessControl,
  type RunApiMembershipAdministration
} from "../src/api.js";

describe("createRunApiHandler", () => {
  it("exposes only non-secret registered-project bootstrap configuration", async () => {
    const response = await createHandler(createRuns([])).handle(
      new Request("http://127.0.0.1:8787/api/v1/config")
    );

    await expect(response.json()).resolves.toEqual({
      projectId: "project-1",
      projects: [{ id: "project-1" }, { id: "project-2" }],
      defaultEnvironmentId: "server-docker"
    });
  });

  it("hides every cross-project surface from an authenticated non-member", async () => {
    const runs = createRuns([]);
    runs.inspect.mockResolvedValue({
      id: "run-project-2",
      projectId: "project-2",
      environmentId: "server-docker",
      task: "Project two secret",
      status: "running"
    });
    const history = { list: vi.fn(async () => []) };
    const changes = {
      read: vi.fn(async () => ({ changedFiles: [], unifiedDiff: "", truncated: false }))
    };
    const results = { resolve: vi.fn(async () => undefined) };
    const access = {
      authenticate: vi.fn(async () => ({ userId: "user-alice" })),
      roleFor: vi.fn(async (_userId: string, projectId: string) =>
        projectId === "project-1" ? ("developer" as const) : undefined
      )
    };
    const handler = createHandler(runs, history, changes, results, access);
    const request = (path: string, init?: RequestInit) =>
      handler.handle(new Request(`http://127.0.0.1:8787${path}`, init));

    const config = await request("/api/v1/config");
    const historyIdor = await request("/api/v1/projects/project-2/runs");
    const createIdor = await request("/api/v1/projects/project-2/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        environmentId: "server-docker",
        task: "Steal project",
        acceptanceCriteria: ["Must not run"],
        approvalMode: "manual",
        fileAccessScope: "workspace_only"
      })
    });
    const inspectIdor = await request("/api/v1/runs/run-project-2");
    const eventsIdor = await request("/api/v1/runs/run-project-2/events");
    const changesIdor = await request("/api/v1/runs/run-project-2/changes");
    const resultIdor = await request("/api/v1/runs/run-project-2/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "discard" })
    });
    const commandIdor = await request("/api/v1/runs/run-project-2/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "cancel" })
    });

    await expect(config.json()).resolves.toMatchObject({
      projectId: "project-1",
      projects: [{ id: "project-1" }]
    });
    expect([
      historyIdor.status,
      createIdor.status,
      inspectIdor.status,
      eventsIdor.status,
      changesIdor.status,
      resultIdor.status,
      commandIdor.status
    ]).toEqual([404, 404, 404, 404, 404, 404, 404]);
    expect(history.list).not.toHaveBeenCalled();
    expect(runs.start).not.toHaveBeenCalled();
    expect(runs.command).not.toHaveBeenCalled();
    expect(changes.read).not.toHaveBeenCalled();
    expect(results.resolve).not.toHaveBeenCalled();
  });

  it("creates a configured-project Run and resumes it after returning 202", async () => {
    const calls: string[] = [];
    const runs = createRuns(calls);
    const handler = createHandler(runs);
    const response = await handler.handle(
      new Request("http://127.0.0.1:8787/api/v1/projects/project-1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          environmentId: "server-docker",
          task: "Add health endpoint",
          acceptanceCriteria: ["Tests pass"],
          approvalMode: "manual",
          fileAccessScope: "workspace_only"
        })
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ runId: "run-1" });
    await vi.waitFor(() => expect(calls).toEqual(["start", "resume:run-1"]));
    expect(runs.start).toHaveBeenCalledWith({
      projectId: "project-1",
      environmentId: "server-docker",
      task: "Add health endpoint",
      acceptanceCriteria: ["Tests pass"],
      approvalMode: "manual",
      fileAccessScope: "workspace_only"
    });
  });

  it("lets only a project admin assign a bounded membership role", async () => {
    const memberships = {
      list: vi.fn(async () => []),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined)
    };
    const adminAccess: RunApiAccessControl = {
      authenticate: vi.fn(async () => ({ userId: "admin-user" })),
      roleFor: vi.fn(async () => "admin" as const)
    };
    const developerAccess: RunApiAccessControl = {
      authenticate: vi.fn(async () => ({ userId: "developer-user" })),
      roleFor: vi.fn(async () => "developer" as const)
    };
    const assign = (access: RunApiAccessControl) =>
      createHandler(
        createRuns([]),
        undefined,
        undefined,
        undefined,
        access,
        memberships
      ).handle(
        new Request(
          "http://127.0.0.1:8787/api/v1/projects/project-1/memberships/user-alice",
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ role: "developer" })
          }
        )
      );

    const accepted = await assign(adminAccess);
    const denied = await assign(developerAccess);
    const adminHandler = createHandler(
      createRuns([]),
      undefined,
      undefined,
      undefined,
      adminAccess,
      memberships
    );
    const listed = await adminHandler.handle(
      new Request(
        "http://127.0.0.1:8787/api/v1/projects/project-1/memberships"
      )
    );
    const removed = await adminHandler.handle(
      new Request(
        "http://127.0.0.1:8787/api/v1/projects/project-1/memberships/user-alice",
        { method: "DELETE" }
      )
    );

    expect(accepted.status).toBe(204);
    expect(denied.status).toBe(404);
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({ memberships: [] });
    expect(removed.status).toBe(204);
    expect(memberships.set).toHaveBeenCalledTimes(1);
    expect(memberships.set).toHaveBeenCalledWith({
      projectId: "project-1",
      userId: "user-alice",
      role: "developer"
    });
    expect(memberships.list).toHaveBeenCalledWith("project-1");
    expect(memberships.remove).toHaveBeenCalledWith(
      "project-1",
      "user-alice"
    );
  });

  it("creates a Run for another registered project without accepting unknown identities", async () => {
    const runs = createRuns([]);
    const handler = createHandler(runs);
    const create = (projectId: string) =>
      handler.handle(
        new Request(`http://127.0.0.1:8787/api/v1/projects/${projectId}/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            environmentId: "server-docker",
            task: "Route project",
            acceptanceCriteria: ["Correct repository"],
            approvalMode: "manual",
            fileAccessScope: "workspace_only"
          })
        })
      );

    const registered = await create("project-2");
    const unknown = await create("project-3");

    expect(registered.status).toBe(202);
    expect(unknown.status).toBe(404);
    expect(runs.start).toHaveBeenCalledTimes(1);
    expect(runs.start).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-2" })
    );
  });

  it("lists a bounded history only for the configured project", async () => {
    const runs = createRuns([]);
    const history = {
      list: vi.fn(async () => [
        {
          id: "run-1",
          projectId: "project-1",
          environmentId: "server-docker",
          task: "Add health endpoint",
          status: "running" as const,
          updatedAt: "2026-08-26T07:00:00.000Z"
        }
      ])
    };
    const handler = createHandler(runs, history);

    const response = await handler.handle(
      new Request("http://127.0.0.1:8787/api/v1/projects/project-1/runs?limit=10")
    );
    const wrongProject = await handler.handle(
      new Request("http://127.0.0.1:8787/api/v1/projects/other/runs?limit=10")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runs: [{ id: "run-1", status: "running" }]
    });
    expect(history.list).toHaveBeenCalledWith("project-1", 10);
    expect(wrongProject.status).toBe(404);
  });

  it("inspects and cancels a Run through stable endpoints", async () => {
    const calls: string[] = [];
    const runs = createRuns(calls);
    const handler = createHandler(runs);

    const inspected = await handler.handle(
      new Request("http://127.0.0.1:8787/api/v1/runs/run-1")
    );
    const cancelled = await handler.handle(
      new Request("http://127.0.0.1:8787/api/v1/runs/run-1/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "cancel" })
      })
    );

    expect(inspected.status).toBe(200);
    await expect(inspected.json()).resolves.toMatchObject({
      id: "run-1",
      status: "running"
    });
    expect(cancelled.status).toBe(202);
    expect(runs.command).toHaveBeenCalledWith("run-1", { type: "cancel" });
  });

  it("returns bounded changes only after project ownership is verified", async () => {
    const runs = createRuns([]);
    const changes = {
      read: vi.fn(async () => ({
        changedFiles: ["src/main.ts"],
        unifiedDiff: "@@ -1 +1 @@\n-old\n+new\n",
        truncated: false
      }))
    };
    const handler = createHandler(runs, undefined, changes);

    const response = await handler.handle(
      new Request("http://127.0.0.1:8787/api/v1/runs/run-1/changes")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      changedFiles: ["src/main.ts"],
      truncated: false
    });
    expect(changes.read).toHaveBeenCalledWith("run-1");
  });

  it("discards a terminal Run result through the versioned result endpoint", async () => {
    const runs = createRuns([]);
    runs.inspect.mockResolvedValue({
      id: "run-1",
      projectId: "project-1",
      environmentId: "server-docker",
      task: "Finished task",
      status: "succeeded"
    });
    const results = { resolve: vi.fn(async () => undefined) };
    const handler = createHandler(runs, undefined, undefined, results);

    const response = await handler.handle(
      new Request("http://127.0.0.1:8787/api/v1/runs/run-1/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome: "discard" })
      })
    );

    expect(response.status).toBe(204);
    expect(results.resolve).toHaveBeenCalledWith("run-1", "discard");
  });

  it("rejects result resolution before the Run reaches a terminal state", async () => {
    const results = { resolve: vi.fn(async () => undefined) };
    const handler = createHandler(createRuns([]), undefined, undefined, results);

    const response = await handler.handle(
      new Request("http://127.0.0.1:8787/api/v1/runs/run-1/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome: "discard" })
      })
    );

    expect(response.status).toBe(409);
    expect(results.resolve).not.toHaveBeenCalled();
  });

  it("accepts only single-call approval and rejection commands", async () => {
    const runs = createRuns([]);
    const handler = createHandler(runs);
    const command = (body: unknown) =>
      handler.handle(
        new Request("http://127.0.0.1:8787/api/v1/runs/run-1/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        })
      );

    const approved = await command({
      type: "approve",
      approvalId: "approval-1",
      scope: "once"
    });
    const rejected = await command({
      type: "reject",
      approvalId: "approval-2",
      scope: "once"
    });
    const broadScope = await command({
      type: "approve",
      approvalId: "approval-1",
      scope: "run"
    });

    expect([approved.status, rejected.status, broadScope.status]).toEqual([
      202, 202, 409
    ]);
    expect(runs.command).toHaveBeenNthCalledWith(1, "run-1", {
      type: "approve",
      approvalId: "approval-1",
      scope: "once"
    });
    expect(runs.command).toHaveBeenNthCalledWith(2, "run-1", {
      type: "reject",
      approvalId: "approval-2",
      scope: "once"
    });
  });

  it("accepts strict user answers and waiting-turn steering", async () => {
    const runs = createRuns([]);
    const handler = createHandler(runs);
    const command = (body: unknown) =>
      handler.handle(
        new Request("http://127.0.0.1:8787/api/v1/runs/run-1/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        })
      );

    const answered = await command({
      type: "answer",
      commandId: "answer-command-1",
      requestId: "question-1",
      value: "Keep /api/v1"
    });
    const steered = await command({
      type: "steer",
      commandId: "steer-command-1",
      message: "Also preserve errors"
    });
    const invalid = await command({ type: "answer", requestId: "", value: "x" });
    const oversized = await command({
      type: "steer",
      commandId: "steer-command-2",
      message: "x".repeat(4_001)
    });

    expect([answered.status, steered.status, invalid.status, oversized.status]).toEqual([
      202, 202, 409, 409
    ]);
    expect(runs.command).toHaveBeenNthCalledWith(1, "run-1", {
      type: "answer",
      commandId: "answer-command-1",
      requestId: "question-1",
      value: "Keep /api/v1"
    });
    expect(runs.command).toHaveBeenNthCalledWith(2, "run-1", {
      type: "steer",
      commandId: "steer-command-1",
      message: "Also preserve errors"
    });
  });

  it("rejects an unknown project and malformed create body without starting work", async () => {
    const calls: string[] = [];
    const runs = createRuns(calls);
    const handler = createHandler(runs);
    const wrongProject = await handler.handle(
      new Request("http://127.0.0.1:8787/api/v1/projects/other/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    );
    const malformed = await handler.handle(
      new Request("http://127.0.0.1:8787/api/v1/projects/project-1/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "" })
      })
    );

    expect(wrongProject.status).toBe(404);
    expect(malformed.status).toBe(400);
    expect(runs.start).not.toHaveBeenCalled();
  });

  it("hides and refuses Runs owned by another project", async () => {
    const runs = createRuns([]);
    runs.inspect.mockResolvedValue({
      id: "run-other",
      projectId: "project-3",
      environmentId: "server-docker",
      task: "Secret task",
      status: "running"
    });
    const handler = createHandler(runs);

    const inspected = await handler.handle(
      new Request("http://127.0.0.1:8787/api/v1/runs/run-other")
    );
    const events = await handler.handle(
      new Request("http://127.0.0.1:8787/api/v1/runs/run-other/events")
    );
    const command = await handler.handle(
      new Request("http://127.0.0.1:8787/api/v1/runs/run-other/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "cancel" })
      })
    );

    expect([inspected.status, events.status, command.status]).toEqual([
      404, 404, 404
    ]);
    expect(runs.command).not.toHaveBeenCalled();
  });

  it("delegates resumable event requests to the SSE handler", async () => {
    const journal = createInMemoryRunEventJournal({
      now: () => "2026-08-26T00:00:00.000Z"
    });
    await journal.publish({
      runId: "run-1",
      type: "status_changed",
      data: { status: "queued" }
    });
    const eventStream = createRunEventSseHandler({
      journal,
      broadcaster: createRunEventLiveBroadcaster()
    });
    const runs = createRuns([]);
    const handler = createRunApiHandler({
      defaultProjectId: "project-1",
      projectIds: ["project-1", "project-2"],
      runs,
      history: { list: vi.fn(async () => []) },
      changes: { read: vi.fn(async () => ({ changedFiles: [], unifiedDiff: "", truncated: false })) },
      results: { resolve: vi.fn(async () => undefined) },
      access: {
        authenticate: vi.fn(async () => ({ userId: "local-user" })),
        roleFor: vi.fn(async () => "admin" as const)
      },
      eventStream
    });
    const response = await handler.handle(
      new Request("http://127.0.0.1:8787/api/v1/runs/run-1/events")
    );
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(first).toContain("event: status_changed");
    // Closing the browser-owned stream must not become a Run cancellation command.
    expect(runs.command).not.toHaveBeenCalled();
  });
});

function createRuns(calls: string[]) {
  return {
    start: vi.fn(async (_input: StartRun) => {
      calls.push("start");
      return "run-1" as RunId;
    }),
    resume: vi.fn(async (runId: RunId) => {
      calls.push(`resume:${runId}`);
    }),
    command: vi.fn(async () => undefined),
    inspect: vi.fn(async (): Promise<RunView> => ({
      id: "run-1",
      projectId: "project-1",
      environmentId: "server-docker",
      task: "Add health endpoint",
      status: "running"
    }))
  };
}

function createHandler(
  runs: ReturnType<typeof createRuns>,
  history = { list: vi.fn(async () => []) },
  changes = { read: vi.fn(async () => ({ changedFiles: [], unifiedDiff: "", truncated: false })) },
  results = { resolve: vi.fn(async () => undefined) },
  access: RunApiAccessControl = {
    authenticate: vi.fn(async () => ({ userId: "local-user" })),
    roleFor: vi.fn(async () => "admin" as const)
  },
  memberships?: RunApiMembershipAdministration
) {
  return createRunApiHandler({
    defaultProjectId: "project-1",
    projectIds: ["project-1", "project-2"],
    runs,
    history,
    changes,
    results,
    access,
    ...(memberships ? { memberships } : {}),
    eventStream: {
      handle: vi.fn(async () => new Response("", { status: 200 }))
    }
  });
}
