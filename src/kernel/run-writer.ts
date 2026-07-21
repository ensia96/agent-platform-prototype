import { randomUUID } from "node:crypto";
import type { RunEventBus } from "./event-bus";
import type { StoreAdapter } from "../store/types";
import type { JsonObject, Message, MessagePart, MessagePartType, Run, RunEvent, RunEventType, RunUsage } from "../shared/types";
import type {
  ProviderMessagePartInput,
  ProviderReasoningDetailRecord,
  ProviderReasoningProvenance,
  ProviderReasoningSummaryRecord,
  ProviderRunWriter,
  ProviderToolCallRecord,
  ProviderToolResultRecord
} from "../providers/types";

type ReasoningPartType = "reasoning_summary" | "reasoning_detail";

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
  private readonly priorUsage: RunUsage | null;
  private turnUsage: RunUsage | null = null;
  private usage: RunUsage | null;
  private readonly reasoningPartIds: Record<ReasoningPartType, string | null>;

  constructor(options: RunWriterOptions) {
    this.store = options.store;
    this.eventBus = options.eventBus;
    this.run = options.run;
    this.assistantMessageId = options.assistantMessageId;
    const assistantMessage = options.store.getMessage(options.assistantMessageId);
    this.text = assistantMessage?.parts.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
    this.metadata = { ...options.run.metadata };
    this.priorUsage = options.run.usage ? { ...options.run.usage } : null;
    this.usage = this.priorUsage;
    this.reasoningPartIds = {
      reasoning_summary: assistantMessage?.parts.find((part) => part.type === "reasoning_summary")?.id ?? null,
      reasoning_detail: assistantMessage?.parts.find((part) => part.type === "reasoning_detail")?.id ?? null
    };
  }

  get messageId(): string {
    return this.assistantMessageId;
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

    this.turnUsage = mergeRunUsage(this.turnUsage, usage);
    this.usage = sumRunUsage(this.priorUsage, this.turnUsage);
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

  appendMessagePart(input: ProviderMessagePartInput): MessagePart {
    return this.appendStructuredPart({
      type: input.type,
      text: input.text,
      content: input.content,
      metadata: input.metadata
    });
  }

  writeReasoningSummary(input: ProviderReasoningSummaryRecord): MessagePart | null {
    return this.writeReasoningSnapshot("reasoning_summary", "summary", input.summary, input.usage, input.provenance);
  }

  writeReasoningDetail(input: ProviderReasoningDetailRecord): MessagePart | null {
    return this.writeReasoningSnapshot("reasoning_detail", "detail", input.detail, input.usage, input.provenance);
  }

  private writeReasoningSnapshot(
    type: ReasoningPartType,
    contentKey: "summary" | "detail",
    value: string | undefined,
    usage: RunUsage | undefined,
    provenance: ProviderReasoningProvenance
  ): MessagePart | null {
    const text = value?.trim();
    if (!text || this.terminal) {
      return null;
    }

    const content: JsonObject = { [contentKey]: text };
    if (usage) {
      content.usage = runUsageToJsonObject(usage);
    }

    const metadata = reasoningMetadata(provenance);
    const now = new Date().toISOString();
    const partId = this.reasoningPartIds[type];
    let part = partId
      ? this.store.updateMessagePart({
          id: partId,
          text,
          content,
          metadata,
          updatedAt: now
        })
      : null;

    if (!part) {
      part = this.appendStructuredPart({
        type,
        text,
        content,
        metadata
      });
      this.reasoningPartIds[type] = part.id;
    } else {
      this.store.touchSession(this.run.sessionId, now);
    }

    const message = this.store.getMessage(this.assistantMessageId);
    if (message) {
      this.emit("assistant_message_updated", { message });
    }
    return part;
  }

  recordToolCall(input: ProviderToolCallRecord): MessagePart {
    const callId = input.callId?.trim() || randomUUID();
    const toolId = input.toolId.trim();
    const content: JsonObject = {
      callId,
      toolId,
      status: "created"
    };
    if (input.toolName?.trim()) {
      content.toolName = input.toolName.trim();
    }
    if (input.provider?.trim()) {
      content.provider = input.provider.trim();
    }
    if (input.input) {
      content.input = input.input;
    }
    if (input.inputSummary?.trim()) {
      content.inputSummary = input.inputSummary.trim();
    }

    const part = this.appendStructuredPart({
      type: "tool_call",
      text: input.inputSummary?.trim() || `Tool call: ${input.toolName?.trim() || toolId}`,
      content,
      metadata: input.metadata
    });
    this.emit("tool_call.created", {
      messageId: this.assistantMessageId,
      partId: part.id,
      part,
      callId,
      toolId,
      ...(input.toolName?.trim() ? { toolName: input.toolName.trim() } : {})
    });
    return part;
  }

  recordToolResult(input: ProviderToolResultRecord): MessagePart {
    const status = input.status ?? (input.error ? "failed" : "completed");
    const content: JsonObject = {
      callId: input.callId,
      status
    };
    if (input.toolId?.trim()) {
      content.toolId = input.toolId.trim();
    }
    if (input.toolName?.trim()) {
      content.toolName = input.toolName.trim();
    }
    if (input.output !== undefined) {
      content.output = input.output;
    }
    if (input.outputSummary?.trim()) {
      content.outputSummary = input.outputSummary.trim();
    }
    if (input.error?.trim()) {
      content.error = input.error.trim();
    }

    const part = this.appendStructuredPart({
      type: "tool_result",
      text: input.outputSummary?.trim() || input.output || input.error || `Tool result: ${status}`,
      content,
      metadata: input.metadata
    });
    this.emit("tool_result.created", {
      messageId: this.assistantMessageId,
      partId: part.id,
      part,
      callId: input.callId,
      status,
      ...(input.toolId?.trim() ? { toolId: input.toolId.trim() } : {}),
      ...(input.toolName?.trim() ? { toolName: input.toolName.trim() } : {})
    });
    return part;
  }

  recordCommandOutput(input: {
    commandId?: string;
    callId?: string;
    stream?: "stdout" | "stderr" | "combined";
    text: string;
    exitCode?: number;
    cwd?: string;
    truncated?: boolean;
    metadata?: JsonObject;
  }): MessagePart {
    const content: JsonObject = {
      text: input.text
    };
    if (input.commandId?.trim()) {
      content.commandId = input.commandId.trim();
    }
    if (input.callId?.trim()) {
      content.callId = input.callId.trim();
    }
    if (input.stream) {
      content.stream = input.stream;
    }
    if (typeof input.exitCode === "number" && Number.isFinite(input.exitCode)) {
      content.exitCode = input.exitCode;
    }
    if (input.cwd?.trim()) {
      content.cwd = input.cwd.trim();
    }
    if (input.truncated !== undefined) {
      content.truncated = input.truncated;
    }

    return this.appendStructuredPart({
      type: "command_output",
      text: input.text,
      content,
      metadata: input.metadata
    });
  }

  complete(): void {
    this.finish("completed", "run_completed", terminalPayload(this.assistantMessageId, this.metadata, this.usage));
  }

  completeMessage(): Message | null {
    if (this.terminal) {
      return this.store.getMessage(this.assistantMessageId);
    }

    this.terminal = true;
    const now = new Date().toISOString();
    this.store.updateMessageStatus(this.assistantMessageId, "completed", now, null);
    this.store.touchSession(this.run.sessionId, now);
    const message = this.store.getMessage(this.assistantMessageId);
    if (message) {
      this.emit("assistant_message_updated", { message });
    }
    return message;
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

  private appendStructuredPart(input: {
    type: MessagePartType;
    text?: string;
    content?: JsonObject;
    metadata?: JsonObject;
  }): MessagePart {
    if (this.terminal) {
      throw new Error("Cannot append a message part after the run has finished.");
    }

    const now = new Date().toISOString();
    const content = input.content ?? {};
    const part = this.store.addMessagePart({
      id: randomUUID(),
      messageId: this.assistantMessageId,
      seq: this.nextStructuredPartSeq(),
      type: input.type,
      text: input.text ?? structuredPartFallbackText(input.type, content),
      content,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now
    });
    this.store.touchSession(this.run.sessionId, now);
    return part;
  }

  private nextStructuredPartSeq(): number {
    const parts = this.store.getMessage(this.assistantMessageId)?.parts ?? [];
    return Math.max(1, ...parts.map((part) => part.seq + 1));
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

function structuredPartFallbackText(type: MessagePartType, content: JsonObject): string {
  const text = stringField(content, "text");
  if (text) {
    return text;
  }

  if (type === "text") {
    return stringField(content, "text");
  }
  if (type === "error") {
    return stringField(content, "message") || "Error recorded.";
  }
  if (type === "reasoning_summary") {
    return stringField(content, "summary") || "Reasoning metadata recorded.";
  }
  if (type === "reasoning_detail") {
    return stringField(content, "detail") || "Reasoning detail recorded.";
  }
  if (type === "tool_call") {
    return stringField(content, "inputSummary") || `Tool call: ${stringField(content, "toolName") || stringField(content, "toolId") || "unknown"}`;
  }
  if (type === "tool_result") {
    return stringField(content, "outputSummary") || stringField(content, "output") || stringField(content, "error") || "Tool result recorded.";
  }
  if (type === "command_output") {
    return stringField(content, "text") || "Command output recorded.";
  }
  if (type === "file_ref") {
    return stringField(content, "path") || stringField(content, "uri") || stringField(content, "name") || "File reference recorded.";
  }
  return "Structured message part recorded.";
}

function stringField(object: JsonObject, key: string): string {
  const value = object[key];
  return typeof value === "string" ? value : "";
}

function reasoningMetadata(provenance: ProviderReasoningProvenance): JsonObject {
  const metadata: JsonObject = { providerSupplied: true };
  const provider = sanitizedMetadataString(provenance.provider, 120);
  const nativeEventType = sanitizedMetadataString(provenance.nativeEventType, 160);
  const itemId = sanitizedMetadataString(provenance.itemId, 160);
  if (provider) {
    metadata.provider = provider;
  }
  if (nativeEventType) {
    metadata.nativeEventType = nativeEventType;
  }
  if (itemId) {
    metadata.itemId = itemId;
  }
  if (typeof provenance.outputIndex === "number" && Number.isInteger(provenance.outputIndex) && provenance.outputIndex >= 0) {
    metadata.outputIndex = provenance.outputIndex;
  }
  if (provenance.summaryIndexes) {
    metadata.summaryIndexes = sanitizedIndexes(provenance.summaryIndexes);
  }
  if (provenance.contentIndexes) {
    metadata.contentIndexes = sanitizedIndexes(provenance.contentIndexes);
  }
  if (typeof provenance.authoritative === "boolean") {
    metadata.authoritative = provenance.authoritative;
  }
  return metadata;
}

function sanitizedIndexes(indexes: number[]): number[] {
  return [...new Set(indexes)]
    .filter((index) => Number.isInteger(index) && index >= 0)
    .sort((a, b) => a - b)
    .slice(0, 100);
}

function sanitizedMetadataString(value: string | undefined, maxLength: number): string {
  return value?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength) ?? "";
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

function sumRunUsage(prior: RunUsage | null, current: RunUsage | null): RunUsage {
  const usage: RunUsage = {};
  for (const key of ["inputTokens", "outputTokens", "reasoningTokens", "totalTokens"] as const) {
    const priorValue = prior?.[key];
    const currentValue = current?.[key];
    if (priorValue !== undefined || currentValue !== undefined) {
      usage[key] = (priorValue ?? 0) + (currentValue ?? 0);
    }
  }
  return usage;
}

function isErrorPayload(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string";
}
