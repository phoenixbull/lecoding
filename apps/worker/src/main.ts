import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadWorkerHttpConfig,
  startWorkerHttpServer
} from "./http-server.js";
import { createWorkerProcessHost } from "./worker-host.js";

/** Reports only a stable message so database credentials cannot leak via errors. */
function reportFatalWorkerError(): void {
  process.exitCode = 1;
  console.error("LeCoding Worker stopped because of a fatal lifecycle error");
}

const host = createWorkerProcessHost({
  environment: process.env,
  onFatalError: reportFatalWorkerError,
  async startControlPlane(control) {
    const server = await startWorkerHttpServer({
      ...loadWorkerHttpConfig(process.env),
      control,
      webRoot: resolve(
        fileURLToPath(new URL("../../web/dist", import.meta.url))
      ),
      onBackgroundError: reportFatalWorkerError
    });
    console.log(`LeCoding Web/API listening at ${server.origin}`);
    return server;
  }
});

void host.start().catch(reportFatalWorkerError);
