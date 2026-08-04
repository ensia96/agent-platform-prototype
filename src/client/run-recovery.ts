import type {
  InvokeToolResponse,
  Message,
  MessagePart,
  PermissionRequest,
  PublicRunPhase,
  PublicRunSummary,
  RunEvent,
  TerminalRunStatus
} from "../shared/types";
import { isTerminalRunEventType, isTerminalRunStatus } from "../shared/types";

export type RunConnectionState = "idle" | "connecting" | "connected" | "reconnecting";
export type RunStatusTone = "idle" | "running" | "waiting" | "reconnecting" | "cancelling" | "terminal" | "error";

export interface RunTerminalNotice {
  status: TerminalRunStatus;
  error: string | null;
}

export interface RecoveredRunSelection {
  run: PublicRunSummary | null;
  warning: string | null;
}

export function isCurrentSessionRequest(
  selectedSessionId: string | null,
  currentGeneration: number,
  requestSessionId: string | null,
  requestGeneration: number
): boolean {
  return selectedSessionId === requestSessionId && currentGeneration === requestGeneration;
}

export function isCurrentSessionOperation(
  selectedSessionId: string | null,
  currentGeneration: number,
  currentRequestId: number,
  requestSessionId: string | null,
  requestGeneration: number,
  requestId: number
): boolean {
  return (
    currentRequestId === requestId &&
    isCurrentSessionRequest(selectedSessionId, currentGeneration, requestSessionId, requestGeneration)
  );
}

export function isMatchingPermissionResponse(
  request: PermissionRequest,
  response: InvokeToolResponse,
  trackedRunId: string | null,
  shellRunId: string | null
): boolean {
  if (!request.runId || !request.invocationId) {
    return false;
  }
  return (
    response.run.id === request.runId &&
    response.run.sessionId === request.sessionId &&
    response.invocation.id === request.invocationId &&
    response.invocation.runId === request.runId &&
    response.invocation.sessionId === request.sessionId &&
    response.message.id === response.invocation.messageId &&
    response.message.runId === request.runId &&
    response.message.sessionId === request.sessionId &&
    (!trackedRunId || trackedRunId === request.runId) &&
    (!shellRunId || shellRunId === request.runId)
  );
}

export function isCurrentTrackedRunRequest(
  selectedSessionId: string | null,
  currentGeneration: number,
  trackedRunId: string | null,
  requestSessionId: string,
  requestGeneration: number,
  requestRunId: string
): boolean {
  return (
    isCurrentSessionRequest(selectedSessionId, currentGeneration, requestSessionId, requestGeneration) &&
    trackedRunId === requestRunId
  );
}

export function selectRecoveredRun(runs: readonly PublicRunSummary[]): RecoveredRunSelection {
  const activeRuns = runs
    .filter((run) => !isTerminalRunStatus(run.status))
    .sort(compareRunsNewestFirst);
  const run = activeRuns[0] ?? null;
  return {
    run,
    warning:
      activeRuns.length > 1 && run
        ? `Found ${activeRuns.length} active runs in this legacy session. Showing the most recently updated run; new runs are blocked until active work is resolved.`
        : null
  };
}

export function prepareMessagesForRunReplay(messages: readonly Message[], runId: string): Message[] {
  return messages.filter((message) => message.runId !== runId).sort(compareMessages);
}

export function mergeSnapshotWithTrackedRun(
  snapshot: readonly Message[],
  current: readonly Message[],
  trackedRunId: string
): Message[] {
  return [
    ...snapshot.filter((message) => message.runId !== trackedRunId),
    ...current.filter((message) => message.runId === trackedRunId)
  ].sort(compareMessages);
}

export function shouldApplyRunEvent(lastSeq: number, expectedRunId: string, event: RunEvent): boolean {
  return event.runId === expectedRunId && Number.isSafeInteger(event.seq) && event.seq > lastSeq;
}

