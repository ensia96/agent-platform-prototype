import type { ProviderAdapter, ProviderRunContext, ProviderRunInput } from "./types";

export interface OpenAICompatibleProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly id = "openai-compatible";
  readonly label = "OpenAI-compatible streaming provider";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.apiKey = options.apiKey?.trim() ?? "";
    this.baseUrl = stripTrailingSlash(options.baseUrl?.trim() || "https://api.openai.com/v1");
    this.model = options.model?.trim() || "gpt-4o-mini";
  }

  available(): boolean {
    return this.apiKey.length > 0;
  }

  async run(input: ProviderRunInput, context: ProviderRunContext): Promise<void> {
    if (!this.available()) {
      throw new Error("OPENAI_API_KEY is required for the openai-compatible provider");
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
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
      throw new Error(`OpenAI-compatible provider failed (${response.status}): ${body || response.statusText}`);
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

    const tail = decoder.decode();
    if (tail) {
      await handleSseEvent(tail, context);
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

  const parsed = JSON.parse(data) as {
    choices?: Array<{
      delta?: { content?: string };
      text?: string;
    }>;
  };

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

function createAbortError(): Error {
  const error = new Error("Run aborted");
  error.name = "AbortError";
  return error;
}
