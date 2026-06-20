import type { ProviderAdapter, ProviderCredential, ProviderRunContext, ProviderRunInput } from "./types";
import type { ProviderProfile, ProviderTestResponse } from "../shared/types";

export class MockProvider implements ProviderAdapter {
  readonly id = "mock";
  readonly label = "Mock streaming provider";

  async test(profile: ProviderProfile, _credential: ProviderCredential): Promise<ProviderTestResponse> {
    const checkedAt = new Date().toISOString();
    const status = {
      state: "available" as const,
      message: "The local mock provider is always available and does not require credentials.",
      credentialStatus: "not_required" as const,
      checkedAt
    };

    return {
      ok: true,
      profile: { ...profile, status },
      status,
      message: status.message,
      checkedAt
    };
  }

  async run(input: ProviderRunInput, context: ProviderRunContext): Promise<void> {
    const lastUserMessage = [...input.context.messages].reverse().find((message) => message.role === "user");
    const prompt = lastUserMessage?.content.trim() || "(empty prompt)";
    await context.writer.writeMetadata({
      mockContext: {
        agentId: input.context.agent.id,
        agentName: input.context.agent.name,
        messageCount: input.context.messages.length
      }
    });
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
