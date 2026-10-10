import type {
  AgentContextPolicy,
  ContextCandidate,
  ContextMessage,
  ContextPlan,
  ContextPlanItem,
  ContextWindowSource,
  JsonObject,
  ModelContextCapability,
  ModelToolDefinition,
  ProviderContextPlanningProfile
} from "../shared/types";
import { toolExchangeText } from "./tool-transcript";
import { MessageVO } from "@/kernel/message/vo";

export const contextEstimatorVersion = "conservative-utf8-v1";
export const assumedContextWindowTokens = 16_384;
export const defaultReservedOutputTokens = 2_048;
export const defaultSafetyMarginRatio = 0.1;
export const recentContextTurnCount = 2;
export const historicalContextTextMaxChars = 4_000;

export interface ResolvedContextBudget {
  windowTokens: number;
  windowSource: ContextWindowSource;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  inputBudgetTokens: number;
  capabilityStale: boolean;
}

export interface PlanContextInput {
  systemPrompt: string;
  messages: ContextMessage[];
  availableTools: ModelToolDefinition[];
  budget: ResolvedContextBudget;
  currentMessageId?: string;
  providerOverhead?: ProviderContextPlanningProfile;
  activeSegmentId?: string;
  inheritedArtifactId?: string;
}

export interface PlannedContext {
  messages: ContextMessage[];
  plan: ContextPlan;
}

interface TurnCandidate {
  candidate: ContextPlanItem;
  messages: ContextMessage[];
  order: number;
}

interface GroupedTurns {
  finalized: TurnCandidate[];
  omitted: ContextPlanItem[];
}

export class ContextBudgetExceededError extends Error {
  readonly code: string = "context_budget_exceeded";

  constructor(
    message: string,
    readonly details: {
      windowTokens: number;
      inputBudgetTokens: number;
      requiredTokens: number;
      sourceIds: string[];
    }
  ) {
    super(message);
    this.name = "ContextBudgetExceededError";
  }
}

export class ContextSummaryExceedsBudgetError extends ContextBudgetExceededError {
  override readonly code = "context_summary_exceeds_budget";

  constructor(message: string, details: ConstructorParameters<typeof ContextBudgetExceededError>[1], readonly artifactId: string | null) {
    super(message, details);
    this.name = "ContextSummaryExceedsBudgetError";
  }
}

export class InvalidContextPolicyError extends Error {
  readonly code = "invalid_context_policy";

  constructor(
    message: string,
    readonly details: { windowTokens: number; reservedOutputTokens: number; safetyMarginTokens: number }
  ) {
    super(message);
    this.name = "InvalidContextPolicyError";
  }
}

export function resolveContextBudget(
  capability: ModelContextCapability | null | undefined,
  policy: AgentContextPolicy | null | undefined
): ResolvedContextBudget {
  const windowTokens = policy?.contextWindowTokensOverride ?? capability?.windowTokens ?? assumedContextWindowTokens;
  const windowSource: ContextWindowSource = policy?.contextWindowTokensOverride ? "user" : capability?.source ?? "assumed";
  const reservedOutputTokens = policy?.reservedOutputTokens ?? Math.min(defaultReservedOutputTokens, Math.max(256, Math.floor(windowTokens / 8)));
  const safetyMarginRatio = policy?.safetyMarginRatio ?? defaultSafetyMarginRatio;
  const safetyMarginTokens = Math.floor(windowTokens * safetyMarginRatio);
  const inputBudgetTokens = windowTokens - reservedOutputTokens - safetyMarginTokens;
  if (inputBudgetTokens <= 0) {
    throw new InvalidContextPolicyError(
      `Context policy reserves ${reservedOutputTokens + safetyMarginTokens} tokens from a ${windowTokens}-token window.`,
      { windowTokens, reservedOutputTokens, safetyMarginTokens }
    );
  }
  return {
    windowTokens,
    windowSource,
    reservedOutputTokens,
    safetyMarginTokens,
    inputBudgetTokens,
    capabilityStale: policy?.contextWindowTokensOverride ? false : capability?.stale === true
  };
}

