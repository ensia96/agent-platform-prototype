import type {
  AgentDefinition,
  BuiltContext,
  ContextBuildResult,
  ContextMessage,
  ContextMessagePart,
  JsonObject,
  Message,
  ModelToolDefinition,
  MessagePart,
  MessagePartType,
  RunOptions,
  Session
} from "../shared/types";
import { normalizeReasoningEffort } from "../shared/run-options";

export const defaultAgentId = "main";

export interface ContextBuildInput {
  session: Session;
  agent: AgentDefinition;
  messages: Message[];
  currentMessage?: {
    role?: "user";
    content: string;
    messageId?: string;
    metadata?: JsonObject;
  };
  providerProfileId?: string;
  runOptions?: RunOptions;
  availableTools?: ModelToolDefinition[];
  metadata?: JsonObject;
  builtAt?: string;
}

export function buildContext(input: ContextBuildInput): ContextBuildResult {
  const warnings: string[] = [];
  const skippedMessageIds: string[] = [];
  const messages: ContextMessage[] = [];
  const sortedMessages = [...input.messages].sort(compareMessages);

  for (const message of sortedMessages) {
    const contextMessage = messageToContextMessage(message, warnings, skippedMessageIds);
    if (contextMessage) {
      messages.push(contextMessage);
    }
  }

  const currentContent = input.currentMessage?.content ?? "";
  if (currentContent.trim()) {
    messages.push({
      role: "user",
      content: currentContent,
      source: "current",
      ...(input.currentMessage?.messageId ? { messageId: input.currentMessage.messageId } : {}),
      ...(input.currentMessage?.metadata ? { metadata: input.currentMessage.metadata } : {})
    });
  }

  // TODO: add token counting, history trimming, explicit file expansion, skills, and subagent context slots.
  const builtAt = input.builtAt ?? new Date().toISOString();
  const runOptions = cleanRunOptions(input.runOptions ?? {});
  const availableTools = [...(input.availableTools ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const workingDirectory = input.session.workingDirectory;
  const metadata: JsonObject = {
    ...(input.metadata ?? {}),
    kind: "provider-neutral-context",
    sessionId: input.session.id,
    workingDirectory,
    agentId: input.agent.id,
    builtAt,
    messageCount: messages.length,
    availableToolIds: availableTools.map((tool) => tool.id),
    sourceMessageCount: sortedMessages.length,
    sourceMessageIds: sortedMessages.map((message) => message.id),
    skippedMessageIds
  };
  if (input.providerProfileId) {
    metadata.providerProfileId = input.providerProfileId;
  }

  const context: BuiltContext = {
    agent: input.agent,
    systemPrompt: buildSystemPrompt(input.agent.systemPrompt, workingDirectory),
    workingDirectory,
    messages,
    availableTools,
    runOptions,
    ...(input.providerProfileId ? { providerProfileId: input.providerProfileId } : {}),
    skillIds: input.agent.skillIds,
    toolIds: availableTools.map((tool) => tool.id),
    metadata
  };

  return { context, warnings, skippedMessageIds };
}

function buildSystemPrompt(agentSystemPrompt: string, workingDirectory: string): string {
  const runtimeContext = [
    "Runtime context:",
    `- Session working directory: ${singleLine(workingDirectory)}`,
    "- Use this as the default cwd for shell.exec when cwd is omitted; relative shell cwd values resolve from this directory."
  ].join("\n");
  return [agentSystemPrompt.trim(), runtimeContext].filter(Boolean).join("\n\n");
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

function messageToContextMessage(message: Message, warnings: string[], skippedMessageIds: string[]): ContextMessage | null {
  if (message.role === "assistant" && (message.status !== "completed" || message.error)) {
    skippedMessageIds.push(message.id);
    warnings.push(`Skipped assistant message ${message.id} because it is ${message.status}${message.error ? " with an error" : ""}.`);
    return null;
  }

  if (message.role !== "assistant" && message.status === "failed") {
    skippedMessageIds.push(message.id);
    warnings.push(`Skipped ${message.role} message ${message.id} because it failed.`);
    return null;
  }

  const contextParts = message.parts.map((part) => partToContextPart(part));
  const includedParts = contextParts.filter((part) => part.text.trim().length > 0);
  const content = includedParts.map((part) => part.text).join("\n\n");
  if (!content.trim()) {
    skippedMessageIds.push(message.id);
    return null;
  }

  const sourcePartTypes = uniquePartTypes(message.parts.map((part) => part.type));
  const includedPartTypes = uniquePartTypes(includedParts.map((part) => part.type));
  const skippedPartTypes = uniquePartTypes(
    contextParts.filter((part) => !part.text.trim()).map((part) => part.type)
  );

  return {
    role: message.role,
    content,
    source: "session",
    messageId: message.id,
    parts: contextParts,
    metadata: {
      status: message.status,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      sourcePartTypes,
      includedPartTypes,
      skippedPartTypes,
      ...(message.runId ? { runId: message.runId } : {})
    }
  };
}

function partToContextPart(part: MessagePart): ContextMessagePart {
  const { text, skipReason } = partContextText(part);
  const metadata: JsonObject = {
    seq: part.seq,
    includeInContext: Boolean(text.trim())
  };
  if (skipReason) {
    metadata.skipReason = skipReason;
  }

  return {
    type: part.type,
    text,
    sourcePartId: part.id,
    metadata
  };
}

function partContextText(part: MessagePart): { text: string; skipReason?: string } {
  if (part.type === "text") {
    return { text: part.text || partString(part, "text") };
  }

  if (part.type === "tool_result") {
    const status = partString(part, "status");
    const error = partString(part, "error");
    if (status === "failed" || status === "cancelled" || error) {
      return { text: "", skipReason: "failed_tool_result" };
    }

    const body = partString(part, "outputSummary") || partString(part, "output") || part.text;
    if (!body.trim()) {
      return { text: "", skipReason: "empty_tool_result" };
    }

    const label = ["tool result", partString(part, "toolName") || partString(part, "toolId"), partString(part, "callId")]
      .filter(Boolean)
      .join(" · ");
    return { text: `[${label}]\n${body}` };
  }

  if (part.type === "command_output") {
    const body = partString(part, "text") || part.text;
    if (!body.trim()) {
      return { text: "", skipReason: "empty_command_output" };
    }

    const header = [
      "command output",
      partString(part, "stream"),
      partNumber(part, "exitCode") !== null ? `exit ${partNumber(part, "exitCode")}` : "",
      partString(part, "cwd")
    ]
      .filter(Boolean)
      .join(" · ");
    return { text: `[${header}]\n${body}` };
  }

  if (part.type === "file_ref") {
    const location = fileReferenceLabel(part);
    if (!location) {
      return { text: "", skipReason: "empty_file_ref" };
    }
    return { text: `[file reference] ${location}` };
  }

  if (part.type === "error") {
    return { text: "", skipReason: "error_part" };
  }

  if (part.type === "reasoning_summary" || part.type === "reasoning_detail") {
    return { text: "", skipReason: "reasoning_not_for_context" };
  }

  if (part.type === "tool_call") {
    return { text: "", skipReason: "tool_call_without_result" };
  }

  return { text: "", skipReason: "unsupported_part_type" };
}

function partString(part: MessagePart, key: string): string {
  const value = part.content[key];
  return typeof value === "string" ? value : "";
}

function partNumber(part: MessagePart, key: string): number | null {
  const value = part.content[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fileReferenceLabel(part: MessagePart): string {
  const location = partString(part, "path") || partString(part, "uri") || part.text;
  if (!location.trim()) {
    return "";
  }

  const lineStart = partNumber(part, "lineStart");
  const lineEnd = partNumber(part, "lineEnd");
  if (lineStart !== null && lineEnd !== null) {
    return `${location}:${lineStart}-${lineEnd}`;
  }
  if (lineStart !== null) {
    return `${location}:${lineStart}`;
  }
  return location;
}

function uniquePartTypes(types: MessagePartType[]): MessagePartType[] {
  return [...new Set(types)];
}

function cleanRunOptions(options: RunOptions): RunOptions {
  const output: RunOptions = {};
  const model = options.model?.trim();
  if (model) {
    output.model = model;
  }
  const reasoningEffort = normalizeReasoningEffort(options.reasoningEffort);
  if (reasoningEffort) {
    output.reasoningEffort = reasoningEffort;
  }
  if (typeof options.temperature === "number" && Number.isFinite(options.temperature)) {
    output.temperature = options.temperature;
  }
  return output;
}

function compareMessages(a: Message, b: Message): number {
  return a.createdAt.localeCompare(b.createdAt) || roleRank(a.role) - roleRank(b.role) || a.id.localeCompare(b.id);
}

function roleRank(role: Message["role"]): number {
  if (role === "system") {
    return 0;
  }
  if (role === "user") {
    return 1;
  }
  return 2;
}