export function applyRunEventToMessages(messages: readonly Message[], event: RunEvent): Message[] {
  if (event.type === "user_message_created" || event.type === "assistant_message_created" || event.type === "assistant_message_updated") {
    const message = (event.payload as { message?: Message }).message;
    return message ? upsertMessage(messages, message) : [...messages];
  }

  if (event.type === "delta") {
    const payload = event.payload as { messageId?: string; text?: string };
    return payload.messageId && payload.text ? appendMessageDelta(messages, payload.messageId, payload.text, event.createdAt) : [...messages];
  }

  if (event.type === "tool_call.created" || event.type === "tool_result.created") {
    const payload = event.payload as { messageId?: string; part?: MessagePart };
    return payload.messageId && payload.part ? upsertMessagePart(messages, payload.messageId, payload.part) : [...messages];
  }

  if (event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.failed") {
    const payload = event.payload as { messageId?: string; part?: MessagePart; outputPart?: MessagePart };
    let next = [...messages];
    if (payload.messageId && payload.part) {
      next = upsertMessagePart(next, payload.messageId, payload.part);
    }
    if (payload.messageId && payload.outputPart) {
      next = upsertMessagePart(next, payload.messageId, payload.outputPart);
    }
    return next;
  }

  if (event.type === "tool.stdout.delta" || event.type === "tool.stderr.delta") {
    const payload = event.payload as { messageId?: string; partId?: string; part?: MessagePart; text?: string };
    if (payload.messageId && payload.part) {
      return upsertMessagePart(messages, payload.messageId, payload.part);
    }
    return payload.messageId && payload.partId && payload.text
      ? appendMessagePartDelta(messages, payload.messageId, payload.partId, payload.text, event.createdAt)
      : [...messages];
  }

  if (isTerminalRunEventType(event.type)) {
    return applyTerminalEvent(messages, event);
  }

  return [...messages];
}

export function updateRunFromEvent(run: PublicRunSummary, event: RunEvent): PublicRunSummary {
  if (run.id !== event.runId) {
    return run;
  }
  if (event.type === "run_waiting_permission") {
    return { ...run, status: "waiting_permission", currentPhase: "waiting_permission", updatedAt: event.createdAt };
  }
  if (event.type === "run_cancelling") {
    return { ...run, status: "cancelling", currentPhase: "cancelling", updatedAt: event.createdAt };
  }
  if (event.type === "permission.approved" || event.type === "permission.denied") {
    return { ...run, status: "running", currentPhase: "running", updatedAt: event.createdAt };
  }
  if (event.type === "user_message_created" || event.type === "assistant_message_created" || event.type === "assistant_message_updated") {
    const message = (event.payload as { message?: Message }).message;
    return {
      ...run,
      usage: message?.usage ?? run.usage,
      updatedAt: event.createdAt
    };
  }
  if (isTerminalRunEventType(event.type)) {
    const status = terminalStatusFromEvent(event);
    const payload = event.payload as { error?: string; usage?: PublicRunSummary["usage"] };
    return {
      ...run,
      status,
      currentPhase: null,
      usage: payload.usage ?? run.usage,
      updatedAt: event.createdAt,
      error: payload.error ?? run.error
    };
  }
  if (run.status === "waiting_permission") {
    return { ...run, updatedAt: event.createdAt };
  }
  const currentPhase: PublicRunPhase = event.type.startsWith("tool") ? "tool" : "provider";
  return { ...run, status: run.status === "cancelling" ? "cancelling" : "running", currentPhase, updatedAt: event.createdAt };
}

export function terminalNoticeFromEvent(event: RunEvent): RunTerminalNotice | null {
  if (!isTerminalRunEventType(event.type)) {
    return null;
  }
  const payload = event.payload as { error?: string };
  return { status: terminalStatusFromEvent(event), error: payload.error ?? null };
}

export function terminalNoticeFromMessages(messages: readonly Message[]): RunTerminalNotice | null {
  const message = messages
    .filter(
      (item): item is Message & { status: TerminalRunStatus } =>
        item.role === "assistant" &&
        (item.status === "completed" || item.status === "cancelled" || item.status === "failed" || item.status === "interrupted")
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0];
  return message ? { status: message.status, error: message.error } : null;
}

export function runDisplayStatus(
  activeRun: PublicRunSummary | null,
  connection: RunConnectionState,
  terminalNotice: RunTerminalNotice | null,
  hasSession = true
): { label: string; tone: RunStatusTone } {
  if (activeRun) {
    const reconnecting = connection === "reconnecting";
    if (activeRun.status === "waiting_permission") {
      return { label: reconnecting ? "waiting for approval · reconnecting" : "waiting for approval", tone: "waiting" };
    }
    if (activeRun.status === "cancelling") {
      return { label: reconnecting ? "cancelling · reconnecting" : "cancelling", tone: "cancelling" };
    }
    if (reconnecting) {
      return { label: "reconnecting", tone: "reconnecting" };
    }
    if (connection === "connecting") {
      return { label: "connecting", tone: "running" };
    }
    return { label: "running", tone: "running" };
  }
  if (terminalNotice) {
    return {
      label: terminalNotice.status,
      tone: terminalNotice.status === "failed" ? "error" : "terminal"
    };
  }
  return { label: hasSession ? "ready" : "no session", tone: "idle" };
}

