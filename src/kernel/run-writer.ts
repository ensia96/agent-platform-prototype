import { randomUUID } from "node:crypto";
import type { RunEventBus } from "./event-bus";
import type { StoreAdapter } from "../store/types";
import type { Run, RunEvent, RunEventType } from "../shared/types";
import type { ProviderRunWriter } from "../providers/types";

export interface RunWriterOptions {
  store: StoreAdapter;
  eventBus: RunEventBus;
  run: Run;
  assistantMessageId: string;
}

export class RunWriter implements ProviderRunWriter {
  private readonly store: StoreAdapter;
  private readonly eventBus: RunEventBus;
  private readonly run: Run;
  private readonly assistantMessageId: string;
  private text = "";
  private terminal = false;

  constructor(options: RunWriterOptions) {
    this.store = options.store;
    this.eventBus = options.eventBus;
    this.run = options.run;
    this.assistantMessageId = options.assistantMessageId;
    this.text = options.store.getMessage(options.assistantMessageId)?.parts.map((part) => part.text).join("") ?? "";
  }

  writeDelta(delta: string): void {
    if (this.terminal || delta.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    this.text += delta;
    this.store.upsertMessageTextPart({
      id: randomUUID(),
      messageId: this.assistantMessageId,
      text: this.text,
      updatedAt: now
    });
    this.store.touchSession(this.run.sessionId, now);
    this.emit("delta", {
      messageId: this.assistantMessageId,
      text: delta
    });
  }

  complete(): void {
    this.finish("completed", "run_completed", { messageId: this.assistantMessageId });
  }

  cancel(): void {
    this.finish("cancelled", "run_cancelled", { messageId: this.assistantMessageId });
  }

  fail(error: Error): void {
    this.finish("failed", "run_failed", {
      messageId: this.assistantMessageId,
      error: error.message
    });
  }

  private finish(status: "completed" | "cancelled" | "failed", eventType: RunEventType, payload: unknown): void {
    if (this.terminal) {
      return;
    }

    this.terminal = true;
    const now = new Date().toISOString();
    const error = status === "failed" && isErrorPayload(payload) ? payload.error : null;
    this.store.updateMessageStatus(this.assistantMessageId, status, now, error);
    this.store.updateRunStatus(this.run.id, status, error, now);
    this.store.touchSession(this.run.sessionId, now);
    this.emit(eventType, payload);
  }

  private emit(type: RunEventType, payload: unknown): RunEvent {
    const event = this.store.appendEvent({
      id: randomUUID(),
      runId: this.run.id,
      sessionId: this.run.sessionId,
      type,
      createdAt: new Date().toISOString(),
      payload
    });
    this.eventBus.publish(event);
    return event;
  }
}

function isErrorPayload(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string";
}
