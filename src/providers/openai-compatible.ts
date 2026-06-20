import type { ProviderAdapter, ProviderRunContext, ProviderRunInput } from "./types";
import type { ProviderProfile, ProviderStatus, ProviderTestResponse } from "../shared/types";

const defaultBaseUrl = "https://api.openai.com/v1";
const defaultModel = "gpt-4o-mini";
const testTimeoutMs = 15_000;

export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly id = "openai-compatible";
  readonly label = "OpenAI-compatible streaming provider";

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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), testTimeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(`${baseUrl}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json"
        },
        signal: controller.signal
      });
      const latencyMs = Date.now() - startedAt;

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const displayBody = trimForDisplay(body);
        const status: ProviderStatus = {
          state: "error",
          message: `OpenAI-compatible /models test failed (${response.status}): ${displayBody || response.statusText}`,
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
          details: {
            baseUrl,
            model,
            endpoint: `${baseUrl}/models`,
            status: response.status,
            statusText: response.statusText,
            body: displayBody
          }
        };
      }

      await response.body?.cancel().catch(() => undefined);
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
        details: { baseUrl, model, endpoint: `${baseUrl}/models` }
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const status: ProviderStatus = {
        state: "error",
        message: isAbortLike(error)
          ? `OpenAI-compatible /models test timed out after ${testTimeoutMs / 1000}s.`
          : `OpenAI-compatible /models test failed: ${toErrorMessage(error)}`,
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
    } finally {
      clearTimeout(timeout);
    }
  }

  async run(input: ProviderRunInput, context: ProviderRunContext): Promise<void> {
    const apiKey = input.credential.apiKey?.trim() ?? "";
    const baseUrl = getBaseUrl(input.profile);
    const model = getModel(input.profile);

    if (!apiKey) {
      throw new Error(`${credentialRefLabel(input.profile)} is required for the openai-compatible provider`);
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: input.messages.map((message) => ({
          role: message.role,
          content: message.content
        }))
      }),
      signal: context.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenAI-compatible provider failed (${response.status}): ${trimForDisplay(body) || response.statusText}`);
    }

    if (!response.body) {
      throw new Error("OpenAI-compatible provider returned an empty response body");
    }

    await parseOpenAIStream(response.body, context);
  }
}

async function parseOpenAIStream(stream: ReadableStream<Uint8Array>, context: ProviderRunContext): Promise<void> {
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

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const doneParsing = await handleSseEvent(rawEvent, context);
        if (doneParsing) {
          return;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      await handleSseEvent(buffer, context);
    }
  } finally {
    reader.releaseLock();
  }
}

async function handleSseEvent(rawEvent: string, context: ProviderRunContext): Promise<boolean> {
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
      delta?: { content?: string };
      text?: string;
    }>;
  };

  let parsed: OpenAIStreamEvent;

  try {
    parsed = JSON.parse(data) as OpenAIStreamEvent;
  } catch (error) {
    throw new Error(`Failed to parse OpenAI-compatible SSE event: ${trimForDisplay(data)} (${toErrorMessage(error)})`);
  }

  for (const choice of parsed.choices ?? []) {
    const delta = choice.delta?.content ?? choice.text ?? "";
    if (delta) {
      await context.writer.writeDelta(delta);
    }
  }

  return false;
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
