import type { ProviderAdapter, ProviderRunContext, ProviderRunInput } from "./types";

export class MockProvider implements ProviderAdapter {
  readonly id = "mock";
  readonly label = "Mock streaming provider";

  available(): boolean {
    return true;
  }

  async run(input: ProviderRunInput, context: ProviderRunContext): Promise<void> {
    const lastUserMessage = [...input.messages].reverse().find((message) => message.role === "user");
    const prompt = lastUserMessage?.content.trim() || "(empty prompt)";
    const response =
      `Mock response for: ${prompt}\n\n` +
      "This local provider streams small chunks so the SSE pipeline, SQLite projection, reload, and cancel behavior can be tested without an API key.";

    for (const chunk of chunkText(response)) {
      throwIfAborted(context.signal);
      await delay(70, context.signal);
      await context.writer.writeDelta(chunk);
    }
  }
}

function chunkText(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError());
      return;
    }

    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(createAbortError());
      },
      { once: true }
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError();
  }
}

function createAbortError(): Error {
  const error = new Error("Run aborted");
  error.name = "AbortError";
  return error;
}
