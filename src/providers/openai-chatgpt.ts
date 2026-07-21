import { refreshOpenAIChatGPTCredential } from "./openai-chatgpt-auth";
import { extractRunUsage } from "./usage";
import {
  defaultOpenAIChatGPTEndpoint,
  defaultOpenAIChatGPTIssuer,
  defaultOpenAIChatGPTModel,
  isCredentialExpired,
  type OpenAIChatGPTCredential,
  type OpenAIChatGPTCredentialStore
} from "./openai-chatgpt-credentials";
import type {
  ProviderAdapter,
  ProviderCredential,
  ProviderReasoningDetailRecord,
  ProviderReasoningSummaryRecord,
  ProviderRunContext,
  ProviderRunInput,
  ProviderRunResult,
  ProviderToolCall
} from "./types";
import type {
  BuiltContext,
  JsonObject,
  ModelToolDefinition,
  ProviderProfile,
  ProviderStatus,
  ProviderTestResponse,
  RunUsage
} from "../shared/types";

const refreshSkewMs = 60_000;
const defaultCodexInstructions =
  "You are ChatGPT, a helpful assistant. Answer the user's message directly and concisely unless they ask for more detail.";
const diagnosticBodyPreviewLimit = 1000;

interface ChatGPTCodexRequestPayload {
  model: string;
  instructions: string;
  store: false;
  stream: true;
  reasoning: {
    summary: "auto";
  };
  tools?: Array<{
    type: "function";
    name: string;
    description: string;
    parameters: JsonObject;
  }>;
  tool_choice?: "auto";
  input: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
}

interface ProviderErrorDiagnostic {
  status?: number;
  statusText?: string;
  code?: string;
  type?: string;
  message: string;
  bodyPreview?: string;
}

interface OpenAIChatGPTProviderOptions {
  credentialStore: OpenAIChatGPTCredentialStore;
  issuer?: string;
  endpoint?: string;
  clientId?: string;
}

export class OpenAIChatGPTProvider implements ProviderAdapter {
  readonly id = "openai-chatgpt";
  readonly label = "OpenAI ChatGPT OAuth Codex provider";

  private readonly credentialStore: OpenAIChatGPTCredentialStore;
  private readonly issuer: string;
  private readonly endpoint: string;
  private readonly clientId?: string;
  private refreshPromise: Promise<OpenAIChatGPTCredential> | null = null;

  constructor(options: OpenAIChatGPTProviderOptions) {
    this.credentialStore = options.credentialStore;
    this.issuer = options.issuer?.trim() || defaultOpenAIChatGPTIssuer;
    this.endpoint = options.endpoint?.trim() || defaultOpenAIChatGPTEndpoint;
    this.clientId = options.clientId?.trim() || undefined;
  }

  async test(profile: ProviderProfile, credential: ProviderCredential): Promise<ProviderTestResponse> {
    const checkedAt = new Date().toISOString();
    const startedAt = Date.now();

    if (!credential.oauth) {
      const status: ProviderStatus = {
        state: profile.status.state === "error" ? "error" : "needs_auth",
        message:
          profile.status.state === "error"
            ? profile.status.message
            : "OpenAI ChatGPT OAuth is not connected. Use Connect to start the device authorization flow.",
        credentialStatus: "missing",
        checkedAt,
        errorCode: profile.status.state === "error" ? profile.status.errorCode : "auth_required"
      };
      return {
        ok: false,
        profile: { ...profile, status },
        status,
        code: status.state === "error" ? "connection_failed" : "auth_required",
        message: status.message,
        checkedAt,
        details: publicDetails(profile)
      };
    }

    try {
      const usable = await this.ensureUsableCredential(credential.oauth as OpenAIChatGPTCredential);
      const status: ProviderStatus = {
        state: "connected",
        message: `OpenAI ChatGPT OAuth credential is available for ${getModel(profile)}.`,
        credentialStatus: "present",
        checkedAt
      };
      return {
        ok: true,
        profile: { ...profile, status },
        status,
        message: status.message,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        details: {
          ...publicDetails(profile),
          expiresAt: new Date(usable.expiresAt).toISOString(),
          accountIdPresent: Boolean(usable.accountId)
        }
      };
    } catch (error) {
      const status: ProviderStatus = {
        state: "error",
        message: `OpenAI ChatGPT OAuth refresh failed: ${toErrorMessage(error)}`,
        credentialStatus: "expired",
        checkedAt,
        errorCode: "refresh_failed"
      };
      return {
        ok: false,
        profile: { ...profile, status },
        status,
        code: "refresh_failed",
        message: status.message,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        details: publicDetails(profile)
      };
    }
  }

