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
import type { ProviderAdapter, ProviderCredential, ProviderRunContext, ProviderRunInput } from "./types";
import type { BuiltContext, ProviderProfile, ProviderStatus, ProviderTestResponse } from "../shared/types";

const refreshSkewMs = 60_000;
const defaultCodexInstructions =
  "You are ChatGPT, a helpful assistant. Answer the user's message directly and concisely unless they ask for more detail.";
const diagnosticBodyPreviewLimit = 1000;

interface ChatGPTCodexRequestPayload {
  model: string;
  instructions: string;
  store: false;
  stream: true;
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

  async run(input: ProviderRunInput, context: ProviderRunContext): Promise<void> {
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
    logDebug("request", {
      endpoint,
      model: payload.model,
      store: payload.store,
      stream: payload.stream,
      inputMessages: payload.input.length,
      hasInstructions: payload.instructions.trim().length > 0,
      requestedReasoningEffort: input.requestedRunOptions.reasoningEffort ?? null,
      reasoningEffortSent: false,
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

    await parseChatGPTStream(response.body, context);
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

function buildCodexRequestPayload(input: ProviderRunInput): ChatGPTCodexRequestPayload {
  const systemInstructions = input.context.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean);
  const instructions = [defaultCodexInstructions, input.context.systemPrompt.trim(), ...systemInstructions].filter(Boolean).join("\n\n").trim();
  const inputMessages = buildCodexInputMessages(input.context);

  // The ChatGPT/Codex backend's public contract for reasoning effort is not stable.
  // Keep requested reasoning effort in run metadata for now rather than risking the known-good payload shape.
  return {
    model: getRunModel(input),
    instructions,
    store: false,
    stream: true,
    input: inputMessages
  };
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

async function parseChatGPTStream(stream: ReadableStream<Uint8Array>, context: ProviderRunContext): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
        const finished = await handleStreamEvent(rawEvent, context);
        if (finished) {
          return;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      await handleStreamEvent(buffer, context);
    }
  } finally {
    reader.releaseLock();
  }
}

async function handleStreamEvent(rawEvent: string, context: ProviderRunContext): Promise<boolean> {
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
    throw new Error(`Failed to parse OpenAI ChatGPT SSE event: ${trimForDisplay(data)} (${toErrorMessage(error)})`);
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

  for (const delta of extractTextDeltas(parsed)) {
    await context.writer.writeDelta(delta);
  }

  return false;
}

function extractTextDeltas(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  const deltas: string[] = [];
  const eventType = typeof value.type === "string" ? value.type : "";
  if (isReasoningLikeEvent(eventType)) {
    return deltas;
  }
  const topLevelTextIsDelta = !eventType || eventType.endsWith(".delta") || eventType === "delta";

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
  if (Array.isArray(choices)) {
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
  return /authorization|cookie|token|secret|api[_-]?key|credential|account|email|refresh|access/i.test(key);
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
