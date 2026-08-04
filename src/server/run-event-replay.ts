import type { RunEvent } from "../shared/types";

export function resolveRunEventCursor(after: unknown, lastEventId: string | undefined): number {
  const headerCursor = parseCursor(lastEventId, "Last-Event-ID", false);
  if (headerCursor !== null) {
    return headerCursor;
  }
  return parseCursor(after, "after", true) ?? 0;
}

export interface RunEventCursorPlan {
  after: number;
  canonicalized: boolean;
  noContent: boolean;
}

export function planRunEventCursor(requestedAfter: number, latestSeq: number, terminal: boolean): RunEventCursorPlan {
  if (!Number.isSafeInteger(requestedAfter) || requestedAfter < 0 || !Number.isSafeInteger(latestSeq) || latestSeq < 0) {
    throw new Error("Run event cursors must be non-negative safe integers.");
  }
  const after = Math.min(requestedAfter, latestSeq);
  return { after, canonicalized: after !== requestedAfter, noContent: terminal && after === latestSeq };
}

export function runEventCursorControl(cursor: number): string {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error("Run event cursor must be a non-negative safe integer.");
  }
  return `event: run_cursor\nid: ${cursor}\ndata: ${JSON.stringify({ cursor })}\n\n`;
}

export class OrderedRunEventReplay {
  private readonly buffered: RunEvent[] = [];
  private replaying = true;
  private lastSeq: number;

  constructor(
    private readonly runId: string,
    after: number,
    private readonly emit: (event: RunEvent) => void
  ) {
    this.lastSeq = after;
  }

  pushLive(event: RunEvent): void {
    if (event.runId !== this.runId || event.seq <= this.lastSeq) {
      return;
    }
    if (this.replaying) {
      this.buffered.push(event);
      return;
    }
    this.emitNext(event);
  }

  replay(history: readonly RunEvent[]): void {
    let pending = [...history, ...this.buffered.splice(0)].sort(compareEventSequence);
    while (pending.length > 0) {
      for (const event of pending) {
        this.emitNext(event);
      }
      pending = this.buffered.splice(0).sort(compareEventSequence);
    }
    this.replaying = false;
  }

  get cursor(): number {
    return this.lastSeq;
  }

  private emitNext(event: RunEvent): void {
    if (event.runId !== this.runId || event.seq <= this.lastSeq) {
      return;
    }
    this.lastSeq = event.seq;
    this.emit(event);
  }
}

function compareEventSequence(left: RunEvent, right: RunEvent): number {
  return left.seq - right.seq;
}

function parseCursor(value: unknown, label: string, strict: boolean): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (Array.isArray(value)) {
    if (strict) {
      throw new Error(`${label} must be a single non-negative integer.`);
    }
    return null;
  }
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    if (strict) {
      throw new Error(`${label} must be a non-negative integer.`);
    }
    return null;
  }
  const cursor = Number(text);
  if (!Number.isSafeInteger(cursor)) {
    if (strict) {
      throw new Error(`${label} exceeds the safe integer range.`);
    }
    return null;
  }
  return cursor;
}
