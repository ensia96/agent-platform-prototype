import type {
  AgentDefinition,
  BuiltContext,
  ContextBuildResult,
  ContextArtifact,
  ContextMessage,
  ContextMessagePart,
  JsonObject,
  Message,
  ModelToolDefinition,
  MessagePart,
  MessagePartType,
  RunOptions,
  ModelContextCapability,
  ProviderContextPlanningProfile,
  Session
} from "../shared/types";
import { normalizeReasoningEffort } from "../shared/run-options";
import { MessageVO } from "@/kernel/message/vo";
import { boundHistoricalContextText, planContext, resolveContextBudget, type ResolvedContextBudget } from "./context-budget";

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
  currentMessageId?: string;
  contextCapability?: ModelContextCapability | null;
  resolvedBudget?: ResolvedContextBudget;
  providerOverhead?: ProviderContextPlanningProfile;
  syntheticMessages?: ContextMessage[];
  activeSegmentId?: string;
  compactionArtifact?: ContextArtifact | null;
}

export function buildContext(input: ContextBuildInput): ContextBuildResult {
  const warnings: string[] = [];
  const skippedMessageIds: string[] = [];
  const messages: ContextMessage[] = [];
  const sortedMessages = [...input.messages].sort(compareMessages);

  if (input.compactionArtifact?.status === "completed") {
    messages.push({
      role: "system",
      content: `Cumulative continuity summary from earlier context:\n${input.compactionArtifact.summary}`,
      source: "compaction",
      messageId: input.compactionArtifact.id,
      metadata: {
        artifactId: input.compactionArtifact.id,
        sourceSegmentId: input.compactionArtifact.sourceSegmentId,
        strategyVersion: input.compactionArtifact.strategyVersion
      }
    });
  }

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
  messages.push(...(input.syntheticMessages ?? []).map((message) => ({ ...message, source: "synthetic" as const })));

  const builtAt = input.builtAt ?? new Date().toISOString();
  const runOptions = cleanRunOptions(input.runOptions ?? {});
  const availableTools = [...(input.availableTools ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const workingDirectory = input.session.workingDirectory;
  const systemPrompt = buildSystemPrompt(input.agent.systemPrompt, workingDirectory);
  const planned = planContext({
    systemPrompt,
    messages,
    availableTools,
    budget: input.resolvedBudget ?? resolveContextBudget(input.contextCapability, input.agent.contextPolicy),
    currentMessageId: input.currentMessageId,
    providerOverhead: input.providerOverhead,
    activeSegmentId: input.activeSegmentId ?? input.session.activeSegmentId,
    inheritedArtifactId: input.compactionArtifact?.id
  });
  const includedMessageIds = new Set(planned.messages.flatMap((message) => (message.messageId ? [message.messageId] : [])));
  for (const message of messages) {
    if (message.messageId && !includedMessageIds.has(message.messageId) && !skippedMessageIds.includes(message.messageId)) {
      skippedMessageIds.push(message.messageId);
    }
  }
  const metadata: JsonObject = {
    ...(input.metadata ?? {}),
    kind: "provider-neutral-context",
    sessionId: input.session.id,
    workingDirectory,
    agentId: input.agent.id,
    builtAt,
    messageCount: planned.messages.length,
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
    systemPrompt,
    workingDirectory,
    messages: planned.messages,
    availableTools,
    runOptions,
    ...(input.providerProfileId ? { providerProfileId: input.providerProfileId } : {}),
    skillIds: input.agent.skillIds,
    toolIds: availableTools.map((tool) => tool.id),
    metadata,
    plan: planned.plan
  };

  if (planned.plan.trimmingApplied) {
    warnings.push(
      `Context planning omitted ${planned.plan.omitted.length} candidate(s) or bounded large context-only text to fit the input budget.`
    );
  }
  if (planned.plan.windowSource === "assumed") {
    warnings.push(
      `The ${planned.plan.windowTokens}-token context window is a conservative assumed fallback, not a provider-reported model capability.`
    );
  }
  if (planned.plan.capabilityStale) {
    warnings.push(
      `The ${planned.plan.windowTokens}-token provider context window is a stale last-good catalog value because refresh failed.`
    );
  }
  return { context, plan: planned.plan, warnings, skippedMessageIds };
}

export function projectStoredMessagesForContext(source: Message[]): ContextMessage[] {
  const warnings: string[] = [];
  const skippedMessageIds: string[] = [];
  return [...source]
    .sort(compareMessages)
    .flatMap((message) => {
      const projected = messageToContextMessage(message, warnings, skippedMessageIds);
      return projected ? [projected] : [];
    });
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
  if (message.role === "assistant" && (!new MessageVO.Status(message.status).isCompleted() || message.error)) {
    skippedMessageIds.push(message.id);
    warnings.push(`Skipped assistant message ${message.id} because it is ${message.status}${message.error ? " with an error" : ""}.`);
    return null;
  }

  const commandOutputCallIds = new Set(
    message.parts.flatMap((part) => (part.type === "command_output" && partString(part, "callId") ? [partString(part, "callId")] : []))
  );
  const contextParts = message.parts.map((part) => partToContextPart(part, commandOutputCallIds));
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

function partToContextPart(part: MessagePart, commandOutputCallIds: ReadonlySet<string>): ContextMessagePart {
  const { text, skipReason, bounded } = partContextText(part, commandOutputCallIds);
  const metadata: JsonObject = {
    seq: part.seq,
    includeInContext: Boolean(text.trim())
  };
  if (skipReason) {
    metadata.skipReason = skipReason;
  }
  if (bounded) {
    metadata.contextTextBounded = true;
  }

  return {
    type: part.type,
    text,
    sourcePartId: part.id,
    metadata
  };
}

function partContextText(
  part: MessagePart,
  commandOutputCallIds: ReadonlySet<string>
): { text: string; skipReason?: string; bounded?: boolean } {
  if (part.type === "text") {
    return { text: part.text || partString(part, "text") };
  }

  if (part.type === "tool_result") {
    const status = partString(part, "status");
    const error = partString(part, "error");
    const label = ["tool result", partString(part, "toolName") || partString(part, "toolId"), partString(part, "callId")]
      .filter(Boolean)
      .join(" · ");
    const callId = partString(part, "callId");
    const summary = partString(part, "outputSummary");
    if (callId && commandOutputCallIds.has(callId)) {
      const statusText = [status || "completed", summary].filter(Boolean).join(": ");
      return { text: `[${label}] ${statusText}`, skipReason: "raw_output_projected_from_command_output_only" };
    }
    if (status === "failed" || status === "cancelled" || error) {
      return { text: `[${label}] ${[status, error].filter(Boolean).join(": ")}` };
    }

    const body = summary || partString(part, "output") || part.text;
    if (!body.trim()) {
      return { text: `[${label}] ${status || "completed"}` };
    }
    const boundedBody = boundHistoricalContextText(body);
    return { text: `[${label}]\n${boundedBody}`, ...(boundedBody !== body ? { bounded: true } : {}) };
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
    const boundedBody = boundHistoricalContextText(body);
    return { text: `[${header}]\n${boundedBody}`, ...(boundedBody !== body ? { bounded: true } : {}) };
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