function applyTerminalEvent(messages: readonly Message[], event: RunEvent): Message[] {
  const payload = event.payload as {
    messageId?: string;
    error?: string;
    metadata?: Message["metadata"];
    usage?: Message["usage"];
  };
  if (!payload.messageId) {
    return [...messages];
  }
  const status = terminalStatusFromEvent(event);
  return messages.map((message) => {
    if (message.id !== payload.messageId) {
      return message;
    }
    return {
      ...message,
      status,
      error: status === "failed" || status === "interrupted" ? payload.error ?? message.error ?? "Run ended without an error message." : null,
      metadata: payload.metadata ? { ...message.metadata, ...payload.metadata } : message.metadata,
      usage: payload.usage ?? message.usage ?? null,
      parts:
        status === "cancelled" || status === "interrupted"
          ? message.parts.map((part) => cancelActiveToolCallPart(part, event.createdAt))
          : message.parts
    };
  });
}

function appendMessageDelta(messages: readonly Message[], messageId: string, delta: string, updatedAt: string): Message[] {
  return messages.map((message) => {
    if (message.id !== messageId) {
      return message;
    }
    const textPart = message.parts.find((part) => part.type === "text");
    const nextPart: MessagePart = textPart
      ? {
          ...textPart,
          text: textPart.text + delta,
          content: { ...textPart.content, text: textPart.text + delta },
          updatedAt
        }
      : {
          id: `${messageId}:local-text`,
          messageId,
          seq: 0,
          type: "text",
          text: delta,
          content: { text: delta },
          metadata: {},
          createdAt: updatedAt,
          updatedAt
        };
    const parts = textPart ? message.parts.map((part) => (part.id === textPart.id ? nextPart : part)) : [nextPart, ...message.parts];
    return { ...message, status: "streaming", parts: parts.sort(compareParts) };
  });
}

function appendMessagePartDelta(
  messages: readonly Message[],
  messageId: string,
  partId: string,
  delta: string,
  updatedAt: string
): Message[] {
  return messages.map((message) =>
    message.id === messageId
      ? {
          ...message,
          parts: message.parts.map((part) =>
            part.id === partId
              ? {
                  ...part,
                  text: part.text + delta,
                  content: { ...part.content, text: `${partText(part)}${delta}` },
                  updatedAt
                }
              : part
          )
        }
      : message
  );
}

function upsertMessage(messages: readonly Message[], message: Message): Message[] {
  const exists = messages.some((item) => item.id === message.id);
  return (exists ? messages.map((item) => (item.id === message.id ? message : item)) : [...messages, message]).sort(compareMessages);
}

function upsertMessagePart(messages: readonly Message[], messageId: string, part: MessagePart): Message[] {
  return messages.map((message) => {
    if (message.id !== messageId) {
      return message;
    }
    const exists = message.parts.some((item) => item.id === part.id);
    const parts = exists ? message.parts.map((item) => (item.id === part.id ? part : item)) : [...message.parts, part];
    return { ...message, parts: parts.sort(compareParts) };
  });
}

function cancelActiveToolCallPart(part: MessagePart, updatedAt: string): MessagePart {
  const status = part.content.status;
  return part.type === "tool_call" && (status === "created" || status === "pending" || status === "pending_permission" || status === "running")
    ? { ...part, content: { ...part.content, status: "cancelled" }, updatedAt }
    : part;
}

function terminalStatusFromEvent(event: RunEvent): TerminalRunStatus {
  if (event.type === "run_completed") {
    return "completed";
  }
  if (event.type === "run_cancelled") {
    return "cancelled";
  }
  if (event.type === "run_interrupted") {
    return "interrupted";
  }
  return "failed";
}

function compareRunsNewestFirst(left: PublicRunSummary, right: PublicRunSummary): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function compareMessages(left: Message, right: Message): number {
  return left.createdAt.localeCompare(right.createdAt) || roleRank(left.role) - roleRank(right.role) || left.id.localeCompare(right.id);
}

function roleRank(role: Message["role"]): number {
  return role === "system" ? 0 : role === "user" ? 1 : 2;
}

function compareParts(left: MessagePart, right: MessagePart): number {
  return left.seq - right.seq || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function partText(part: MessagePart): string {
  return part.text || (typeof part.content.text === "string" ? part.content.text : "");
}
