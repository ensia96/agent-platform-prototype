import { defaultMainAgentToolIds } from "../shared/model-tools";
import type { ProviderMessage } from "../providers/types";
import type {
  AgentDefinition,
  BuiltContext,
  JsonObject,
  MessagePart,
  ProviderProfile,
  ProviderResolution,
  RunOptions
} from "../shared/types";
import { defaultAgentId } from "./context-builder";

export interface RunOptionPlan {
  requestedRunOptions: RunOptions;
  runOptions: RunOptions;
  unsupportedRunOptions: string[];
}

export function stringField(object: JsonObject, key: string): string {
  const value = object[key];
  return typeof value === "string" ? value : "";
}

export function partString(part: MessagePart, key: string): string {
  const value = part.content[key];
  return typeof value === "string" ? value : "";
}

export function partNumber(part: MessagePart, key: string): number | null {
  return numberField(part.content, key);
}

export function numberField(object: JsonObject, key: string): number | null {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function nullableNumberField(object: JsonObject, key: string): number | null {
  return object[key] === null ? null : numberField(object, key);
}

export function booleanField(object: JsonObject, key: string): boolean | null {
  const value = object[key];
  return typeof value === "boolean" ? value : null;
}

export function buildRunOptionPlan(profile: ProviderProfile, requested: RunOptions): RunOptionPlan {
  const requestedRunOptions = cleanRunOptions(requested);
  const runOptions: RunOptions = {};
  const unsupportedRunOptions: string[] = [];
  const defaultModel = profile.defaultRunOptions?.model?.trim() || profile.model?.trim();

  if (profile.type === "openai-compatible") {
    const model = requestedRunOptions.model ?? defaultModel;
    if (model) {
      runOptions.model = model;
    }
    if (requestedRunOptions.temperature !== undefined) {
      runOptions.temperature = requestedRunOptions.temperature;
    }
    if (requestedRunOptions.reasoningEffort) {
      unsupportedRunOptions.push("reasoningEffort");
    }
    return { requestedRunOptions, runOptions, unsupportedRunOptions };
  }

  if (profile.type === "openai-chatgpt") {
    const model = requestedRunOptions.model ?? defaultModel;
    if (model) {
      runOptions.model = model;
    }
    if (requestedRunOptions.temperature !== undefined) {
      unsupportedRunOptions.push("temperature");
    }
    if (requestedRunOptions.reasoningEffort) {
      unsupportedRunOptions.push("reasoningEffort");
    }
    return { requestedRunOptions, runOptions, unsupportedRunOptions };
  }

  if (requestedRunOptions.model) {
    unsupportedRunOptions.push("model");
  }
  if (requestedRunOptions.temperature !== undefined) {
    unsupportedRunOptions.push("temperature");
  }
  if (requestedRunOptions.reasoningEffort) {
    unsupportedRunOptions.push("reasoningEffort");
  }
  return { requestedRunOptions, runOptions, unsupportedRunOptions };
}

export function mergeRunOptions(agentDefaults: RunOptions | null | undefined, runOptions: RunOptions | null | undefined): RunOptions {
  return cleanRunOptions({ ...(agentDefaults ?? {}), ...(runOptions ?? {}) });
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

export function buildRunMetadata(
  providerResolution: ProviderResolution,
  optionPlan: RunOptionPlan,
  agent: AgentDefinition,
  userRunOptions: RunOptions
): JsonObject {
  const metadata: JsonObject = {
    agentId: agent.id,
    agentName: agent.name,
    agent: agentToJson(agent),
    providerProfileId: providerResolution.providerProfileId,
    providerProfileName: providerResolution.providerProfileName,
    providerType: providerResolution.providerType,
    requestedProvider: providerResolution.requestedProvider,
    requestedProviderProfileId: providerResolution.requestedProviderProfileId,
    providerResolution: providerResolutionToJson(providerResolution),
    runOptions: runOptionsToJson(optionPlan.runOptions),
    agentDefaultRunOptions: runOptionsToJson(agent.defaultRunOptions ?? {}),
    userRunOptions: runOptionsToJson(userRunOptions),
    requestedRunOptions: runOptionsToJson(optionPlan.requestedRunOptions),
    unsupportedRunOptions: optionPlan.unsupportedRunOptions
  };

  if (providerResolution.model) {
    metadata.model = providerResolution.model;
  }
  if (optionPlan.unsupportedRunOptions.length > 0) {
    metadata.optionSupportNote = "Unsupported run options are recorded as metadata only and are not sent to the provider.";
  }
  return metadata;
}

function providerResolutionToJson(resolution: ProviderResolution): JsonObject {
  const output: JsonObject = {
    requestedProvider: resolution.requestedProvider,
    requestedProviderProfileId: resolution.requestedProviderProfileId,
    providerProfileId: resolution.providerProfileId,
    providerProfileName: resolution.providerProfileName,
    providerType: resolution.providerType,
    fallback: resolution.fallback ? fallbackToJson(resolution.fallback) : null
  };
  if (resolution.model) {
    output.model = resolution.model;
  }
  if (resolution.baseUrl) {
    output.baseUrl = resolution.baseUrl;
  }
  if (resolution.credentialRef) {
    output.credentialRef = resolution.credentialRef;
  }
  return output;
}

function fallbackToJson(fallback: NonNullable<ProviderResolution["fallback"]>): JsonObject {
  return {
    fromProviderProfileId: fallback.fromProviderProfileId,
    toProviderProfileId: fallback.toProviderProfileId,
    reason: fallback.reason,
    message: fallback.message
  };
}

function runOptionsToJson(options: RunOptions): JsonObject {
  const output: JsonObject = {};
  if (options.model) {
    output.model = options.model;
  }
  if (options.reasoningEffort) {
    output.reasoningEffort = options.reasoningEffort;
  }
  if (typeof options.temperature === "number" && Number.isFinite(options.temperature)) {
    output.temperature = options.temperature;
  }
  return output;
}

export function buildContextRunMetadata(context: BuiltContext, warnings: string[], skippedMessageIds: string[]): JsonObject {
  const metadata: JsonObject = {
    contextSnapshot: builtContextToJson(context),
    contextBuilder: contextSummaryToJson(context, warnings, skippedMessageIds)
  };
  if (warnings.length > 0) {
    metadata.contextWarnings = warnings;
  }
  if (skippedMessageIds.length > 0) {
    metadata.skippedContextMessageIds = skippedMessageIds;
  }
  return metadata;
}

export function contextSummaryToJson(context: BuiltContext, warnings: string[], skippedMessageIds: string[]): JsonObject {
  return {
    kind: "provider-neutral-context",
    agentId: context.agent.id,
    agentName: context.agent.name,
    workingDirectory: context.workingDirectory,
    providerProfileId: context.providerProfileId ?? null,
    systemPromptLength: context.systemPrompt.length,
    messageCount: context.messages.length,
    availableToolIds: context.availableTools.map((tool) => tool.id),
    runOptions: runOptionsToJson(context.runOptions),
    warningCount: warnings.length,
    skippedMessageIds
  };
}

function builtContextToJson(context: BuiltContext): JsonObject {
  const output: JsonObject = {
    agent: agentToJson(context.agent),
    systemPrompt: context.systemPrompt,
    workingDirectory: context.workingDirectory,
    messages: context.messages.map((message) => contextMessageToJson(message)),
    availableTools: context.availableTools.map((tool) => ({
      id: tool.id,
      providerName: tool.providerName,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      metadata: tool.metadata
    })),
    runOptions: runOptionsToJson(context.runOptions),
    metadata: context.metadata
  };
  if (context.providerProfileId) {
    output.providerProfileId = context.providerProfileId;
  }
  if (context.skillIds) {
    output.skillIds = context.skillIds;
  }
  if (context.toolIds) {
    output.toolIds = context.toolIds;
  }
  return output;
}

function contextMessageToJson(message: BuiltContext["messages"][number]): JsonObject {
  const output: JsonObject = {
    role: message.role,
    content: message.content
  };
  if (message.source) {
    output.source = message.source;
  }
  if (message.messageId) {
    output.messageId = message.messageId;
  }
  if (message.parts) {
    output.parts = message.parts.map((part) => {
      const partOutput: JsonObject = {
        type: part.type,
        text: part.text
      };
      if (part.sourcePartId) {
        partOutput.sourcePartId = part.sourcePartId;
      }
      if (part.metadata) {
        partOutput.metadata = part.metadata;
      }
      return partOutput;
    });
  }
  if (message.metadata) {
    output.metadata = message.metadata;
  }
  return output;
}

export function agentToJson(agent: AgentDefinition): JsonObject {
  const output: JsonObject = {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    modelProfileId: agent.modelProfileId,
    defaultRunOptions: runOptionsToJson(agent.defaultRunOptions ?? {}),
    skillIds: agent.skillIds,
    toolIds: agent.toolIds,
    metadata: agent.metadata,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  };
  return output;
}

export function effectiveAgentToolIds(agent: AgentDefinition): string[] {
  const explicit = uniqueStrings(agent.toolIds);
  if (explicit.length > 0) {
    return explicit;
  }
  return agent.id === defaultAgentId ? defaultMainAgentToolIds : [];
}

function uniqueStrings(values: string[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed && !output.includes(trimmed)) {
      output.push(trimmed);
    }
  }
  return output;
}

export function toProviderMessages(context: BuiltContext): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  const systemPrompt = context.systemPrompt.trim();
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  for (const message of context.messages) {
    const content = message.content.trim();
    if (!content) {
      continue;
    }
    messages.push({ role: message.role, content });
  }
  return messages;
}