export function contextBudgetFromMetadata(value: unknown): ResolvedContextBudget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const object = value as JsonObject;
  const windowTokens = positiveInteger(object.windowTokens);
  const reservedOutputTokens = nonNegativeInteger(object.reservedOutputTokens);
  const safetyMarginTokens = nonNegativeInteger(object.safetyMarginTokens);
  const inputBudgetTokens = positiveInteger(object.inputBudgetTokens);
  const windowSource = object.windowSource;
  if (
    windowTokens === null ||
    reservedOutputTokens === null ||
    safetyMarginTokens === null ||
    inputBudgetTokens === null ||
    (windowSource !== "provider" && windowSource !== "adapter" && windowSource !== "user" && windowSource !== "assumed")
  ) {
    return null;
  }
  if (windowTokens - reservedOutputTokens - safetyMarginTokens !== inputBudgetTokens) {
    return null;
  }
  return {
    windowTokens,
    windowSource,
    reservedOutputTokens,
    safetyMarginTokens,
    inputBudgetTokens,
    capabilityStale: object.capabilityStale === true
  };
}

export function planContext(input: PlanContextInput): PlannedContext {
  const providerOverhead = input.providerOverhead ?? {
    requiredInstructions: [],
    fixedWrapperTokens: 32,
    perMessageTokens: 8,
    toolEnvelopeTokens: 24
  };
  const systemCandidate: ContextPlanItem = {
    kind: "system",
    sourceIds: ["agent-system-prompt", "runtime-context"],
    estimatedTokens: estimateTextTokens(input.systemPrompt),
    retention: "required"
  };
  const toolCandidate: ContextPlanItem | null =
    input.availableTools.length > 0
      ? {
          kind: "tool_schema",
          sourceIds: input.availableTools.map((tool) => tool.id),
          estimatedTokens: estimateJsonTokens(
            input.availableTools.map((tool) => ({
              id: tool.id,
              providerName: tool.providerName,
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema
            }))
          ),
          retention: "required"
        }
      : null;

  const normalizedMessages = input.messages.map((message) => (message.source === "synthetic" ? boundContextMessage(message) : message));
  const currentMessages = normalizedMessages.filter(
    (message) => message.source === "current" || (input.currentMessageId && message.messageId === input.currentMessageId)
  );
  const compactionMessages = normalizedMessages.filter((message) => message.source === "compaction");
  let syntheticMessages = normalizedMessages.filter((message) => message.source === "synthetic");
  const historicalMessages = normalizedMessages.filter(
    (message) => !currentMessages.includes(message) && !syntheticMessages.includes(message) && !compactionMessages.includes(message)
  );
  const grouped = groupAtomicTurns(historicalMessages);
  const turns = grouped.finalized;
  const recentStart = Math.max(0, turns.length - recentContextTurnCount);
  for (let index = 0; index < turns.length; index += 1) {
    turns[index].candidate.retention = index >= recentStart ? "recent" : "compressible";
  }

  const currentCandidate = messageCandidate("current_input", currentMessages, "required");
  const compactionCandidate: ContextPlanItem | null =
    compactionMessages.length > 0
      ? {
          kind: "compaction_summary",
          sourceIds: compactionMessages.flatMap(messageSourceIds),
          estimatedTokens: estimateMessagesTokens(compactionMessages),
          retention: "required",
          reason: "inherited_cumulative_summary"
        }
      : null;
  const nativeBaseTokens =
    providerOverhead.fixedWrapperTokens +
    providerOverhead.requiredInstructions.reduce((total, instruction) => total + estimateTextTokens(instruction.content), 0) +
    providerOverhead.perMessageTokens * messageEnvelopeCount(currentMessages) +
    providerOverhead.perMessageTokens * messageEnvelopeCount(compactionMessages) +
    (input.availableTools.length > 0 ? providerOverhead.toolEnvelopeTokens : 0);
  const neutralWithoutSynthetic =
    systemCandidate.estimatedTokens +
    (toolCandidate?.estimatedTokens ?? 0) +
    (currentCandidate?.candidate.estimatedTokens ?? 0) +
    (compactionCandidate?.estimatedTokens ?? 0);
  const syntheticTokenBudget =
    input.budget.inputBudgetTokens - neutralWithoutSynthetic - nativeBaseTokens - providerOverhead.perMessageTokens * messageEnvelopeCount(syntheticMessages);
  const fittedSynthetic = fitMessagesToTokenBudget(syntheticMessages, syntheticTokenBudget);
  const syntheticWasBounded = Boolean(
    fittedSynthetic && syntheticMessages.some((message, index) => message.content !== fittedSynthetic[index]?.content)
  );
  if (fittedSynthetic) {
    syntheticMessages = fittedSynthetic;
  }
  const syntheticCandidate = messageCandidate("tool_result", syntheticMessages, "required");
  if (syntheticCandidate && syntheticWasBounded) {
    syntheticCandidate.candidate.reason = "active_tool_result_bounded";
  }
  const required = [
    systemCandidate,
    ...(compactionCandidate ? [compactionCandidate] : []),
    ...(toolCandidate ? [toolCandidate] : []),
    ...(currentCandidate ? [currentCandidate.candidate] : []),
    ...(syntheticCandidate ? [syntheticCandidate.candidate] : [])
  ];
  const requiredNativeTokens = nativeBaseTokens + providerOverhead.perMessageTokens * messageEnvelopeCount(syntheticMessages);
  const requiredNeutralTokens = required.reduce((total, candidate) => total + candidate.estimatedTokens, 0);
  const requiredTokens = requiredNeutralTokens + requiredNativeTokens;
  if (requiredTokens > input.budget.inputBudgetTokens) {
    if (compactionCandidate) {
      throw new ContextSummaryExceedsBudgetError(
        `Inherited continuity summary and required context are estimated at ${requiredTokens} tokens, exceeding the ${input.budget.inputBudgetTokens}-token input budget. Use Compact now to create a smaller summary.`,
        {
          windowTokens: input.budget.windowTokens,
          inputBudgetTokens: input.budget.inputBudgetTokens,
          requiredTokens,
          sourceIds: required.flatMap((candidate) => candidate.sourceIds)
        },
        input.inheritedArtifactId ?? null
      );
    }
    throw new ContextBudgetExceededError(
      `Required context is estimated at ${requiredTokens} tokens, exceeding the ${input.budget.inputBudgetTokens}-token input budget.`,
      {
        windowTokens: input.budget.windowTokens,
        inputBudgetTokens: input.budget.inputBudgetTokens,
        requiredTokens,
        sourceIds: required.flatMap((candidate) => candidate.sourceIds)
      }
    );
  }

  let providerNeutralTokens = requiredNeutralTokens;
  let nativeOverheadTokens = requiredNativeTokens;
  let estimatedInputTokens = requiredTokens;
  const includedTurns = new Set<TurnCandidate>();
  const omitted: ContextPlanItem[] = [...grouped.omitted];
  let suffixBoundaryReached = false;
  for (const turn of [...turns].reverse()) {
    const turnNativeTokens = providerOverhead.perMessageTokens * messageEnvelopeCount(turn.messages);
    if (!suffixBoundaryReached && estimatedInputTokens + turn.candidate.estimatedTokens + turnNativeTokens <= input.budget.inputBudgetTokens) {
      includedTurns.add(turn);
      providerNeutralTokens += turn.candidate.estimatedTokens;
      nativeOverheadTokens += turnNativeTokens;
      estimatedInputTokens += turn.candidate.estimatedTokens + turnNativeTokens;
    } else {
      const reason = suffixBoundaryReached ? "before_selected_suffix_boundary" : "suffix_boundary_turn_exceeds_budget";
      suffixBoundaryReached = true;
      omitted.push({
        ...turn.candidate,
        reason
      });
    }
  }

  const selectedTurns = turns.filter((turn) => includedTurns.has(turn));
  const selectedMessages = [
    ...compactionMessages,
    ...selectedTurns.flatMap((turn) => turn.messages),
    ...currentMessages,
    ...syntheticMessages
  ];
  const included: ContextPlanItem[] = [
    systemCandidate,
    ...(compactionCandidate ? [compactionCandidate] : []),
    ...(toolCandidate ? [toolCandidate] : []),
    ...selectedTurns.map((turn) => turn.candidate),
    ...(currentCandidate ? [currentCandidate.candidate] : []),
    ...(syntheticCandidate ? [syntheticCandidate.candidate] : [])
  ];
  const historySourceIds = historicalMessages.flatMap(messageSourceIds);
  const selectedHistorySourceIds = selectedTurns.flatMap((turn) => turn.candidate.sourceIds);
  const allHistoryTokens = turns.reduce(
    (total, turn) => total + turn.candidate.estimatedTokens + providerOverhead.perMessageTokens * messageEnvelopeCount(turn.messages),
    0
  );
  const preTrimEstimatedInputTokens = requiredTokens + allHistoryTokens;
  const contextTextBounded = normalizedMessages.some(
    (message, index) =>
      message.content !== input.messages[index]?.content ||
      message.metadata?.contextTextBounded === true ||
      message.parts?.some((part) => part.metadata?.contextTextBounded === true)
  );
  const trimmingApplied = omitted.length > 0 || contextTextBounded;
  const compactionRecommended = trimmingApplied || preTrimEstimatedInputTokens >= Math.floor(input.budget.inputBudgetTokens * 0.82);
  const plan: ContextPlan = {
    ...input.budget,
    estimatedInputTokens,
    providerNeutralTokens,
    nativeOverheadTokens,
    historyWatermark: historySourceIds.at(-1) ?? null,
    historyThroughMessageId: historySourceIds.at(-1) ?? null,
    selectedHistoryFromMessageId: selectedHistorySourceIds[0] ?? null,
    selectedHistoryThroughMessageId: selectedHistorySourceIds.at(-1) ?? null,
    activeSegmentId: input.activeSegmentId ?? null,
    inheritedArtifactId: input.inheritedArtifactId ?? null,
    preTrimEstimatedInputTokens,
    compactionRecommended,
    compactionReason: trimmingApplied ? "trimming_applied" : compactionRecommended ? "budget_threshold" : null,
    included,
    omitted: omitted.sort((left, right) => firstSourceOrder(left.sourceIds, turns) - firstSourceOrder(right.sourceIds, turns)),
    trimmingApplied,
    estimatorVersion: contextEstimatorVersion
  };
  return { messages: selectedMessages, plan };
}

