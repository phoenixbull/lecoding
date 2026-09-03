import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createRunConsoleController } from "@lecoding/run-controller";
import { App } from "./App.js";
import { readBridge } from "./gateway/bridge.js";
import { createIpcRunEventSource } from "./gateway/ipc-event-source.js";
import { createIpcRunGateway } from "./gateway/ipc-gateway.js";
import { createDesktopRendererSession } from "./session.js";
import "./styles/renderer.css";

const bridge = readBridge();

/**
 * Platform reported to the device-binding exchange.
 *
 * The Renderer has no `process`, so the platform is derived from the user
 * agent Electron injects rather than from Node.
 */
function detectPlatform(): "darwin" | "win32" | "linux" {
  const agent = globalThis.navigator?.userAgent ?? "";
  if (agent.includes("Macintosh") || agent.includes("Mac OS")) {
    return "darwin";
  }
  if (agent.includes("Windows")) {
    return "win32";
  }
  return "linux";
}

const controller = createRunConsoleController({
  gateway: createIpcRunGateway(bridge),
  events: createIpcRunEventSource(bridge)
});
const session = createDesktopRendererSession({ bridge, controller });

const container = document.getElementById("root");
if (!container) {
  throw new Error("Renderer root container #root is missing");
}

createRoot(container).render(
  <StrictMode>
    <App
      controller={controller}
      bridge={bridge}
      serverUrl=""
      appVersion={import.meta.env["VITE_APP_VERSION"] ?? "0.0.0"}
      platform={detectPlatform()}
      onConnect={(serverUrl) => {
        void session.connect(serverUrl);
      }}
      onGitHubLogin={(serverUrl) => {
        void session.openGitHubLogin(serverUrl);
      }}
    />
  </StrictMode>
);
