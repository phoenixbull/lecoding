import { describe, expect, it, vi } from "vitest";
import {
  createDeviceBindingService,
  createInMemoryDeviceBindingStore
} from "@lecoding/device-binding";
import { createDeviceAwareAccessControl } from "../src/device-access.js";

describe("device-aware Worker access control", () => {
  it("authenticates a bound device bearer when no browser session matches", async () => {
    const devices = createDeviceBindingService({
      store: createInMemoryDeviceBindingStore(),
      now: () => new Date("2026-09-03T00:00:00.000Z")
    });
    const issued = await devices.issueCode({
      userId: "user-1",
      email: "alice@example.com",
      projectId: "project-1",
      projectName: "Project One"
    });
    const device = await devices.exchangeCode({ code: issued.code });
    const roleFor = vi.fn(async () => "developer" as const);
    const access = createDeviceAwareAccessControl({
      sessions: { authenticate: async () => undefined, roleFor },
      devices
    });

    const principal = await access.authenticate(
      new Request("https://agent.example/api/v1/config", {
        headers: { authorization: `Bearer ${device.accessToken}` }
      })
    );

    expect(principal).toEqual({ userId: "user-1", email: "alice@example.com" });
    await expect(access.roleFor("user-1", "project-1")).resolves.toBe("developer");
  });
});
