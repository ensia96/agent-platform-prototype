import type { ContextMessage, ContextToolExchange, JsonObject, Message, MessagePart, ToolResultStatus } from "../shared/types";
import { toolLoopSyntheticMessages } from "./tool-execution";

function nativeCall(part: MessagePart): JsonObject | null {
  const value = part.metadata.nativeToolCall;
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
const string = (object: JsonObject, key: string) => typeof object[key] === "string" ? object[key] as string : "";

export class NativeTranscriptError extends Error {
  readonly code = "ambiguous_native_tool_batches";
  constructor(message: string) { super(message); this.name = "NativeTranscriptError"; }
}

const orderedParts = (message: Message) => [...message.parts].sort((a,b) => a.seq-b.seq || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
const batchIds = (message: Message) => [...new Set(orderedParts(message)
  .filter((p) => p.type === "tool_call" && nativeCall(p)).map((p) => string(nativeCall(p)!,"batchId")))];
const messageText = (message: Message) => orderedParts(message).filter((p) => p.type === "text").map((p) => p.text).join("\n");

function responseBatch(message: Message): string | null {
  const ids = batchIds(message);
  const explicit = string(message.metadata,"providerResponseBatchId");
  if (explicit) return explicit;
  if (ids.length > 1 && messageText(message)) {
    throw new NativeTranscriptError("Stored message mixes native batches without assistant-text ownership. Native replay was stopped rather than omitting or misattributing a batch.");
  }
  if (ids.length && message.parts.some((text) => text.type === "text" && text.text && message.parts.some((call) =>
    call.type === "tool_call" && nativeCall(call) && call.createdAt < text.createdAt))) {
    throw new NativeTranscriptError("Stored assistant text follows an older tool batch without response ownership; its causal position is ambiguous.");
  }
  return ids[0] ?? null;
}

/** Reconstructed entirely from persisted parts; groups approval-split messages by original provider batch. */
export function currentRunToolTranscript(messages: Message[]): ContextMessage[] {
  const output: ContextMessage[] = [];
  const emitted = new Set<string>();
  const nativeIds = new Set<string>();
  const ordered = [...messages].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const responseOwners = new Map(ordered.map((message) => [message.id,responseBatch(message)]));

  const emitBatch = (message: Message, batch: string) => {
    const key = `${message.runId}:${batch}`;
    if (!batch) throw new NativeTranscriptError("Stored native call has no provider batch identity.");
    if (emitted.has(key)) return;
    emitted.add(key);
    const members = ordered.filter((m) => m.runId === message.runId && batchIds(m).includes(batch));
    const calls = members.flatMap((m) => orderedParts(m).filter((p) => p.type === "tool_call" && nativeCall(p)?.batchId === batch));
    const exchange: ContextToolExchange = {
      assistantText: members.filter((m) => responseOwners.get(m.id) === batch).map(messageText).filter(Boolean).join("\n"),
      calls: [], results: [], sourceIds: members.map((m) => m.id)
    };
    let complete = true;
    for (const call of calls) {
      const native = nativeCall(call)!;
      const callId = string(native,"id");
      if (!callId || nativeIds.has(callId)) throw new Error("Native tool continuation has a missing or duplicate call ID.");
      nativeIds.add(callId);
      const owner = members.find((m) => m.id === call.messageId)!;
      const related = orderedParts(owner).filter((p) => p.type !== "tool_call" && p.content.callId === call.content.callId);
      const results = related.filter((p) => p.type === "tool_result");
      if (results.length === 0) { complete = false; continue; }
      if (results.length !== 1) throw new Error("Native tool continuation has ambiguous result ownership.");
      const result = results[0];
      const status = string(result.content,"status") as ToolResultStatus;
      if (!["completed","failed","cancelled"].includes(status)) { complete = false; continue; }
      exchange.calls.push({ id: callId, name: string(native,"name"), argumentsText: string(native,"argumentsText"),
        ...(typeof native.nativeItemId === "string" ? { nativeItemId: native.nativeItemId } : {}) });
      exchange.results.push({callId,status,output: resultText(result,related)});
      exchange.sourceIds.push(call.id,...related.map((p) => p.id));
    }
    if (!complete && members.some((m) => batchIds(m).length > 1)) {
      throw new NativeTranscriptError("Stored mixed native batches contain an unresolved call; replay cannot skip that batch safely.");
    }
    // A pending approval/batch is never sent as unmatched native calls.
    if (complete) output.push({role:"assistant",source:"synthetic",messageId:`tool-batch:${batch}`,
      content: toolExchangeText(exchange),toolExchange:exchange});
  };

  for (const message of ordered) {
    const parts = orderedParts(message);
    const ids = batchIds(message);
    const legacy = toolLoopSyntheticMessages({...message,parts:parts.filter((p) => p.type !== "tool_call" || !nativeCall(p))});
    const handoffs = new Map(parts.filter((p) => p.metadata.subsessionHandoff === true).map((p) => [p.id,legacy.find((m) => m.messageId === p.id)!]));
    if (!ids.length) {
      // Handoffs were delivered as input, before this assistant's text was generated (text occupies seq 0).
      for (const part of parts) if (handoffs.has(part.id)) output.push(handoffs.get(part.id)!);
      const text = messageText(message);
      if (text) output.push({role:"assistant",source:"synthetic",messageId:message.id,content:text});
      output.push(...legacy.filter((m) => !handoffs.has(m.messageId ?? "")));
      continue;
    }
    // Structured seq order preserves arrival of input notifications before the response/call batch.
    // Iterate every batch ID, including recoverable mixed rows written by older code.
    for (const part of parts) {
      if (handoffs.has(part.id)) output.push(handoffs.get(part.id)!);
      else if (part.type === "tool_call") {
        const native = nativeCall(part);
        if (native) emitBatch(message,string(native,"batchId"));
        else {
          const projected = legacy.find((m) => m.messageId === `tool:${message.id}:${string(part.content,"callId")}`);
          if (projected) output.push(projected);
        }
      }
    }
    // Explicit metadata can identify a subsequent text-only response in a legacy mixed message.
    if (!ids.includes(responseOwners.get(message.id) ?? "") && messageText(message)) {
      output.push({role:"assistant",source:"synthetic",messageId:message.id,content:messageText(message)});
    }
  }
  return output;
}

function resultText(result: MessagePart, related: MessagePart[]): string {
  const commands = related.filter((p) => p.type === "command_output");
  const error = string(result.content,"error");
  const summary = string(result.content,"outputSummary");
  const body = commands.length ? commands.map((p) => `[command output${typeof p.content.exitCode === "number" ? ` · exit ${p.content.exitCode}` : ""}]\n${string(p.content,"text") || p.text}`).join("\n")
    : string(result.content,"output") || (!summary && !error ? result.text : "");
  return [`[tool result · ${string(result.content,"status")}]`, summary || error,
    error && summary && error !== summary ? error : "", body === summary ? "" : body].filter(Boolean).join("\n");
}

export function toolExchangeText(exchange: ContextToolExchange): string {
  return [exchange.assistantText,...exchange.calls.map((call,index) =>
    `[tool call · ${call.name} · ${call.id}]\n${call.argumentsText}\n${exchange.results[index]?.output ?? ""}`)].filter(Boolean).join("\n\n");
}
