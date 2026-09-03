/**
 * Shared presentation seam for every LeCoding Run console surface.
 *
 * This package is deliberately DOM-free and transport-free: it contains the
 * inert projections that turn untrusted protocol text into display strings,
 * plus the framework-neutral Run event stream follower. Both the Web page and
 * the Electron Renderer consume it so the two surfaces can never drift apart
 * on status semantics, formatting, or reconnect behaviour.
 */

export * from "./presentation.js";
export * from "./run-stream.js";
