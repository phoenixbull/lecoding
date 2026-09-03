import { describe, expect, it, vi } from "vitest";
import type { RunConsoleController } from "@lecoding/run-controller";
import { createDesktopRendererSession } from "../src/renderer/session.js";
import { createFakeBridge } from "./renderer-bridge.js";

describe("desktop Renderer session", () => {
  it("bootstraps Main before initializing the controller when the user connects", async () => {
    const bridge = createFakeBridge();
    const initialize = vi.fn(async () => undefined);
    const session = createDesktopRendererSession({
      bridge,
      controller: { initialize } as unknown as RunConsoleController
    });

    await session.connect(" https://agent.example/ ");

    expect(bridge.calls[0]).toEqual({
      channel: "session.bootstrap",
      payload: { baseUrl: "https://agent.example/" }
    });
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("bootstraps Main before asking it to open the GitHub login page", async () => {
    const bridge = createFakeBridge();
    const session = createDesktopRendererSession({
      bridge,
      controller: { initialize: vi.fn() } as unknown as RunConsoleController
    });

    await session.openGitHubLogin("https://agent.example");

    expect(bridge.calls).toEqual([
      {
        channel: "session.bootstrap",
        payload: { baseUrl: "https://agent.example" }
      },
      { channel: "session.openGitHubLogin", payload: {} }
    ]);
  });
});
