import type {
  AgentDefinition,
  BuiltContext,
  ContextBuildResult,
  ContextMessage,
  JsonObject,
  Message,
  RunOptions,
  Session
} from "../shared/types";

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

  // TODO: add token counting, history trimming, file context, tools, skills, and subagent context slots.
  const builtAt = input.builtAt ?? new Date().toISOString();
  const runOptions = cleanRunOptions(input.runOptions ?? {});
  const metadata: JsonObject = {
    ...(input.metadata ?? {}),
    kind: "provider-neutral-context",
    sessionId: input.session.id,
    agentId: input.agent.id,
    builtAt,
    messageCount: messages.length,
    sourceMessageCount: sortedMessages.length,
    sourceMessageIds: sortedMessages.map((message) => message.id),
    skippedMessageIds
  };
  if (input.providerProfileId) {
    metadata.providerProfileId = input.providerProfileId;
  }

  const context: BuiltContext = {
    agent: input.agent,
    systemPrompt: input.agent.systemPrompt,
    messages,
    runOptions,
    ...(input.providerProfileId ? { providerProfileId: input.providerProfileId } : {}),
    skillIds: input.agent.skillIds,
    toolIds: input.agent.toolIds,
    metadata
  };

  return { context, warnings, skippedMessageIds };
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

  const content = message.parts.map((part) => part.text).join("");
  if (!content.trim()) {
    skippedMessageIds.push(message.id);
    return null;
  }

  return {
    role: message.role,
    content,
    source: "session",
    messageId: message.id,
    metadata: {
      status: message.status,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      ...(message.runId ? { runId: message.runId } : {})
    }
  };
}

function cleanRunOptions(options: RunOptions): RunOptions {
  const output: RunOptions = {};
  const model = options.model?.trim();
  if (model) {
    output.model = model;
  }
  if (options.reasoningEffort) {
    output.reasoningEffort = options.reasoningEffort;
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
