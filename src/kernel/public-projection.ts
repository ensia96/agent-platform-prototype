import type {
  JsonObject,
  JsonValue,
  Message,
  MessagePart,
  PublicProviderResolution,
  PublicToolExecutionResult,
  PublicToolInvocation,
  ProviderResolution,
  RunEvent,
  RunEventType,
  ToolExecutionResult,
  ToolInvocation
} from "../shared/types";
import { isTerminalRunEventType } from "../shared/types";

export function toPublicMessage(message: Message): Message {
  return {
    ...message,
    error: sanitizePublicText(message.error, 1_000),
    metadata: {},
    parts: message.parts.map(toPublicMessagePart)
  };
}

export function toPublicProviderResolution(resolution: ProviderResolution): PublicProviderResolution {
  return {
    requestedProvider: resolution.requestedProvider,
    requestedProviderProfileId: resolution.requestedProviderProfileId,
    providerProfileId: resolution.providerProfileId,
    providerProfileName: resolution.providerProfileName,
    providerType: resolution.providerType,
    ...(resolution.model ? { model: resolution.model } : {}),
    fallback: resolution.fallback
  };
}

export function toPublicToolInvocation(invocation: ToolInvocation): PublicToolInvocation {
  return {
    id: invocation.id,
    toolId: invocation.toolId,
    toolName: invocation.toolName,
    sessionId: invocation.sessionId,
    runId: invocation.runId,
    messageId: invocation.messageId,
    caller: invocation.caller,
    status: invocation.status,
    permissionDecision: invocation.permissionDecision,
    createdAt: invocation.createdAt,
    updatedAt: invocation.updatedAt
  };
}

export function toPublicToolExecutionResult(result: ToolExecutionResult): PublicToolExecutionResult {
  return {
    invocationId: result.invocationId,
    toolId: result.toolId,
    status: result.status,
    output: { ...result.output },
    error: sanitizePublicText(result.error, 1_000),
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs
  };
}

export function sanitizePublicText(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const redacted = value
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
    .replace(/("(?:access|refresh|id)_?token"\s*:\s*")[^"]+("|$)/gi, "$1[REDACTED]$2")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]");
  const sanitized = redacted.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
  return sanitized || null;
}

export function toPublicRunEvent(event: RunEvent): RunEvent {
  const payload = eventPayload(event.type, event.payload);
  return { ...event, payload };
}

function eventPayload(type: RunEventType, value: unknown): JsonObject {
  const payload = jsonObject(value);
  if (type === "run_started") {
    const resolution = providerResolution(payload.providerResolution);
    return compact({
      runId: payload.runId,
      sessionId: payload.sessionId,
      provider: payload.provider,
      providerProfileId: payload.providerProfileId,
      providerResolution: resolution,
      agentId: payload.agentId,
      agentName: payload.agentName,
      agentRevision: payload.agentRevision,
      requestedRunOptions: payload.requestedRunOptions,
      runOptions: payload.runOptions,
      unsupportedRunOptions: payload.unsupportedRunOptions,
      model: payload.model,
      usage: payload.usage,
      toolId: payload.toolId,
      toolName: payload.toolName,
      caller: payload.caller,
      permissionDecision: payload.permissionDecision,
      permissionAction: payload.permissionAction,
      riskLevel: payload.riskLevel
    });
  }
  if (type === "user_message_created" || type === "assistant_message_created" || type === "assistant_message_updated") {
    return payload.message && isMessage(payload.message)
      ? { message: toPublicMessage(payload.message) as unknown as JsonValue }
      : {};
  }
  if (isTerminalRunEventType(type)) {
    return compact({
      messageId: payload.messageId,
      runId: payload.runId,
      error: typeof payload.error === "string" ? sanitizePublicText(payload.error, 1_000) : undefined,
      usage: payload.usage
    });
  }
  if (type === "permission.requested" || type === "permission.approved" || type === "permission.denied") {
    return compact({
      requestId: payload.requestId,
      status: payload.status,
      reason: payload.reason,
      riskLevel: payload.riskLevel
    });
  }

  return compact({
    runId: payload.runId,
    sessionId: payload.sessionId,
    messageId: payload.messageId,
    permissionRequestId: payload.permissionRequestId,
    partId: payload.partId,
    part: isMessagePart(payload.part) ? toPublicMessagePart(payload.part) : undefined,
    outputPartId: payload.outputPartId,
    outputPart: isMessagePart(payload.outputPart) ? toPublicMessagePart(payload.outputPart) : undefined,
    callId: payload.callId,
    toolId: payload.toolId,
    toolName: payload.toolName,
    caller: payload.caller,
    status: payload.status,
    stream: payload.stream,
    text: payload.text,
    error: typeof payload.error === "string" ? sanitizePublicText(payload.error, 1_000) : undefined,
    durationMs: payload.durationMs
  });
}

function toPublicMessagePart(part: MessagePart): MessagePart {
  return {
    ...part,
    content: { ...part.content },
    metadata: reasoningMetadata(part)
  };
}

function reasoningMetadata(part: MessagePart): JsonObject {
  if (part.type !== "reasoning_summary" && part.type !== "reasoning_detail") {
    return {};
  }
  return compact({
    providerSupplied: part.metadata.providerSupplied,
    provider: part.metadata.provider,
    nativeEventType: part.metadata.nativeEventType,
    itemId: part.metadata.itemId,
    outputIndex: part.metadata.outputIndex,
    summaryIndexes: part.metadata.summaryIndexes,
    contentIndexes: part.metadata.contentIndexes,
    authoritative: part.metadata.authoritative
  });
}

function providerResolution(value: unknown): PublicProviderResolution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as ProviderResolution;
  return typeof candidate.providerProfileId === "string" && typeof candidate.providerProfileName === "string"
    ? toPublicProviderResolution(candidate)
    : undefined;
}

function compact(value: Record<string, unknown>): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as JsonObject;
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function isMessage(value: unknown): value is Message {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as Message).id === "string");
}

function isMessagePart(value: unknown): value is MessagePart {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as MessagePart).id === "string");
}
