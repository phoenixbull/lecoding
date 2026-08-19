import { describe, expect, it, vi } from "vitest";
import { createClient } from "../src/index.js";

describe("LeCodingClient", () => {
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
});