  async run(input: ProviderRunInput, context: ProviderRunContext): Promise<ProviderRunResult> {
    if (!input.credential.oauth) {
      if (input.profile.status.state === "error") {
        throw new Error(input.profile.status.message);
      }
      throw new Error("OpenAI ChatGPT authentication required. Open Settings → Providers → OpenAI ChatGPT and connect first.");
    }

    const credential = await this.ensureUsableCredential(input.credential.oauth as OpenAIChatGPTCredential);
    const endpoint = getEndpoint(input.profile);
    const headers = new Headers({
      Authorization: `Bearer ${credential.access}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": "agent-platform-prototype/0.0.0",
      originator: "agent-platform-prototype",
      "session-id": input.session.id
    });
    if (credential.accountId) {
      headers.set("ChatGPT-Account-Id", credential.accountId);
    }

    const payload = buildCodexRequestPayload(input);
    if ((payload.tools?.length ?? 0) > 0) {
      await context.writer.writeMetadata({
        toolTranslation: {
          provider: this.id,
          native: true,
          experimental: true,
          requestFormat: "chatgpt-codex-responses-function",
          availableToolIds: input.context.availableTools.map((tool) => tool.id),
          providerToolNames: input.context.availableTools.map((tool) => tool.providerName)
        }
      });
    }
    logDebug("request", {
      endpoint,
      model: payload.model,
      store: payload.store,
      stream: payload.stream,
      toolSchemaCount: payload.tools?.length ?? 0,
      inputMessages: payload.input.length,
      hasInstructions: payload.instructions.trim().length > 0,
      requestedReasoningEffort: input.requestedRunOptions.reasoningEffort ?? null,
      reasoningEffortSent: false,
      reasoningSummaryRequested: payload.reasoning.summary,
      accountIdPresent: Boolean(credential.accountId)
    });

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: context.signal
    });

    if (!response.ok) {
      const diagnostic = await responseErrorDiagnostic(response);
      console.warn("OpenAI ChatGPT Codex request failed", diagnostic);
      throw new Error(formatProviderError("OpenAI ChatGPT Codex provider failed", diagnostic));
    }

    if (!response.body) {
      throw new Error("OpenAI ChatGPT Codex provider returned an empty response body");
    }

    const toolCalls = await parseOpenAIChatGPTStream(response.body, context);
    return { toolCalls };
  }

  private async ensureUsableCredential(credential: OpenAIChatGPTCredential): Promise<OpenAIChatGPTCredential> {
    if (!isCredentialExpired(credential, Date.now() + refreshSkewMs)) {
      return credential;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = refreshOpenAIChatGPTCredential(credential, {
        issuer: this.issuer,
        clientId: this.clientId,
        endpoint: this.endpoint
      })
        .then(async (refreshed) => {
          await this.credentialStore.write(refreshed);
          return refreshed;
        })
        .finally(() => {
          this.refreshPromise = null;
        });
    }

    return this.refreshPromise;
  }
}

export function buildCodexRequestPayload(input: ProviderRunInput): ChatGPTCodexRequestPayload {
  const systemInstructions = input.context.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean);
  const instructions = [defaultCodexInstructions, input.context.systemPrompt.trim(), ...systemInstructions].filter(Boolean).join("\n\n").trim();
  const inputMessages = buildCodexInputMessages(input.context);

  // The ChatGPT/Codex backend's public contract for reasoning effort is not stable.
  // Keep requested reasoning effort in run metadata for now rather than risking the known-good payload shape.
  const payload: ChatGPTCodexRequestPayload = {
    model: getRunModel(input),
    instructions,
    store: false,
    stream: true,
    reasoning: { summary: "auto" },
    input: inputMessages
  };
  if (input.context.availableTools.length > 0) {
    payload.tools = buildCodexTools(input.context.availableTools);
    payload.tool_choice = "auto";
  }
  return payload;
}

function buildCodexInputMessages(context: BuiltContext): Array<{ role: "user" | "assistant"; content: string }> {
  return context.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: normalizeInputRole(message.role),
      content: message.content.trim()
    }))
    .filter((message) => message.content.length > 0);
}

export async function parseOpenAIChatGPTStream(
  stream: ReadableStream<Uint8Array>,
  context: ProviderRunContext
): Promise<ProviderToolCall[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCallStates = new Map<string, ChatGPTToolCallState>();
  const reasoningSummaryState: ChatGPTReasoningTextState = { items: new Map(), nextOrder: 0 };
  const reasoningDetailState: ChatGPTReasoningTextState = { items: new Map(), nextOrder: 0 };

  try {
    while (true) {
      if (context.signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw createAbortError();
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const finished = await handleStreamEvent(rawEvent, context, toolCallStates, reasoningSummaryState, reasoningDetailState);
        if (finished) {
          return finalizeChatGPTToolCalls(toolCallStates);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      await handleStreamEvent(buffer, context, toolCallStates, reasoningSummaryState, reasoningDetailState);
    }
  } finally {
    reader.releaseLock();
  }

  return finalizeChatGPTToolCalls(toolCallStates);
}

async function handleStreamEvent(
  rawEvent: string,
  context: ProviderRunContext,
  toolCallStates: Map<string, ChatGPTToolCallState>,
  reasoningSummaryState: ChatGPTReasoningTextState,
  reasoningDetailState: ChatGPTReasoningTextState
): Promise<boolean> {
  const data = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();

  if (!data) {
    return false;
  }

  if (data === "[DONE]") {
    return true;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse OpenAI ChatGPT SSE event (${toErrorMessage(error)})`);
  }

  const streamError = streamErrorDiagnostic(parsed);
  if (streamError) {
    console.warn("OpenAI ChatGPT Codex stream failed", streamError);
    throw new Error(formatProviderError("OpenAI ChatGPT Codex stream failed", streamError));
  }

  const usage = extractRunUsage(parsed);
  if (usage) {
    await context.writer.writeUsage(usage);
  }

  await collectChatGPTReasoningSummaryEvent(parsed, reasoningSummaryState, context, usage);
  await collectChatGPTReasoningDetailEvent(parsed, reasoningDetailState, context, usage);
  collectChatGPTToolCallEvent(parsed, toolCallStates);

  for (const delta of extractTextDeltas(parsed)) {
    await context.writer.writeDelta(delta);
  }

  return false;
}

interface ChatGPTToolCallState {
  key: string;
  id?: string;
  callId?: string;
  name?: string;
  argumentsText: string;
}

interface ChatGPTReasoningTextItemState {
  key: string;
  itemId?: string;
  outputIndex?: number;
  order: number;
  segments: Map<number, string>;
  finalizedSegments: Set<number>;
  finalized: boolean;
}

interface ChatGPTReasoningTextState {
  items: Map<string, ChatGPTReasoningTextItemState>;
  nextOrder: number;
}

async function collectChatGPTReasoningSummaryEvent(
  value: unknown,
  state: ChatGPTReasoningTextState,
  context: ProviderRunContext,
  usage: RunUsage | null
): Promise<void> {
  if (!isRecord(value)) {
    return;
  }

  const eventType = typeof value.type === "string" ? value.type : "";
  if (eventType === "response.output_item.done") {
    const item = isRecord(value.item) ? value.item : isRecord(value.output_item) ? value.output_item : null;
    if (!item || item.type !== "reasoning" || !Array.isArray(item.summary)) {
      return;
    }

    const itemState = reasoningTextItemState(value, item, state);
    itemState.segments.clear();
    for (let index = 0; index < item.summary.length; index += 1) {
      const summaryPart = item.summary[index];
      if (!isRecord(summaryPart) || summaryPart.type !== "summary_text" || typeof summaryPart.text !== "string") {
        continue;
      }
      itemState.segments.set(index, summaryPart.text);
    }
    itemState.finalizedSegments = new Set(itemState.segments.keys());
    itemState.finalized = true;
    await writeReasoningSummarySnapshot(state, itemState, context, eventType, true, usage);
    return;
  }

  if (
    eventType !== "response.reasoning_summary_part.added" &&
    eventType !== "response.reasoning_summary_text.delta" &&
    eventType !== "response.reasoning_summary_text.done"
  ) {
    return;
  }

  const item = isRecord(value.item) ? value.item : null;
  const itemState = reasoningTextItemState(value, item, state);
  const summaryIndex = nonNegativeInteger(value.summary_index) ?? nonNegativeInteger(value.part_index) ?? 0;

  if (eventType === "response.reasoning_summary_part.added") {
    if (itemState.finalized || itemState.finalizedSegments.has(summaryIndex)) {
      return;
    }
    const part = isRecord(value.part) ? value.part : null;
    if (!part || part.type !== "summary_text" || typeof part.text !== "string") {
      return;
    }
    itemState.segments.set(summaryIndex, part.text);
    await writeReasoningSummarySnapshot(state, itemState, context, eventType, false, usage);
    return;
  }

  if (eventType === "response.reasoning_summary_text.delta") {
    if (itemState.finalized || itemState.finalizedSegments.has(summaryIndex)) {
      return;
    }
    if (typeof value.delta !== "string" || !value.delta) {
      return;
    }
    itemState.segments.set(summaryIndex, `${itemState.segments.get(summaryIndex) ?? ""}${value.delta}`);
    await writeReasoningSummarySnapshot(state, itemState, context, eventType, false, usage);
    return;
  }

  if (itemState.finalized || typeof value.text !== "string") {
    return;
  }
  itemState.segments.set(summaryIndex, value.text);
  itemState.finalizedSegments.add(summaryIndex);
  await writeReasoningSummarySnapshot(state, itemState, context, eventType, true, usage);
}

async function collectChatGPTReasoningDetailEvent(
  value: unknown,
  state: ChatGPTReasoningTextState,
  context: ProviderRunContext,
  usage: RunUsage | null
): Promise<void> {
  if (!isRecord(value)) {
    return;
  }

  const eventType = typeof value.type === "string" ? value.type : "";
  if (eventType === "response.output_item.done") {
    const item = isRecord(value.item) ? value.item : isRecord(value.output_item) ? value.output_item : null;
    if (!item || item.type !== "reasoning" || !Array.isArray(item.content)) {
      return;
    }

    const itemState = reasoningTextItemState(value, item, state);
    itemState.segments.clear();
    for (let index = 0; index < item.content.length; index += 1) {
      const contentPart = item.content[index];
      if (!isRecord(contentPart) || contentPart.type !== "reasoning_text" || typeof contentPart.text !== "string") {
        continue;
      }
      itemState.segments.set(index, contentPart.text);
    }
    itemState.finalizedSegments = new Set(itemState.segments.keys());
    itemState.finalized = true;
    await writeReasoningDetailSnapshot(state, itemState, context, eventType, true, usage);
    return;
  }

  if (eventType !== "response.reasoning_text.delta" && eventType !== "response.reasoning_text.done") {
    return;
  }

  const item = isRecord(value.item) ? value.item : null;
  const itemState = reasoningTextItemState(value, item, state);
  const contentIndex = nonNegativeInteger(value.content_index) ?? 0;

  if (eventType === "response.reasoning_text.delta") {
    if (itemState.finalized || itemState.finalizedSegments.has(contentIndex)) {
      return;
    }
    if (typeof value.delta !== "string" || !value.delta) {
      return;
    }
    itemState.segments.set(contentIndex, `${itemState.segments.get(contentIndex) ?? ""}${value.delta}`);
    await writeReasoningDetailSnapshot(state, itemState, context, eventType, false, usage);
    return;
  }

  if (itemState.finalized || typeof value.text !== "string") {
    return;
  }
  itemState.segments.set(contentIndex, value.text);
  itemState.finalizedSegments.add(contentIndex);
  await writeReasoningDetailSnapshot(state, itemState, context, eventType, true, usage);
}

function reasoningTextItemState(
  event: Record<string, unknown>,
  item: Record<string, unknown> | null,
  state: ChatGPTReasoningTextState
): ChatGPTReasoningTextItemState {
  const itemId = stringValue(event.item_id) ?? stringValue(event.output_item_id) ?? stringValue(item?.id);
  const outputIndex = nonNegativeInteger(event.output_index);
  const key = outputIndex !== undefined ? `output:${outputIndex}` : itemId ?? "reasoning:default";
  const existing =
    state.items.get(key) ??
    (itemId ? [...state.items.values()].find((candidate) => candidate.itemId === itemId) : undefined) ??
    (outputIndex !== undefined
      ? [...state.items.values()].find((candidate) => candidate.outputIndex === outputIndex)
      : undefined);
  if (existing) {
    if (existing.key !== key) {
      state.items.delete(existing.key);
      existing.key = key;
      state.items.set(key, existing);
    }
    existing.itemId = itemId ?? existing.itemId;
    existing.outputIndex = outputIndex ?? existing.outputIndex;
    return existing;
  }

  const created: ChatGPTReasoningTextItemState = {
    key,
    itemId,
    outputIndex,
    order: state.nextOrder,
    segments: new Map(),
    finalizedSegments: new Set(),
    finalized: false
  };
  state.nextOrder += 1;
  state.items.set(key, created);
  return created;
}

async function writeReasoningSummarySnapshot(
  state: ChatGPTReasoningTextState,
  sourceItem: ChatGPTReasoningTextItemState,
  context: ProviderRunContext,
  nativeEventType: string,
  authoritative: boolean,
  usage: RunUsage | null
): Promise<void> {
  if (!context.writer.writeReasoningSummary) {
    return;
  }

  const summary = reasoningTextSnapshot(state);
  if (!summary) {
    return;
  }

  const record: ProviderReasoningSummaryRecord = {
    summary,
    provenance: {
      provider: "openai-chatgpt",
      nativeEventType,
      itemId: sourceItem.itemId,
      outputIndex: sourceItem.outputIndex,
      summaryIndexes: [...sourceItem.segments.keys()].sort((left, right) => left - right),
      authoritative
    },
    ...(usage ? { usage } : {})
  };
  await context.writer.writeReasoningSummary(record);
}

async function writeReasoningDetailSnapshot(
  state: ChatGPTReasoningTextState,
  sourceItem: ChatGPTReasoningTextItemState,
  context: ProviderRunContext,
  nativeEventType: string,
  authoritative: boolean,
  usage: RunUsage | null
): Promise<void> {
  if (!context.writer.writeReasoningDetail) {
    return;
  }

  const detail = reasoningTextSnapshot(state);
  if (!detail) {
    return;
  }

  const record: ProviderReasoningDetailRecord = {
    detail,
    provenance: {
      provider: "openai-chatgpt",
      nativeEventType,
      itemId: sourceItem.itemId,
      outputIndex: sourceItem.outputIndex,
      contentIndexes: [...sourceItem.segments.keys()].sort((left, right) => left - right),
      authoritative
    },
    ...(usage ? { usage } : {})
  };
  await context.writer.writeReasoningDetail(record);
}

function reasoningTextSnapshot(state: ChatGPTReasoningTextState): string {
  return [...state.items.values()]
    .sort((left, right) => (left.outputIndex ?? Number.MAX_SAFE_INTEGER) - (right.outputIndex ?? Number.MAX_SAFE_INTEGER) || left.order - right.order)
    .flatMap((item) => [...item.segments.entries()].sort(([left], [right]) => left - right).map(([, text]) => text.trim()).filter(Boolean))
    .join("\n\n")
    .trim();
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function buildCodexTools(tools: ModelToolDefinition[]): ChatGPTCodexRequestPayload["tools"] {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.providerName,
    description: tool.description,
    parameters: tool.inputSchema
  }));
}

