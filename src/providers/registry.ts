import { MockProvider } from "./mock";
import { OpenAICompatibleProvider } from "./openai-compatible";
import type { ProviderAdapter, ProviderCredential } from "./types";
import type {
  ProviderFallbackInfo,
  ProviderListResponse,
  ProviderProfile,
  ProviderProfileType,
  ProviderResolution,
  ProviderStatus,
  ProviderTestResponse
} from "../shared/types";

const mockProfileId = "mock";
const openAIProfileId = "openai-compatible";
const defaultOpenAIBaseUrl = "https://api.openai.com/v1";
const defaultOpenAIModel = "gpt-4o-mini";

export interface ProviderRunSelectionInput {
  provider?: string;
  providerProfileId?: string;
}

export interface ResolvedProviderRun {
  adapter: ProviderAdapter;
  profile: ProviderProfile;
  credential: ProviderCredential;
  providerResolution: ProviderResolution;
}

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderProfileType, ProviderAdapter>();
  private readonly profiles = new Map<string, ProviderProfile>();
  private readonly aliases = new Map<string, string>([
    ["openai", openAIProfileId],
    ["openai-compatible", openAIProfileId],
    ["env-openai", openAIProfileId],
    ["env-openai-compatible", openAIProfileId],
    ["mock", mockProfileId]
  ]);

  constructor(private readonly env: NodeJS.ProcessEnv, adapters: ProviderAdapter[]) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.id as ProviderProfileType, adapter);
    }

    for (const profile of createDefaultProfiles(env)) {
      this.profiles.set(profile.id, profile);
    }
  }

  list(): ProviderListResponse {
    return {
      providers: [...this.profiles.values()].map(cloneProfile),
      defaultProviderProfileId: this.getDefaultProviderProfileId()
    };
  }

  async testProfile(id: string): Promise<ProviderTestResponse | null> {
    const profile = this.getProfile(id);
    if (!profile) {
      return null;
    }

    const adapter = this.adapters.get(profile.type);
    if (!adapter) {
      const checkedAt = new Date().toISOString();
      const status: ProviderStatus = {
        state: "error",
        message: `No adapter is registered for provider type '${profile.type}'.`,
        credentialStatus: credentialStatusFor(profile, this.resolveCredential(profile)),
        checkedAt,
        errorCode: "unsupported_profile"
      };
      return {
        ok: false,
        profile: { ...profile, status },
        status,
        code: "unsupported_profile",
        message: status.message,
        checkedAt
      };
    }

    return adapter.test(cloneProfile(profile), this.resolveCredential(profile));
  }

  resolveRun(selection: ProviderRunSelectionInput): ResolvedProviderRun {
    const requestedProvider = normalizeOptionalString(selection.provider);
    const requestedProviderProfileId = normalizeOptionalString(selection.providerProfileId);
    const requestedProfileId = this.normalizeProfileId(requestedProviderProfileId ?? requestedProvider);
    const defaultProfileId = this.getDefaultProviderProfileId();
    let profile = this.profiles.get(requestedProfileId ?? defaultProfileId) ?? null;
    let fallback: ProviderFallbackInfo | null = null;

    if (!profile) {
      fallback = {
        fromProviderProfileId: requestedProfileId,
        toProviderProfileId: mockProfileId,
        reason: "unknown_profile",
        message: `Provider profile '${requestedProfileId ?? "(default)"}' was not found; using the mock provider.`
      };
      profile = this.requireProfile(mockProfileId);
    } else if (!profile.enabled) {
      fallback = {
        fromProviderProfileId: profile.id,
        toProviderProfileId: mockProfileId,
        reason: "disabled",
        message: `Provider profile '${profile.name}' is disabled; using the mock provider.`
      };
      profile = this.requireProfile(mockProfileId);
    } else if (profile.type === "openai-compatible" && !this.resolveCredential(profile).apiKey) {
      fallback = {
        fromProviderProfileId: profile.id,
        toProviderProfileId: mockProfileId,
        reason: "missing_credential",
        message: `${profile.credentialRef ?? "env:OPENAI_API_KEY"} is missing; using the mock provider for this run.`
      };
      profile = this.requireProfile(mockProfileId);
    }

    const adapter = this.adapters.get(profile.type);
    if (!adapter) {
      const fallbackProfile = this.requireProfile(mockProfileId);
      fallback = {
        fromProviderProfileId: profile.id,
        toProviderProfileId: fallbackProfile.id,
        reason: "unavailable",
        message: `No adapter is registered for provider type '${profile.type}'; using the mock provider.`
      };
      profile = fallbackProfile;
    }

    const resolvedAdapter = this.adapters.get(profile.type);
    if (!resolvedAdapter) {
      throw new Error(`No adapter is registered for provider type '${profile.type}'.`);
    }

    return {
      adapter: resolvedAdapter,
      profile: cloneProfile(profile),
      credential: this.resolveCredential(profile),
      providerResolution: {
        requestedProvider,
        requestedProviderProfileId,
        providerProfileId: profile.id,
        providerProfileName: profile.name,
        providerType: profile.type,
        model: profile.model,
        baseUrl: profile.baseUrl,
        credentialRef: profile.credentialRef,
        fallback
      }
    };
  }

  private getDefaultProviderProfileId(): string {
    const openAIProfile = this.profiles.get(openAIProfileId);
    if (openAIProfile?.enabled && this.resolveCredential(openAIProfile).apiKey) {
      return openAIProfile.id;
    }
    return mockProfileId;
  }

  private getProfile(id: string): ProviderProfile | null {
    const profileId = this.normalizeProfileId(id);
    return profileId ? this.profiles.get(profileId) ?? null : null;
  }

  private requireProfile(id: string): ProviderProfile {
    const profile = this.profiles.get(id);
    if (!profile) {
      throw new Error(`Provider profile '${id}' is not registered.`);
    }
    return profile;
  }

  private normalizeProfileId(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    if (!trimmed) {
      return null;
    }
    return this.aliases.get(trimmed.toLowerCase()) ?? trimmed;
  }

  private resolveCredential(profile: ProviderProfile): ProviderCredential {
    const credentialRef = profile.credentialRef?.trim();
    if (!credentialRef?.startsWith("env:")) {
      return {};
    }

    const envKey = credentialRef.slice("env:".length).trim();
    return {
      apiKey: envKey ? this.env[envKey]?.trim() || undefined : undefined
    };
  }
}

