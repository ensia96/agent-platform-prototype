import { normalizeReasoningEffort } from "../shared/run-options";
import type { ProviderMessage } from "../providers/types";
import type {
  AgentDefinition,
  BuiltContext,
  ContextPlan,
  ContextPlanRecord,
  JsonObject,
  MessagePart,
  ProviderProfile,
  ProviderResolution,
  RunOptions
} from "../shared/types";

export interface RunOptionPlan {
  requestedRunOptions: RunOptions;
  runOptions: RunOptions;
  unsupportedRunOptions: string[];
}

export interface RunExecutionSnapshot {
  providerProfileId: string;
  runOptions: RunOptions;
  requestedRunOptions: RunOptions;
  unsupportedRunOptions: string[];
  contextPolicy: AgentDefinition["contextPolicy"];
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
      runOptions.reasoningEffort = requestedRunOptions.reasoningEffort;
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
  const reasoningEffort = normalizeReasoningEffort(options.reasoningEffort);
  if (reasoningEffort) {
    output.reasoningEffort = reasoningEffort;
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
  userRunOptions: RunOptions,
  snapshotAt: string
): JsonObject {
  const metadata: JsonObject = {
    agentId: agent.id,
    agentName: agent.name,
    agent: agentToJson(agent),
    agentSnapshot: agentRunSnapshotToJson(agent, snapshotAt),
    executionSnapshot: {
      schemaVersion: 1,
      snapshotAt,
      providerProfileId: providerResolution.providerProfileId,
      runOptions: runOptionsToJson(optionPlan.runOptions),
      requestedRunOptions: runOptionsToJson(optionPlan.requestedRunOptions),
      unsupportedRunOptions: optionPlan.unsupportedRunOptions,
      contextPolicy: contextPolicyToJson(agent.contextPolicy)
    },
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

export function agentRunSnapshotToJson(agent: AgentDefinition, snapshotAt: string): JsonObject {
  return {
    schemaVersion: 1,
    snapshotAt,
    id: agent.id,
    revision: agent.revision,
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    modelProfileId: agent.modelProfileId,
    defaultRunOptions: runOptionsToJson(agent.defaultRunOptions ?? {}),
    contextPolicy: contextPolicyToJson(agent.contextPolicy),
    skillIds: uniqueStrings(agent.skillIds),
    toolIds: uniqueStrings(agent.toolIds),
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  };
}

export function agentFromRunMetadata(metadata: JsonObject): AgentDefinition | null {
  const value = metadata.agentSnapshot;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const snapshot = value as JsonObject;
  const schemaVersion = numberField(snapshot, "schemaVersion");
  const snapshotAt = stringField(snapshot, "snapshotAt");
  const id = stringField(snapshot, "id").trim();
  const name = stringField(snapshot, "name").trim();
  const systemPrompt = stringField(snapshot, "systemPrompt");
  const revision = numberField(snapshot, "revision");
  const createdAt = stringField(snapshot, "createdAt");
  const updatedAt = stringField(snapshot, "updatedAt");
  if (
    schemaVersion !== 1 ||
    !snapshotAt ||
    !id ||
    !name ||
    !systemPrompt.trim() ||
    revision === null ||
    revision < 1 ||
    !Number.isInteger(revision) ||
    !createdAt ||
    !updatedAt
  ) {
    return null;
  }
  return {
    id,
    revision,
    name,
    description: typeof snapshot.description === "string" ? snapshot.description : null,
    systemPrompt,
    modelProfileId: typeof snapshot.modelProfileId === "string" && snapshot.modelProfileId.trim() ? snapshot.modelProfileId : null,
    defaultRunOptions: nonEmptyRunOptions(runOptionsFromJson(snapshot.defaultRunOptions)),
    contextPolicy: contextPolicyFromJson(snapshot.contextPolicy),
    skillIds: stringArray(snapshot.skillIds),
    toolIds: stringArray(snapshot.toolIds),
    metadata: {},
    createdAt,
    updatedAt
  };
}

export function executionSnapshotFromRunMetadata(metadata: JsonObject): RunExecutionSnapshot | null {
  const value = metadata.executionSnapshot;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const snapshot = value as JsonObject;
  if (numberField(snapshot, "schemaVersion") !== 1 || !stringField(snapshot, "snapshotAt")) {
    return null;
  }
  const providerProfileId = stringField(snapshot, "providerProfileId").trim();
  const runOptions = runOptionsFromJson(snapshot.runOptions);
  const requestedRunOptions = runOptionsFromJson(snapshot.requestedRunOptions);
  const unsupportedRunOptions = Array.isArray(snapshot.unsupportedRunOptions)
    ? snapshot.unsupportedRunOptions.filter((value): value is string => typeof value === "string")
    : null;
  const contextPolicy = contextPolicyFromJson(snapshot.contextPolicy);
  if (!providerProfileId || !runOptions || !requestedRunOptions || !unsupportedRunOptions) {
    return null;
  }
  return { providerProfileId, runOptions, requestedRunOptions, unsupportedRunOptions, contextPolicy };
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

export function buildContextRunMetadata(
  context: BuiltContext,
  warnings: string[],
  skippedMessageIds: string[],
  initialRecord: ContextPlanRecord
): JsonObject {
  const metadata: JsonObject = {
    contextSnapshot: builtContextToJson(context, initialRecord.planId),
    contextBuilder: contextSummaryToJson(context, warnings, skippedMessageIds),
    contextPlanRecords: [contextPlanRecordToJson(initialRecord)],
    latestContextPlanId: initialRecord.planId
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
    skippedMessageIds,
    contextWindowTokens: context.plan.windowTokens,
    contextWindowSource: context.plan.windowSource,
    contextInputBudgetTokens: context.plan.inputBudgetTokens,
    estimatedContextInputTokens: context.plan.estimatedInputTokens,
    providerNeutralContextTokens: context.plan.providerNeutralTokens,
    nativeContextOverheadTokens: context.plan.nativeOverheadTokens,
    contextCapabilityStale: context.plan.capabilityStale,
    contextTrimmingApplied: context.plan.trimmingApplied,
    activeContextSegmentId: context.plan.activeSegmentId,
    inheritedContextArtifactId: context.plan.inheritedArtifactId,
    contextCompactionRecommended: context.plan.compactionRecommended,
    contextCompactionReason: context.plan.compactionReason
  };
}

function builtContextToJson(context: BuiltContext, contextPlanRef: string): JsonObject {
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
    metadata: context.metadata,
    contextPlanRef
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

export function contextPlanToJson(plan: ContextPlan): JsonObject {
  return {
    windowTokens: plan.windowTokens,
    windowSource: plan.windowSource,
    reservedOutputTokens: plan.reservedOutputTokens,
    safetyMarginTokens: plan.safetyMarginTokens,
    inputBudgetTokens: plan.inputBudgetTokens,
    estimatedInputTokens: plan.estimatedInputTokens,
    providerNeutralTokens: plan.providerNeutralTokens,
    nativeOverheadTokens: plan.nativeOverheadTokens,
    capabilityStale: plan.capabilityStale,
    historyWatermark: plan.historyWatermark,
    historyThroughMessageId: plan.historyThroughMessageId,
    selectedHistoryFromMessageId: plan.selectedHistoryFromMessageId,
    selectedHistoryThroughMessageId: plan.selectedHistoryThroughMessageId,
    activeSegmentId: plan.activeSegmentId,
    inheritedArtifactId: plan.inheritedArtifactId,
    preTrimEstimatedInputTokens: plan.preTrimEstimatedInputTokens,
    compactionRecommended: plan.compactionRecommended,
    compactionReason: plan.compactionReason,
    included: plan.included.map(contextPlanItemToJson),
    omitted: plan.omitted.map(contextPlanItemToJson),
    trimmingApplied: plan.trimmingApplied,
    estimatorVersion: plan.estimatorVersion
  };
}

export function contextPlanRecordToJson(record: ContextPlanRecord): JsonObject {
  return {
    planId: record.planId,
    providerTurn: record.providerTurn,
    toolIteration: record.toolIteration,
    createdAt: record.createdAt,
    plan: contextPlanToJson(record.plan)
  };
}

function contextPlanItemToJson(item: ContextPlan["included"][number]): JsonObject {
  return {
    kind: item.kind,
    sourceIds: item.sourceIds,
    estimatedTokens: item.estimatedTokens,
    retention: item.retention,
    ...(item.reason ? { reason: item.reason } : {})
  };
}

function contextMessageToJson(message: BuiltContext["messages"][number]): JsonObject {
  if (message.source === "compaction") {
    return {
      role: message.role,
      source: message.source,
      messageId: message.messageId ?? null,
      artifactRef: message.metadata?.artifactId ?? message.messageId ?? null,
      contentLength: message.content.length
    };
  }
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
    revision: agent.revision,
    name: agent.name,
    description: agent.description,
    modelProfileId: agent.modelProfileId,
    defaultRunOptions: runOptionsToJson(agent.defaultRunOptions ?? {}),
    contextPolicy: contextPolicyToJson(agent.contextPolicy),
    skillIds: agent.skillIds,
    toolIds: agent.toolIds,
    metadata: agent.metadata,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  };
  return output;
}

export function effectiveAgentToolIds(agent: AgentDefinition): string[] {
  return uniqueStrings(agent.toolIds);
}

export function runOptionsFromJson(value: unknown): RunOptions | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const object = value as JsonObject;
  const options = cleanRunOptions({
    model: stringField(object, "model") || undefined,
    reasoningEffort: stringField(object, "reasoningEffort") || undefined,
    temperature: numberField(object, "temperature") ?? undefined
  });
  return options;
}

function contextPolicyToJson(policy: AgentDefinition["contextPolicy"]): JsonObject {
  const output: JsonObject = {};
  if (policy?.contextWindowTokensOverride !== undefined) {
    output.contextWindowTokensOverride = policy.contextWindowTokensOverride;
  }
  if (policy?.reservedOutputTokens !== undefined) {
    output.reservedOutputTokens = policy.reservedOutputTokens;
  }
  if (policy?.safetyMarginRatio !== undefined) {
    output.safetyMarginRatio = policy.safetyMarginRatio;
  }
  if (policy?.automaticCompaction !== undefined) {
    output.automaticCompaction = policy.automaticCompaction;
  }
  return output;
}

function contextPolicyFromJson(value: unknown): AgentDefinition["contextPolicy"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const object = value as JsonObject;
  const policy: NonNullable<AgentDefinition["contextPolicy"]> = {};
  const windowTokens = numberField(object, "contextWindowTokensOverride");
  const reservedOutputTokens = numberField(object, "reservedOutputTokens");
  const safetyMarginRatio = numberField(object, "safetyMarginRatio");
  if (windowTokens !== null) {
    policy.contextWindowTokensOverride = windowTokens;
  }
  if (reservedOutputTokens !== null) {
    policy.reservedOutputTokens = reservedOutputTokens;
  }
  if (safetyMarginRatio !== null) {
    policy.safetyMarginRatio = safetyMarginRatio;
  }
  if (typeof object.automaticCompaction === "boolean") {
    policy.automaticCompaction = object.automaticCompaction;
  }
  return Object.keys(policy).length > 0 ? policy : null;
}

function nonEmptyRunOptions(options: RunOptions | null): RunOptions | null {
  return options && Object.keys(options).length > 0 ? options : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? uniqueStrings(value.filter((item): item is string => typeof item === "string")) : [];
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
