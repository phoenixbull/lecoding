/**
 * Event-source port consumed by the Run console controller.
 *
 * The canonical definition lives in `@lecoding/presentation` because that is
 * where the stream follower (and therefore the strictest consumer of the
 * contract) lives. Re-exporting it here keeps every controller caller on one
 * import path instead of making them know which package owns the type.
 */
export type { RunEventSource } from "@lecoding/presentation";