function collectChatGPTToolCallEvent(value: unknown, states: Map<string, ChatGPTToolCallState>): void {
  if (!isRecord(value)) {
    return;
  }

  const eventType = typeof value.type === "string" ? value.type : "";
  const item = isRecord(value.item) ? value.item : isRecord(value.output_item) ? value.output_item : null;
  const itemId = stringValue(value.item_id) ?? stringValue(value.output_item_id) ?? stringValue(item?.id);
  const outputIndex = typeof value.output_index === "number" ? `output:${value.output_index}` : undefined;
  const key = itemId ?? outputIndex ?? stringValue(value.call_id) ?? stringValue(value.id);

  if (item && isFunctionCallRecord(item)) {
    const stateKey = key ?? stringValue(item.id) ?? stringValue(item.call_id) ?? `tool:${states.size}`;
    const state = states.get(stateKey) ?? { key: stateKey, argumentsText: "" };
    state.id = stringValue(item.id) ?? state.id;
    state.callId = stringValue(item.call_id) ?? state.callId;
    state.name = stringValue(item.name) ?? state.name;
    const argumentsText = stringValue(item.arguments);
    if (argumentsText) {
      state.argumentsText = argumentsText;
    }
    states.set(stateKey, state);
  }

  if (!key || !/function_call|tool_call/i.test(eventType)) {
    return;
  }

  const state = states.get(key) ?? { key, argumentsText: "" };
  const delta = stringValue(value.delta) ?? stringValue(value.arguments_delta);
  if (delta) {
    state.argumentsText += delta;
  }
  const name = stringValue(value.name);
  if (name) {
    state.name = name;
  }
  const callId = stringValue(value.call_id);
  if (callId) {
    state.callId = callId;
  }
  states.set(key, state);
}

