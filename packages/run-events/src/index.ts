import {
  parseRunEvent,
  type JsonValue,
  type RunEventType,
  type RunEventV1,
  type RunId
} from "@lecoding/contracts";

/** Input accepted from RunEngine before sequence and timestamp are assigned. */
export interface PublishRunEvent {
  runId: RunId;
  type: RunEventType;
  data: JsonValue;
}

/** Storage input whose sequence must be allocated atomically by the repository. */
export interface AppendRunEvent extends PublishRunEvent {
  version: 1;
  occurredAt: string;
}

/**
 * Persistence seam for future in-memory and PostgreSQL adapters.
 * append must allocate a strictly increasing sequence independently per Run.
 */
export interface RunEventRepository {
  append(input: AppendRunEvent): Promise<RunEventV1>;
  readAfter(runId: RunId, sequence: number): Promise<RunEventV1[]>;
}

/** Public event module used by RunEngine and HTTP SSE handlers. */
export interface RunEventJournal {
  publish(input: PublishRunEvent): Promise<RunEventV1>;
  resume(runId: RunId, lastEventId?: string): Promise<string>;
}

export interface RunEventJournalOptions {
  repository: RunEventRepository;
  /** Injected clock keeps persisted timestamps deterministic in tests. */
  now(): string;
}

/** Creates the event module while keeping storage and time behind replaceable seams. */
export function createRunEventJournal(
  options: RunEventJournalOptions
): RunEventJournal {
  return new DefaultRunEventJournal(options);
}

/** Convenience factory for tests and single-process development. */
export function createInMemoryRunEventJournal(options: {
  now(): string;
}): RunEventJournal {
  return createRunEventJournal({
    repository: new InMemoryRunEventRepository(),
    now: options.now
  });
}

class DefaultRunEventJournal implements RunEventJournal {
  constructor(private readonly options: RunEventJournalOptions) {}

  async publish(input: PublishRunEvent): Promise<RunEventV1> {
    return this.options.repository.append({
      version: 1,
      ...input,
      occurredAt: this.options.now()
    });
  }

  async resume(runId: RunId, lastEventId?: string): Promise<string> {
    const sequence = parseLastEventId(lastEventId);
    const events = await this.options.repository.readAfter(runId, sequence);
    return events.map(encodeSseEvent).join("");
  }
}

/**
 * Development adapter. The append body has no await point, so sequence allocation
 * is atomic within one JavaScript process; PostgreSQL will enforce this in SQL.
 */
class InMemoryRunEventRepository implements RunEventRepository {
  private readonly eventsByRun = new Map<RunId, RunEventV1[]>();

  async append(input: AppendRunEvent): Promise<RunEventV1> {
    const events = this.eventsByRun.get(input.runId) ?? [];
    // Construct fields in protocol order so logs and SSE snapshots remain stable.
    const event = parseRunEvent({
      version: 1,
      sequence: events.length + 1,
      runId: input.runId,
      type: input.type,
      occurredAt: input.occurredAt,
      data: input.data
    });
    events.push(event);
    this.eventsByRun.set(input.runId, events);
    return structuredClone(event);
  }

  async readAfter(runId: RunId, sequence: number): Promise<RunEventV1[]> {
    const events = this.eventsByRun.get(runId) ?? [];
    return events
      .filter((event) => event.sequence > sequence)
      .map((event) => structuredClone(event));
  }
}

/** Last-Event-ID is a sequence cursor, never an arbitrary storage identifier. */
function parseLastEventId(lastEventId: string | undefined): number {
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

/** Encodes one complete SSE frame; JSON prevents embedded newlines from splitting data fields. */
function encodeSseEvent(event: RunEventV1): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

// PostgreSQL adapters are exported from the package seam alongside the journal.
export * from "./postgres.js";
export * from "./dispatcher.js";
