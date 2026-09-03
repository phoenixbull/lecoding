/**
 * @vitest-environment jsdom
 *
 * Renderer test for the local isolation notice (M2.4).
 *
 * Written with the same Testing Library approach as `renderer-app.test.tsx`:
 * assertions go through the accessibility tree rather than class names, so a
 * styling change cannot silently break the notice.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LocalIsolationNotice } from "../src/renderer/components/LocalIsolationNotice.js";
import type { RunnerStatePush } from "../src/shared/ipc-contract.js";

/** Builds a runner status push; `sandbox` may be partially overridden. */
function runnerState(
  overrides: Partial<Omit<RunnerStatePush, "sandbox">> & {
    sandbox?: Partial<RunnerStatePush["sandbox"]>;
  } = {}
): RunnerStatePush {
  const { sandbox, ...rest } = overrides;
  return {
    state: "live",
    sandbox: {
      platform: "darwin",
      tiers: {
        workspace_only: "kernel",
        selected_directories: "kernel",
        host_full: "acknowledged_unrestricted"
      },
      detail: "Seatbelt available",
      isolationGaps: [],
      ...sandbox
    },
    ...rest
  };
}

function renderNotice(props: Parameters<typeof LocalIsolationNotice>[0]) {
  render(<LocalIsolationNotice {...props} />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LocalIsolationNotice", () => {
  it("lists every isolation gap the host cannot provide", () => {
    renderNotice({
      runner: runnerState({
        sandbox: {
          platform: "win32",
          tiers: {
            workspace_only: "argv_fence",
            selected_directories: "argv_fence",
            host_full: "acknowledged_unrestricted"
          },
          detail: "Job Object",
          isolationGaps: [
            "No CPU limit: a Run can use all cores on this machine.",
            "File access is enforced when a command is created, not by the kernel."
          ]
        }
      }),
      dismissed: false,
      onDismiss: () => undefined
    });

    const notice = screen.getByRole("status");
    // The gaps are stated in words the user can act on, not as a jargon level.
    expect(notice.textContent).toContain("No CPU limit");
    expect(notice.textContent).toContain("not by the kernel");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("stays hidden when there is nothing to disclose", () => {
    // An empty notice would be noise, and would imply the host is as confined
    // as a container, which is exactly the claim M2.4 forbids.
    renderNotice({
      runner: runnerState({ sandbox: { isolationGaps: [] } }),
      dismissed: false,
      onDismiss: () => undefined
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays hidden once dismissed", () => {
    renderNotice({
      runner: runnerState(),
      dismissed: true,
      onDismiss: () => undefined
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays hidden when local execution is unavailable", () => {
    renderNotice({
      runner: runnerState({ state: "unavailable" }),
      dismissed: false,
      onDismiss: () => undefined
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not render when no runner state has arrived yet", () => {
    renderNotice({ runner: undefined, dismissed: false, onDismiss: () => undefined });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reports the dismissal through the callback", async () => {
    const onDismiss = vi.fn();
    renderNotice({
      runner: runnerState({
        sandbox: { isolationGaps: ["No memory limit: a Run can exhaust system memory."] }
      }),
      dismissed: false,
      onDismiss
    });
    // Testing Library's user-event shim is not in the dependency set, so the
    // click is dispatched directly; the assertion is on the callback, not the
    // event machinery.
    screen.getByTestId("local-isolation-dismiss").click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