function finalizeChatGPTToolCalls(states: Map<string, ChatGPTToolCallState>): ProviderToolCall[] {
  return [...states.values()]
    .filter((state) => Boolean(state.name?.trim()))
    .map((state, index) => {
      const parsed = parseToolArguments(state.argumentsText);
      return {
        id: state.callId?.trim() || state.id?.trim() || `chatgpt_tool_call_${index}`,
        name: state.name!.trim(),
        arguments: parsed.value,
        argumentsText: state.argumentsText,
        metadata: {
          provider: "openai-chatgpt",
          experimental: true,
          key: state.key,
          ...(parsed.error ? { argumentsParseError: parsed.error } : {})
        }
      };
    });
}

function parseToolArguments(value: string): { value: JsonObject; error?: string } {
  const text = value.trim();
  if (!text) {
    return { value: {} };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isJsonObject(parsed) ? { value: parsed } : { value: {}, error: "Tool arguments JSON was not an object." };
  } catch (error) {
    return { value: {}, error: `Tool arguments JSON parse failed: ${toErrorMessage(error)}` };
  }
}

function isFunctionCallRecord(value: Record<string, unknown>): boolean {
  return value.type === "function_call" || value.type === "tool_call" || (typeof value.name === "string" && "arguments" in value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractTextDeltas(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  const deltas: string[] = [];
  const eventType = typeof value.type === "string" ? value.type : "";
  if (isReasoningLikeEvent(eventType) || /function_call|tool_call/i.test(eventType)) {
    return deltas;
  }
  const topLevelTextIsDelta = isPublicTextDeltaEvent(eventType);

  if (topLevelTextIsDelta && typeof value.delta === "string" && value.delta) {
    deltas.push(value.delta);
  }
  if (topLevelTextIsDelta && typeof value.text === "string" && value.text) {
    deltas.push(value.text);
  }
  if (topLevelTextIsDelta && typeof value.output_text === "string" && value.output_text) {
    deltas.push(value.output_text);
  }

  const choices = value.choices;
  if (isPublicChoiceTextEvent(eventType) && Array.isArray(choices)) {
    for (const choice of choices) {
      if (!isRecord(choice)) {
        continue;
      }
      const delta = choice.delta;
      if (isRecord(delta) && typeof delta.content === "string" && delta.content) {
        deltas.push(delta.content);
      }
      if (typeof choice.text === "string" && choice.text) {
        deltas.push(choice.text);
      }
    }
  }

  if (topLevelTextIsDelta) {
    collectContentText(value.content, deltas);
    if (isRecord(value.message)) {
      collectContentText(value.message.content, deltas);
    }
  }

  return deltas;
}

function isPublicTextDeltaEvent(eventType: string): boolean {
  return (
    !eventType ||
    eventType === "delta" ||
    eventType === "output_text.delta" ||
    eventType === "response.output_text.delta" ||
    eventType === "response.refusal.delta"
  );
}

function isPublicChoiceTextEvent(eventType: string): boolean {
  return !eventType || eventType === "delta" || eventType === "chat.completion.chunk";
}

function isReasoningLikeEvent(eventType: string): boolean {
  return /reasoning|thinking|analysis|chain[_-]?of[_-]?thought/i.test(eventType);
}

function collectContentText(value: unknown, output: string[]): void {
  if (typeof value === "string" && value) {
    output.push(value);
    return;
  }

  if (!Array.isArray(value)) {
    return;
  }

  for (const item of value) {
    if (typeof item === "string" && item) {
      output.push(item);
      continue;
    }
    if (!isRecord(item)) {
      continue;
    }
    if (typeof item.text === "string" && item.text) {
      output.push(item.text);
    }
    if (typeof item.content === "string" && item.content) {
      output.push(item.content);
    }
  }
}

function normalizeInputRole(role: string): "user" | "assistant" {
  return role === "assistant" ? "assistant" : "user";
}

async function responseErrorDiagnostic(response: Response): Promise<ProviderErrorDiagnostic> {
  const body = await response.text().catch(() => "");
  const bodyPreview = previewBody(body);
  const parsedBody = parseJson(body);
  const extracted = extractProviderError(parsedBody) ?? extractProviderError(bodyPreview);

  return {
    status: response.status,
    statusText: response.statusText,
    code: extracted?.code,
    type: extracted?.type,
    message: redactSensitiveText(extracted?.message || bodyPreview || response.statusText || "Unknown provider error"),
    ...(bodyPreview ? { bodyPreview } : {})
  };
}

function streamErrorDiagnostic(value: unknown): ProviderErrorDiagnostic | null {
  if (!isRecord(value)) {
    return null;
  }

  const eventType = typeof value.type === "string" ? value.type : "";
  const status = typeof value.status === "string" ? value.status : "";
  const response = isRecord(value.response) ? value.response : null;
  const hasError = value.error !== undefined && value.error !== null;
  const responseHasError = response?.error !== undefined && response.error !== null;
  const isFailureEvent = eventType === "error" || eventType.endsWith(".failed") || eventType.includes("error") || status === "failed";

  if (!hasError && !responseHasError && !isFailureEvent) {
    return null;
  }

  const extracted = extractProviderError(value);
  const bodyPreview = previewJson(value);
  return {
    code: extracted?.code,
    type: extracted?.type ?? (eventType || undefined),
    message: redactSensitiveText(extracted?.message || bodyPreview || "OpenAI ChatGPT stream reported a provider error."),
    ...(bodyPreview ? { bodyPreview } : {})
  };
}

function extractProviderError(value: unknown): { code?: string; type?: string; message?: string } | null {
  if (typeof value === "string") {
    const message = value.trim();
    return message ? { message } : null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const nestedError = value.error;
  if (typeof nestedError === "string" && nestedError.trim()) {
    return {
      code: stringValue(value.code),
      type: stringValue(value.type),
      message: nestedError
    };
  }
  if (isRecord(nestedError)) {
    const nested = extractProviderError(nestedError);
    if (nested) {
      return {
        code: nested.code ?? stringValue(value.code),
        type: nested.type ?? stringValue(value.type),
        message: nested.message
      };
    }
  }

  if (isRecord(value.response)) {
    const responseError = extractProviderError(value.response);
    if (responseError) {
      return responseError;
    }
  }

  const detail = stringValue(value.detail);
  const message = stringValue(value.message) ?? detail;
  const code = stringValue(value.code);
  const type = stringValue(value.type);
  return message || code || type ? { code, type, message } : null;
}

function formatProviderError(prefix: string, diagnostic: ProviderErrorDiagnostic): string {
  const status = diagnostic.status
    ? ` (${diagnostic.status}${diagnostic.statusText ? ` ${diagnostic.statusText}` : ""})`
    : "";
  const details = [diagnostic.type ? `type=${diagnostic.type}` : "", diagnostic.code ? `code=${diagnostic.code}` : ""].filter(Boolean);
  const detailText = details.length > 0 ? ` [${details.join(", ")}]` : "";
  const bodyText = diagnostic.bodyPreview && diagnostic.bodyPreview !== diagnostic.message ? `; body=${diagnostic.bodyPreview}` : "";
  return `${prefix}${status}${detailText}: ${diagnostic.message}${bodyText}`;
}

function previewBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return "";
  }

  const parsed = parseJson(trimmed);
  return parsed === undefined ? trimForDisplay(redactSensitiveText(trimmed), diagnosticBodyPreviewLimit) : previewJson(parsed);
}

function previewJson(value: unknown): string {
  try {
    return trimForDisplay(JSON.stringify(redactSensitiveValue(value)), diagnosticBodyPreviewLimit);
  } catch {
    return "";
  }
}

function parseJson(value: string): unknown | undefined {
  if (!value.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactSensitiveValue);
  }
  if (!isRecord(value)) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? "[REDACTED]" : redactSensitiveValue(nested);
  }
  return output;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]");
}