export function estimateTextTokens(text: string): number {
  if (!text) {
    return 0;
  }
  const bytes = new TextEncoder().encode(text).length;
  const punctuation = (text.match(/[{}[\](),.:;<>/=+*_-]/g) ?? []).length;
  const lineBreaks = (text.match(/\n/g) ?? []).length;
  return Math.max(1, Math.ceil(bytes / 3), Math.ceil(text.length / 3.5)) + Math.ceil(punctuation / 12) + lineBreaks;
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTextTokens(stableJson(value));
}

export function boundHistoricalContextText(text: string, maxChars = historicalContextTextMaxChars): string {
  if (text.length <= maxChars) {
    return text;
  }
  const marker = `\n… [context-only truncation: ${text.length - maxChars} chars omitted] …\n`;
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${text.slice(0, headLength)}${marker}${tailLength > 0 ? text.slice(-tailLength) : ""}`;
}

function boundContextMessage(message: ContextMessage): ContextMessage {
  if (message.toolExchange) return boundToolExchange(message,historicalContextTextMaxChars);
  const content = boundHistoricalContextText(message.content);
  return content === message.content
    ? message
    : {
        ...message,
        content,
        metadata: { ...(message.metadata ?? {}), contextTextBounded: true, originalContextChars: message.content.length }
      };
}

function groupAtomicTurns(messages: ContextMessage[]): GroupedTurns {
  const groups: ContextMessage[][] = [];
  const omitted: ContextPlanItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      groups.push([message]);
    } else if (groups.length > 0) {
      groups[groups.length - 1].push(message);
    } else {
      omitted.push({
        kind: "message_turn",
        sourceIds: messageSourceIds(message),
        estimatedTokens: estimateMessagesTokens([message]),
        retention: "discardable",
        reason: "orphan_assistant_excluded"
      });
    }
  }
  const finalized: TurnCandidate[] = [];
  for (const [order, turnMessages] of groups.entries()) {
    const candidate: ContextCandidate = {
      kind: "message_turn",
      sourceIds: turnMessages.flatMap(messageSourceIds),
      estimatedTokens: estimateMessagesTokens(turnMessages),
      retention: "compressible"
    };
    const hasCompletedAssistant = turnMessages.some(
      (message) =>
        message.role === "assistant" &&
        (message.metadata?.status === undefined || new MessageVO.Status(message.metadata.status).isCompleted())
    );
    if (!hasCompletedAssistant) {
      omitted.push({ ...candidate, retention: "discardable", reason: "unfinished_user_turn_excluded" });
      continue;
    }
    finalized.push({ candidate, messages: turnMessages, order });
  }
  return { finalized, omitted };
}

function messageCandidate(
  kind: "current_input" | "tool_result",
  messages: ContextMessage[],
  retention: "required"
): TurnCandidate | null {
  return messages.length > 0
    ? {
        candidate: {
          kind,
          sourceIds: messages.flatMap(messageSourceIds),
          estimatedTokens: estimateMessagesTokens(messages),
          retention
        },
        messages,
        order: Number.MAX_SAFE_INTEGER
      }
    : null;
}

function estimateMessagesTokens(messages: ContextMessage[]): number {
  return messages.reduce((total, message) => total + (message.toolExchange ? estimateJsonTokens(message.toolExchange) : estimateTextTokens(message.content)), 0);
}

function messageEnvelopeCount(messages: ContextMessage[]): number {
  return messages.reduce((total,message) => total + (message.toolExchange
    ? message.toolExchange.calls.length + message.toolExchange.results.length + 1 : 1),0);
}

function messageSourceIds(message: ContextMessage): string[] {
  if (message.toolExchange) return message.toolExchange.sourceIds;
  if (message.messageId) {
    return [message.messageId];
  }
  const sourcePartIds = message.parts?.flatMap((part) => (part.sourcePartId ? [part.sourcePartId] : [])) ?? [];
  return sourcePartIds.length > 0 ? sourcePartIds : [message.source === "current" ? "current-input" : "synthetic-tool-result"];
}

function fitMessagesToTokenBudget(messages: ContextMessage[], tokenBudget: number): ContextMessage[] | null {
  if (messages.length === 0) {
    return [];
  }
  if (tokenBudget <= 0) {
    return null;
  }
  if (estimateMessagesTokens(messages) <= tokenBudget) {
    return messages;
  }
  const perMessageBudget = Math.max(1, Math.floor(tokenBudget / messages.length));
  const fitted = messages.map((message) => {
    if (message.toolExchange) {
      let low = 1, high = historicalContextTextMaxChars;
      let best = boundToolExchange(message,1);
      while (low <= high) {
        const middle = Math.floor((low+high)/2);
        const candidate = boundToolExchange(message,middle);
        if (estimateMessagesTokens([candidate]) <= perMessageBudget) { best=candidate; low=middle+1; }
        else high=middle-1;
      }
      return best;
    }
    return { ...message, content: fitTextToTokenBudget(message.content, perMessageBudget),
      metadata: { ...(message.metadata ?? {}), contextTextBounded: true, activeToolBudgetBounded: true } };
  });
  return fitted.every((message) => message.content.length > 0) && estimateMessagesTokens(fitted) <= tokenBudget ? fitted : null;
}

function boundToolExchange(message: ContextMessage, maxOutputChars: number): ContextMessage {
  const original = message.toolExchange!;
  const toolExchange = {...original,results:original.results.map((result) => ({...result,output:boundHistoricalContextText(result.output,maxOutputChars)}))};
  const bounded = toolExchange.results.some((result,index) => result.output !== original.results[index].output);
  return {...message,toolExchange,content:toolExchangeText(toolExchange),
    ...(bounded ? {metadata:{...(message.metadata??{}),contextTextBounded:true,activeToolBudgetBounded:true}} : {})};
}

function fitTextToTokenBudget(text: string, tokenBudget: number): string {
  if (estimateTextTokens(text) <= tokenBudget) {
    return text;
  }
  let low = 1;
  let high = text.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = boundHistoricalContextText(text, middle);
    if (estimateTextTokens(candidate) <= tokenBudget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as JsonObject;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function firstSourceOrder(sourceIds: string[], turns: TurnCandidate[]): number {
  return turns.find((turn) => turn.candidate.sourceIds.some((id) => sourceIds.includes(id)))?.order ?? Number.MAX_SAFE_INTEGER;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
