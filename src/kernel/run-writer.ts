import { randomUUID } from "node:crypto";
import type { RunEventBus } from "./event-bus";
import type { StoreAdapter } from "../store/types";
import type { JsonObject, Run, RunEvent, RunEventType, RunUsage } from "../shared/types";
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
  private metadata: JsonObject;
  private usage: RunUsage | null;

  constructor(options: RunWriterOptions) {
    this.store = options.store;
    this.eventBus = options.eventBus;
    this.run = options.run;
    this.assistantMessageId = options.assistantMessageId;
    this.text = options.store.getMessage(options.assistantMessageId)?.parts.map((part) => part.text).join("") ?? "";
    this.metadata = { ...options.run.metadata };
    this.usage = options.run.usage;
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

  writeUsage(usage: RunUsage): void {
    if (this.terminal) {
      return;
    }

    this.usage = mergeRunUsage(this.usage, usage);
    this.writeMetadata({ usage: runUsageToJsonObject(this.usage) });
  }

  writeMetadata(metadata: JsonObject): void {
    if (this.terminal || Object.keys(metadata).length === 0) {
      return;
    }

    const now = new Date().toISOString();
    this.metadata = { ...this.metadata, ...metadata };
    this.store.mergeRunMetadata(this.run.id, metadata, now);
    this.store.mergeMessageMetadata(this.assistantMessageId, metadata, now);
    this.store.touchSession(this.run.sessionId, now);
  }

  complete(): void {
    this.finish("completed", "run_completed", terminalPayload(this.assistantMessageId, this.metadata, this.usage));
  }

  cancel(): void {
    this.finish("cancelled", "run_cancelled", { messageId: this.assistantMessageId });
  }

  fail(error: Error): void {
    const payload = terminalPayload(this.assistantMessageId, this.metadata, this.usage);
    payload.error = error.message;
    this.finish("failed", "run_failed", payload);
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

function terminalPayload(messageId: string, metadata: JsonObject, usage: RunUsage | null): JsonObject {
  const payload: JsonObject = {
    messageId,
    metadata
  };
  if (usage) {
    payload.usage = runUsageToJsonObject(usage);
  }
  return payload;
}

function runUsageToJsonObject(usage: RunUsage): JsonObject {
  const output: JsonObject = {};
  if (typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens)) {
    output.inputTokens = usage.inputTokens;
  }
  if (typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens)) {
    output.outputTokens = usage.outputTokens;
  }
  if (typeof usage.reasoningTokens === "number" && Number.isFinite(usage.reasoningTokens)) {
    output.reasoningTokens = usage.reasoningTokens;
  }
  if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) {
    output.totalTokens = usage.totalTokens;
  }
  return output;
}

function mergeRunUsage(current: RunUsage | null, update: RunUsage): RunUsage {
  const usage: RunUsage = { ...(current ?? {}) };
  if (typeof update.inputTokens === "number" && Number.isFinite(update.inputTokens)) {
    usage.inputTokens = update.inputTokens;
  }
  if (typeof update.outputTokens === "number" && Number.isFinite(update.outputTokens)) {
    usage.outputTokens = update.outputTokens;
  }
  if (typeof update.reasoningTokens === "number" && Number.isFinite(update.reasoningTokens)) {
    usage.reasoningTokens = update.reasoningTokens;
  }
  if (typeof update.totalTokens === "number" && Number.isFinite(update.totalTokens)) {
    usage.totalTokens = update.totalTokens;
  } else if (usage.inputTokens !== undefined && usage.outputTokens !== undefined && usage.totalTokens === undefined) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  return usage;
}

function isErrorPayload(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string";
}
