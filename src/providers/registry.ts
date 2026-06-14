import { MockProvider } from "./mock";
import { OpenAICompatibleProvider } from "./openai-compatible";
import type { ProviderAdapter } from "./types";

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly aliases = new Map<string, string>([
    ["openai", "openai-compatible"],
    ["openai-compatible", "openai-compatible"],
    ["mock", "mock"]
  ]);

  constructor(adapters: ProviderAdapter[], private readonly fallbackProviderId = "mock") {
    for (const adapter of adapters) {
      this.adapters.set(adapter.id, adapter);
    }
  }

  resolve(requestedProvider?: string): ProviderAdapter {
    const normalized = requestedProvider?.trim().toLowerCase();
    const providerId = normalized ? this.aliases.get(normalized) ?? normalized : this.fallbackProviderId;
    const candidate = this.adapters.get(providerId);

    if (candidate?.available()) {
      return candidate;
    }

    const fallback = this.adapters.get(this.fallbackProviderId);
    if (!fallback) {
      throw new Error(`Fallback provider '${this.fallbackProviderId}' is not registered`);
    }
    return fallback;
  }
}

export function createDefaultProviderRegistry(env: NodeJS.ProcessEnv): ProviderRegistry {
  return new ProviderRegistry([
    new MockProvider(),
    new OpenAICompatibleProvider({
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL,
      model: env.OPENAI_MODEL
    })
  ]);
}