export function createDefaultProviderRegistry(env: NodeJS.ProcessEnv): ProviderRegistry {
  return new ProviderRegistry(env, [new MockProvider(), new OpenAICompatibleProvider()]);
}

function createDefaultProfiles(env: NodeJS.ProcessEnv): ProviderProfile[] {
  const hasOpenAIKey = Boolean(env.OPENAI_API_KEY?.trim());
  const openAIBaseUrl = env.OPENAI_BASE_URL?.trim() || defaultOpenAIBaseUrl;
  const openAIModel = env.OPENAI_MODEL?.trim() || defaultOpenAIModel;

  return [
    {
      id: mockProfileId,
      name: "Mock streaming provider",
      type: "mock",
      source: "builtin",
      enabled: true,
      status: {
        state: "available",
        message: "Local mock provider is available and does not require credentials.",
        credentialStatus: "not_required"
      }
    },
    {
      id: openAIProfileId,
      name: "OpenAI-compatible env profile",
      type: "openai-compatible",
      source: "env",
      enabled: true,
      baseUrl: openAIBaseUrl,
      model: openAIModel,
      credentialRef: "env:OPENAI_API_KEY",
      status: {
        state: hasOpenAIKey ? "configured" : "missing_credential",
        message: hasOpenAIKey
          ? "OPENAI_API_KEY is present. Use the test button to verify the endpoint."
          : "OPENAI_API_KEY is missing; runs that request this profile will fall back to mock.",
        credentialStatus: hasOpenAIKey ? "present" : "missing",
        errorCode: hasOpenAIKey ? undefined : "missing_credential"
      }
    }
  ];
}

function cloneProfile(profile: ProviderProfile): ProviderProfile {
  return {
    ...profile,
    status: { ...profile.status }
  };
}

function credentialStatusFor(profile: ProviderProfile, credential: ProviderCredential): ProviderStatus["credentialStatus"] {
  if (!profile.credentialRef) {
    return "not_required";
  }
  return credential.apiKey ? "present" : "missing";
}

function normalizeOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
