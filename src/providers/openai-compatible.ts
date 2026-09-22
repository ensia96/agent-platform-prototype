import type { ProviderAdapter, ProviderCredential, ProviderRunContext, ProviderRunInput, ProviderRunResult, ProviderToolCall } from "./types";
import { extractRunUsage } from "./usage";
import { providerContextLengthErrorIfRecognized } from "./provider-errors";
import type {
  BuiltContext,
  JsonObject,
  ModelToolDefinition,
  ProviderModelCatalog,
  ProviderModelCatalogItem,
  ProviderProfile,
  ProviderStatus,
  ProviderTestResponse
} from "../shared/types";

const defaultBaseUrl = "https://api.openai.com/v1";
const defaultModel = "gpt-4o-mini";
const testTimeoutMs = 15_000;
const modelIdMaxLength = 200;
export const openAICompatibleTransportWrapperTokens = 24;
export const openAICompatibleSystemMessageWrapperTokens = 8;
export const openAICompatibleContextPlanning = {
  requiredInstructions: [],
  // Chat Completions always carries one native system message in addition to transport framing.
  fixedWrapperTokens: openAICompatibleTransportWrapperTokens + openAICompatibleSystemMessageWrapperTokens,
  perMessageTokens: 8,
  toolEnvelopeTokens: 24
};

