import type { ProviderAdapter, ProviderCredential, ProviderRunContext, ProviderRunInput } from "./types";
import type { ProviderModelCatalog, ProviderProfile, ProviderTestResponse } from "../shared/types";

export const mockModelId = "mock-stream-v1";
export const mockContextWindowTokens = 32_768;

export class MockProvider implements ProviderAdapter {
  readonly id = "mock";
  readonly label = "Mock streaming provider";
  readonly contextPlanning = {
    requiredInstructions: [],
    fixedWrapperTokens: 16,
    perMessageTokens: 6,
    toolEnvelopeTokens: 16
  };

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

  async listModels(profile: ProviderProfile, _credential: ProviderCredential): Promise<ProviderModelCatalog> {
    return {
      providerProfileId: profile.id,
      status: "available",
      source: "builtin",
      stale: false,
      fetchedAt: new Date().toISOString(),
      customModelAllowed: false,
      models: [
        {
          id: mockModelId,
          displayName: "Local mock streaming model",
          description: "Deterministic local fixture model used to verify streaming without provider credentials.",
          reasoning: { support: "unsupported", efforts: [] },
          context: { windowTokens: mockContextWindowTokens, source: "adapter" }
        }
      ]
    };
  }

  async run(input: ProviderRunInput, context: ProviderRunContext) {
    const lastUserMessage = [...input.context.messages].reverse().find((message) => message.role === "user");
    const prompt = lastUserMessage?.content.trim() || "(empty prompt)";
    await context.writer.writeMetadata({
      mockContext: {
        agentId: input.context.agent.id,
        agentName: input.context.agent.name,
        messageCount: input.context.messages.length,
        availableToolCount: input.context.availableTools.length
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

    return { toolCalls: [] };
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
