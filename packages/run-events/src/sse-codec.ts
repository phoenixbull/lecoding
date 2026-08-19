import type { RunEventV1 } from "@lecoding/contracts";

/** Last-Event-ID is a sequence cursor, never an arbitrary storage identifier. */
export function parseRunEventCursor(lastEventId: string | undefined): number {
  if (lastEventId === undefined || lastEventId === "") {
    return 0;
  }
  if (!/^(0|[1-9]\d*)$/.test(lastEventId)) {
    throw new Error("Invalid Last-Event-ID");
  }
  const sequence = Number(lastEventId);
  if (!Number.isSafeInteger(sequence)) {
    throw new Error("Invalid Last-Event-ID");
  }
  return sequence;
}

/** Encodes one complete SSE frame without allowing payload newlines to split fields. */
export function encodeRunEventSse(event: RunEventV1): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
