/**
 * Shared Run console state machine.
 *
 * This package owns every Run-management behaviour and exposes it behind two
 * ports: `RunGateway` for commands and `RunEventSource` for the durable event
 * stream. It has no DOM, no React, and no transport code, so the Web page and
 * the Electron Renderer can share one definition of the Run lifecycle.
 */

export {
  createRunConsoleController,
  type RunConsoleController,
  type RunConsoleControllerOptions
} from "./controller.js";
export type { RunEventSource } from "./events.js";
export {
  isNotFound,
  isUnauthorized,
  type DeviceCodeResult,
  type DeviceExchangeInput,
  type DeviceListing,
  type DeviceSummary,
  type RunGateway
} from "./gateway.js";
export {
  createInitialRunConsoleState,
  type ComposerDraft,
  type ConsolePhase,
  type CredentialBackend,
  type CredentialState,
  type RunConsoleState,
  type StreamPhase
} from "./state.js";
