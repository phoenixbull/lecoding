import type { RunConsoleController } from "@lecoding/run-controller";
import type { LeCodingBridge } from "./gateway/bridge.js";

/** Dependencies owned by the production Renderer composition root. */
export interface DesktopRendererSessionOptions {
  bridge: LeCodingBridge;
  controller: RunConsoleController;
}

/**
 * Connection actions exposed to the React view.
 *
 * Main must be bootstrapped before the controller performs any API request;
 * callers therefore await `connect` as one ordered transition rather than
 * invoking the bridge and controller independently.
 */
export interface DesktopRendererSession {
  connect(serverUrl: string): Promise<void>;
  openGitHubLogin(serverUrl: string): Promise<void>;
}

/** Creates the production connection transition used by the Renderer entry. */
export function createDesktopRendererSession(
  options: DesktopRendererSessionOptions
): DesktopRendererSession {
  return {
    async connect(serverUrl): Promise<void> {
      const baseUrl = serverUrl.trim();
      if (baseUrl === "") {
        throw new Error("A server URL is required");
      }
      // `config.load` is the controller's first request, so SDK construction in
      // Main must complete before initialization begins.
      await options.bridge["session.bootstrap"]({ baseUrl });
      await options.controller.initialize();
    },
    async openGitHubLogin(serverUrl): Promise<void> {
      const baseUrl = serverUrl.trim();
      if (baseUrl === "") {
        throw new Error("A server URL is required");
      }
      // Main derives the OAuth URL and owns the OS-shell capability. Renderer
      // supplies only the selected control-plane origin.
      await options.bridge["session.bootstrap"]({ baseUrl });
      await options.bridge["session.openGitHubLogin"]({});
    }
  };
}
