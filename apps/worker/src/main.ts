import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenAiMalformedJsonRetryEvent } from "@lecoding/openai-model";
import { formatModelRetryLog } from "./index.js";
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

/** Writes only the gateway's stable retry projection, never provider-controlled data. */
function reportModelRetry(event: OpenAiMalformedJsonRetryEvent): void {
  console.warn(formatModelRetryLog(event));
}

const host = createWorkerProcessHost({
  environment: process.env,
  onFatalError: reportFatalWorkerError,
  onModelRetry: reportModelRetry,
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
