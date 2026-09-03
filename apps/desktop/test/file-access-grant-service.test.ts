import { describe, expect, it, vi } from "vitest";
import { createFileAccessGrantService } from "../src/main/file-access-grant-service.js";
import type { DangerConfirmationInput, ElectronHost } from "../src/main/host.js";

const now = () => "2026-09-03T00:00:00.000Z";

interface Recorder {
  host: ElectronHost;
  /** Records the confirmation input so tests can assert the wording. */
  confirmations: DangerConfirmationInput[];
}

function hostWith(
  overrides: {
    select?: (title: string) => Promise<{ paths: string[]; shown: boolean }>;
    confirm?: (input: DangerConfirmationInput) => Promise<boolean>;
  } = {}
): Recorder {
  const confirmations: DangerConfirmationInput[] = [];
  const host = {
    app: {} as never,
    ipcMain: { handle: vi.fn() },
    BrowserWindow: class {} as never,
    setCspHeader: vi.fn(),
    openExternal: vi.fn(),
    ...(overrides.select
      ? {
          selectDirectories: async (options: { title: string }) =>
            await overrides.select!(options.title)
        }
      : {}),
    ...(overrides.confirm
      ? {
          confirmDanger: async (input: DangerConfirmationInput) => {
            confirmations.push(input);
            return await overrides.confirm!(input);
          }
        }
      : {})
  } as unknown as ElectronHost;
  return { host, confirmations };
}

function service(host: ElectronHost) {
  return createFileAccessGrantService({
    host,
    now,
    canonicalize: async (path) => path
  });
}

describe("createFileAccessGrantService", () => {
  it("issues a workspace_only grant without opening any dialog", async () => {
    // No dialog is needed: the worktree is always permitted, so asking the user
    // to pick something would be noise.
    const select = vi.fn();
    const { host } = hostWith({ select });
    const outcome = await service(host).issue({
      runId: "run-1",
      scope: "workspace_only",
      worktreePath: "/work/run-1"
    });

    expect(outcome.granted).toBe(true);
    expect(select).not.toHaveBeenCalled();
    if (outcome.granted) {
      expect(outcome.grant.allowedDirectories).toEqual([]);
    }
  });

  it("takes selected_directories from the OS picker and canonicalizes them", async () => {
    const { host } = hostWith({
      select: async () => ({ paths: ["/shared", "/shared/nested"], shown: true })
    });
    const outcome = await service(host).issue({
      runId: "run-1",
      scope: "selected_directories",
      worktreePath: "/work/run-1"
    });

    expect(outcome.granted).toBe(true);
    if (outcome.granted) {
      // Reduced to the minimal set, so the grant cannot claim more than the
      // user actually saw in the picker.
      expect(outcome.grant.allowedDirectories).toEqual(["/shared"]);
    }
  });

  it("reports cancellation when the user dismisses the picker", async () => {
    const { host } = hostWith({ select: async () => ({ paths: [], shown: true }) });
    await expect(
      service(host).issue({
        runId: "run-1",
        scope: "selected_directories",
        worktreePath: "/work/run-1"
      })
    ).resolves.toEqual({ granted: false, reason: "cancelled" });
  });

  it("fails closed for selected_directories when no picker exists", async () => {
    // A host without a native dialog must refuse rather than accept a typed
    // path: an OS authorization is the whole point of the tier.
    const { host } = hostWith({});
    await expect(
      service(host).issue({
        runId: "run-1",
        scope: "selected_directories",
        worktreePath: "/work/run-1"
      })
    ).resolves.toEqual({ granted: false, reason: "dialog_unavailable" });
  });

  it("fails closed when the picker reported it could not be shown", async () => {
    const { host } = hostWith({
      select: async () => ({ paths: ["/shared"], shown: false })
    });
    await expect(
      service(host).issue({
        runId: "run-1",
        scope: "selected_directories",
        worktreePath: "/work/run-1"
      })
    ).resolves.toEqual({ granted: false, reason: "dialog_unavailable" });
  });

  it("grants host_full only after the acknowledgement", async () => {
    const { host, confirmations } = hostWith({ confirm: async () => true });
    const outcome = await service(host).issue({
      runId: "run-1",
      scope: "host_full",
      worktreePath: "/work/run-1"
    });

    expect(outcome.granted).toBe(true);
    if (outcome.granted) {
      expect(outcome.grant.dangerAcknowledgedAt).toBe(now());
    }
    // The dialog must require an explicit acknowledgement, not just an OK.
    expect(confirmations[0]?.acknowledgementLabel).toMatch(/understand/i);
  });

  it("refuses host_full when the user does not acknowledge", async () => {
    const { host } = hostWith({ confirm: async () => false });
    await expect(
      service(host).issue({
        runId: "run-1",
        scope: "host_full",
        worktreePath: "/work/run-1"
      })
    ).resolves.toEqual({ granted: false, reason: "cancelled" });
  });

  it("refuses host_full when no confirmation dialog exists", async () => {
    // Consent must never be inferred from the absence of a dialog.
    const { host } = hostWith({});
    await expect(
      service(host).issue({
        runId: "run-1",
        scope: "host_full",
        worktreePath: "/work/run-1"
      })
    ).resolves.toEqual({ granted: false, reason: "cancelled" });
  });

  it("refuses when the worktree path cannot be resolved", async () => {
    const failing = createFileAccessGrantService({
      host: hostWith({}).host,
      now,
      canonicalize: async () => {
        throw new Error("ENOENT");
      }
    });
    await expect(
      failing.issue({ runId: "r", scope: "workspace_only", worktreePath: "/missing" })
    ).resolves.toEqual({ granted: false, reason: "dialog_unavailable" });
  });

  it("drops a chosen path that cannot be canonicalized", async () => {
    const failing = createFileAccessGrantService({
      host: hostWith({
        select: async () => ({ paths: ["/broken", "/shared"], shown: true })
      }).host,
      now,
      canonicalize: async (path) => {
        if (path === "/broken") {
          throw new Error("ENOENT");
        }
        return path;
      }
    });
    const outcome = await failing.issue({
      runId: "r",
      scope: "selected_directories",
      worktreePath: "/work/run-1"
    });
    expect(outcome.granted).toBe(true);
    if (outcome.granted) {
      expect(outcome.grant.allowedDirectories).toEqual(["/shared"]);
    }
  });
});