function isSensitiveKey(key: string): boolean {
  return (
    /authorization|cookie|token|secret|api[_-]?key|credential|account|email|refresh|access|encrypted/i.test(key) ||
    /reasoning[_-]?(text|content)|analysis|thinking|chain[_-]?of[_-]?thought/i.test(key)
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function logDebug(event: string, payload: Record<string, unknown>): void {
  if (process.env.OPENAI_CHATGPT_DEBUG === "1") {
    console.info(`OpenAI ChatGPT Codex ${event}`, redactSensitiveValue(payload));
  }
}

function publicDetails(profile: ProviderProfile) {
  return {
    endpoint: getEndpoint(profile),
    model: getModel(profile),
    credentialRef: profile.credentialRef ?? null,
    billingSource: profile.billingSource,
    experimental: Boolean(profile.experimental)
  };
}

function getEndpoint(profile: ProviderProfile): string {
  return profile.endpoint?.trim() || defaultOpenAIChatGPTEndpoint;
}

function getModel(profile: ProviderProfile): string {
  return profile.model?.trim() || defaultOpenAIChatGPTModel;
}

function getRunModel(input: ProviderRunInput): string {
  return input.context.runOptions.model?.trim() || input.runOptions.model?.trim() || getModel(input.profile);
}

function trimForDisplay(value: string, maxLength = 500): string {
  const trimmed = value.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createAbortError(): Error {
  const error = new Error("Run aborted");
  error.name = "AbortError";
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