export interface OpenAICompatibleProviderOptions {
  fetch?: typeof fetch;
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly id = "openai-compatible";
  readonly label = "OpenAI-compatible streaming provider";
  readonly contextPlanning = openAICompatibleContextPlanning;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleProviderOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async test(profile: ProviderProfile, credential: { apiKey?: string }): Promise<ProviderTestResponse> {
    const checkedAt = new Date().toISOString();
    const apiKey = credential.apiKey?.trim() ?? "";
    const baseUrl = getBaseUrl(profile);
    const model = getModel(profile);

    if (!apiKey) {
      const status: ProviderStatus = {
        state: "missing_credential",
        message: `${credentialRefLabel(profile)} is required to test the OpenAI-compatible provider.`,
        credentialStatus: "missing",
        checkedAt,
        errorCode: "missing_credential"
      };

      return {
        ok: false,
        profile: { ...profile, status },
        status,
        code: "missing_credential",
        message: status.message,
        checkedAt,
        details: { baseUrl, model, credentialRef: profile.credentialRef ?? null }
      };
    }

    const startedAt = Date.now();

    try {
      const catalog = await this.listModels(profile, credential);
      const latencyMs = Date.now() - startedAt;
      const status: ProviderStatus = {
        state: "connected",
        message: `Connected to ${baseUrl} using ${model}.`,
        credentialStatus: "present",
        checkedAt
      };

      return {
        ok: true,
        profile: { ...profile, status },
        status,
        message: status.message,
        checkedAt,
        latencyMs,
        details: { baseUrl, model, endpoint: `${baseUrl}/models`, modelCount: catalog.models.length }
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const status: ProviderStatus = {
        state: "error",
        message: `OpenAI-compatible /models test failed: ${toErrorMessage(error)}`,
        credentialStatus: "present",
        checkedAt,
        errorCode: "connection_failed"
      };

      return {
        ok: false,
        profile: { ...profile, status },
        status,
        code: "connection_failed",
        message: status.message,
        checkedAt,
        latencyMs,
        details: { baseUrl, model, endpoint: `${baseUrl}/models` }
      };
    }
  }

  async listModels(profile: ProviderProfile, credential: ProviderCredential): Promise<ProviderModelCatalog> {
    const apiKey = credential.apiKey?.trim() ?? "";
    if (!apiKey) {
      throw new Error(`${credentialRefLabel(profile)} is required to list OpenAI-compatible models.`);
    }

    const baseUrl = getBaseUrl(profile);
    const endpoint = `${baseUrl}/models`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), testTimeoutMs);
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json"
        },
        signal: controller.signal
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`OpenAI-compatible /models request failed with status ${response.status} ${response.statusText}.`);
      }
      let body: unknown;
      try {
        body = (await response.json()) as unknown;
      } catch {
        throw new Error("OpenAI-compatible /models returned invalid JSON.");
      }
      return parseOpenAICompatibleModelCatalog(body, profile.id);
    } catch (error) {
      if (isAbortLike(error)) {
        throw new Error(`OpenAI-compatible /models request timed out after ${testTimeoutMs / 1000}s.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async run(input: ProviderRunInput, context: ProviderRunContext): Promise<ProviderRunResult> {
    const apiKey = input.credential.apiKey?.trim() ?? "";
    const baseUrl = getBaseUrl(input.profile);
    const model = getRunModel(input);

    if (!apiKey) {
      throw new Error(`${credentialRefLabel(input.profile)} is required for the openai-compatible provider`);
    }

    const requestBody: Record<string, unknown> = {
      model,
      stream: true,
      messages: buildOpenAICompatibleRequestMessages(input.context)
    };
    if (input.context.availableTools.length > 0) {
      requestBody.tools = buildOpenAICompatibleTools(input.context.availableTools);
      requestBody.tool_choice = "auto";
      await context.writer.writeMetadata({
        toolTranslation: {
          provider: this.id,
          native: true,
          requestFormat: "openai-chat-completions-tools",
          availableToolIds: input.context.availableTools.map((tool) => tool.id),
          providerToolNames: input.context.availableTools.map((tool) => tool.providerName)
        }
      });
    }
    if (typeof input.context.runOptions.temperature === "number" && Number.isFinite(input.context.runOptions.temperature)) {
      requestBody.temperature = input.context.runOptions.temperature;
    }

    const response = await this.fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: context.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const contextError = providerContextLengthErrorIfRecognized({ status: response.status, message: body });
      if (contextError) {
        throw contextError;
      }
      throw new Error(`OpenAI-compatible provider failed (${response.status}): ${trimForDisplay(body) || response.statusText}`);
    }

    if (!response.body) {
      throw new Error("OpenAI-compatible provider returned an empty response body");
    }

    const toolCalls = await parseOpenAICompatibleStream(response.body, context);
    return { toolCalls };
  }
}

export function parseOpenAICompatibleModelCatalog(
  value: unknown,
  providerProfileId: string,
  fetchedAt = new Date().toISOString()
): ProviderModelCatalog {
  if (!isJsonObject(value) || !Array.isArray(value.data)) {
    throw new Error("OpenAI-compatible /models response must contain a data array.");
  }

  const models: ProviderModelCatalogItem[] = [];
  const seen = new Set<string>();
  for (const item of value.data) {
    if (!isJsonObject(item)) {
      continue;
    }
    const id = catalogIdentifier(item.id, modelIdMaxLength);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const owner = catalogString(item.owned_by, 200);
    const created = typeof item.created === "number" && Number.isFinite(item.created) && item.created >= 0 ? item.created : undefined;
    models.push({
      id,
      ...(owner ? { owner } : {}),
      ...(created !== undefined ? { created } : {}),
      reasoning: { support: "unknown", efforts: [] }
    });
  }

  return {
    providerProfileId,
    status: "available",
    source: "provider",
    stale: false,
    fetchedAt,
    warning:
      "The OpenAI-compatible /models contract does not identify chat compatibility or reasoning support; entries may include embedding, audio, or other non-chat models.",
    customModelAllowed: true,
    models
  };
}

interface OpenAIToolCallState {
  index: number;
  id?: string;
  type?: string;
  name?: string;
  argumentsText: string;
}

export async function parseOpenAICompatibleStream(
  stream: ReadableStream<Uint8Array>,
  context: ProviderRunContext
): Promise<ProviderToolCall[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCallStates = new Map<number, OpenAIToolCallState>();

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

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const doneParsing = await handleSseEvent(rawEvent, context, toolCallStates);
        if (doneParsing) {
          return finalizeToolCalls(toolCallStates);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      await handleSseEvent(buffer, context, toolCallStates);
    }
  } finally {
    reader.releaseLock();
  }

  return finalizeToolCalls(toolCallStates);
}

async function handleSseEvent(rawEvent: string, context: ProviderRunContext, toolCallStates: Map<number, OpenAIToolCallState>): Promise<boolean> {
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

  type OpenAIStreamEvent = {
    choices?: Array<{
      delta?: { content?: string | null; tool_calls?: OpenAIToolCallDelta[] };
      message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
      text?: string;
    }>;
    usage?: unknown;
  };

  let parsed: OpenAIStreamEvent;

  try {
    parsed = JSON.parse(data) as OpenAIStreamEvent;
  } catch (error) {
    throw new Error(`Failed to parse OpenAI-compatible SSE event (${toErrorMessage(error)})`);
  }

  const streamError = openAIStreamErrorFields(parsed);
  if (streamError) {
    const contextError = providerContextLengthErrorIfRecognized({ status: 400, ...streamError });
    if (contextError) {
      throw contextError;
    }
    throw new Error("OpenAI-compatible provider returned an SSE error event.");
  }

  const usage = extractRunUsage(parsed);
  if (usage) {
    await context.writer.writeUsage(usage);
  }

  for (const choice of parsed.choices ?? []) {
    const delta = choice.delta?.content ?? choice.text ?? "";
    if (delta) {
      await context.writer.writeDelta(delta);
    }
    const messageContent = choice.message?.content ?? "";
    if (messageContent) {
      await context.writer.writeDelta(messageContent);
    }
    for (const toolCallDelta of choice.delta?.tool_calls ?? []) {
      mergeOpenAIToolCallDelta(toolCallStates, toolCallDelta);
    }
    for (const toolCall of choice.message?.tool_calls ?? []) {
      mergeOpenAIToolCall(toolCallStates, toolCall);
    }
  }

  return false;
}

function openAIStreamErrorFields(value: unknown): { code?: string; type?: string; message?: string } | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const direct = isJsonObject(value.error) ? value.error : null;
  const nestedResponse = isJsonObject(value.response) && isJsonObject(value.response.error) ? value.response.error : null;
  const error = direct ?? nestedResponse;
  if (!error) {
    return null;
  }
  return {
    ...(typeof error.code === "string" ? { code: error.code } : {}),
    ...(typeof error.type === "string" ? { type: error.type } : {}),
    ...(typeof error.message === "string" ? { message: error.message } : {})
  };
}

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

function buildOpenAICompatibleTools(tools: ModelToolDefinition[]): Array<{
  type: "function";
  function: { name: string; description: string; parameters: JsonObject };
}> {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.providerName,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
}

function mergeOpenAIToolCallDelta(states: Map<number, OpenAIToolCallState>, delta: OpenAIToolCallDelta): void {
  const index = typeof delta.index === "number" && Number.isInteger(delta.index) ? delta.index : states.size;
  const current = states.get(index) ?? { index, argumentsText: "" };
  if (delta.id?.trim()) {
    current.id = delta.id.trim();
  }
  if (delta.type?.trim()) {
    current.type = delta.type.trim();
  }
  if (delta.function?.name?.trim()) {
    current.name = delta.function.name.trim();
  }
  if (typeof delta.function?.arguments === "string") {
    current.argumentsText += delta.function.arguments;
  }
  states.set(index, current);
}

function mergeOpenAIToolCall(states: Map<number, OpenAIToolCallState>, toolCall: OpenAIToolCall): void {
  const index = states.size;
  const current: OpenAIToolCallState = {
    index,
    id: toolCall.id?.trim() || undefined,
    type: toolCall.type?.trim() || undefined,
    name: toolCall.function?.name?.trim() || undefined,
    argumentsText: typeof toolCall.function?.arguments === "string" ? toolCall.function.arguments : ""
  };
  states.set(index, current);
}

function finalizeToolCalls(states: Map<number, OpenAIToolCallState>): ProviderToolCall[] {
  return [...states.values()]
    .sort((a, b) => a.index - b.index)
    .filter((state) => Boolean(state.name?.trim()))
    .map((state) => {
      const parsed = parseToolArguments(state.argumentsText);
      return {
        id: state.id?.trim() || `tool_call_${state.index}`,
        name: state.name!.trim(),
        arguments: parsed.value,
        argumentsText: state.argumentsText,
        metadata: {
          provider: "openai-compatible",
          providerToolType: state.type ?? "function",
          index: state.index,
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

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function catalogString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    return undefined;
  }
  const text = value.trim();
  return text && text.length <= maxLength ? text : undefined;
}

function catalogIdentifier(value: unknown, maxLength: number): string | undefined {
  const identifier = catalogString(value, maxLength);
  return typeof value === "string" && value === identifier ? identifier : undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function getBaseUrl(profile: ProviderProfile): string {
  return stripTrailingSlash(profile.baseUrl?.trim() || defaultBaseUrl);
}

function getModel(profile: ProviderProfile): string {
  return profile.model?.trim() || defaultModel;
}

function getRunModel(input: ProviderRunInput): string {
  return input.context.runOptions.model?.trim() || input.runOptions.model?.trim() || getModel(input.profile);
}

export function buildOpenAICompatibleRequestMessages(
  context: BuiltContext
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
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

function credentialRefLabel(profile: ProviderProfile): string {
  return profile.credentialRef?.trim() || "OPENAI_API_KEY";
}

function trimForDisplay(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}

function createAbortError(): Error {
  const error = new Error("Run aborted");
  error.name = "AbortError";
  return error;
}
