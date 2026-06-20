import { MockProvider } from "./mock";
import { OpenAIChatGPTProvider } from "./openai-chatgpt";
import {
  defaultOpenAIChatGPTEndpoint,
  defaultOpenAIChatGPTModel,
  openAIChatGPTCredentialRef,
  openAIChatGPTProfileId,
  OpenAIChatGPTCredentialStore,
  type OpenAIChatGPTCredentialInspection
} from "./openai-chatgpt-credentials";
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

export interface ProviderRegistryOptions {
  openAIChatGPTCredentials?: OpenAIChatGPTCredentialStore;
}

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
    ["openai-chatgpt", openAIChatGPTProfileId],
    ["openai-chatgpt-codex", openAIChatGPTProfileId],
    ["chatgpt", openAIChatGPTProfileId],
    ["chatgpt-codex", openAIChatGPTProfileId],
    ["mock", mockProfileId]
  ]);

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    adapters: ProviderAdapter[],
    private readonly options: Required<ProviderRegistryOptions>
  ) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.id as ProviderProfileType, adapter);
    }

    for (const profile of createDefaultProfiles(env)) {
      this.profiles.set(profile.id, profile);
    }
  }

  list(): ProviderListResponse {
    return {
      providers: [...this.profiles.values()].map((profile) => this.profileWithRuntimeStatus(profile)),
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

    const currentProfile = this.profileWithRuntimeStatus(profile);
    return adapter.test(currentProfile, this.resolveCredential(currentProfile));
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

    profile = this.profileWithRuntimeStatus(profile);
    const adapter = this.adapters.get(profile.type);
    if (!adapter) {
      const fallbackProfile = this.requireProfile(mockProfileId);
      fallback = {
        fromProviderProfileId: profile.id,
        toProviderProfileId: fallbackProfile.id,
        reason: "unavailable",
        message: `No adapter is registered for provider type '${profile.type}'; using the mock provider.`
      };
      profile = this.profileWithRuntimeStatus(fallbackProfile);
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
    const chatGPTProfile = this.profiles.get(openAIChatGPTProfileId);
    if (chatGPTProfile?.enabled && this.resolveCredential(chatGPTProfile).oauth) {
      return chatGPTProfile.id;
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
    if (credentialRef === openAIChatGPTCredentialRef) {
      const inspection = this.options.openAIChatGPTCredentials.inspectSync?.();
      if (inspection?.kind === "present") {
        return {
          oauth: {
            ...inspection.credential,
            credentialRef
          }
        };
      }
      return {};
    }

    if (!credentialRef?.startsWith("env:")) {
      return {};
    }

    const envKey = credentialRef.slice("env:".length).trim();
    return {
      apiKey: envKey ? this.env[envKey]?.trim() || undefined : undefined
    };
  }

  private profileWithRuntimeStatus(profile: ProviderProfile): ProviderProfile {
    if (profile.type !== "openai-chatgpt") {
      return cloneProfile(profile);
    }

    const inspection = this.options.openAIChatGPTCredentials.inspectSync?.();
    const status = chatGPTStatusFromInspection(inspection);
    return {
      ...profile,
      status
    };
  }
}

export function createDefaultProviderRegistry(env: NodeJS.ProcessEnv, options: ProviderRegistryOptions = {}): ProviderRegistry {
  const openAIChatGPTCredentials = options.openAIChatGPTCredentials ?? new OpenAIChatGPTCredentialStore();
  return new ProviderRegistry(
    env,
    [
      new MockProvider(),
      new OpenAICompatibleProvider(),
      new OpenAIChatGPTProvider({
        credentialStore: openAIChatGPTCredentials,
        issuer: env.OPENAI_CHATGPT_AUTH_ISSUER,
        endpoint: env.OPENAI_CHATGPT_ENDPOINT,
        clientId: env.OPENAI_CHATGPT_CLIENT_ID
      })
    ],
    { openAIChatGPTCredentials }
  );
}

function createDefaultProfiles(env: NodeJS.ProcessEnv): ProviderProfile[] {
  const hasOpenAIKey = Boolean(env.OPENAI_API_KEY?.trim());
  const openAIBaseUrl = env.OPENAI_BASE_URL?.trim() || defaultOpenAIBaseUrl;
  const openAIModel = env.OPENAI_MODEL?.trim() || defaultOpenAIModel;
  const openAIChatGPTEndpoint = env.OPENAI_CHATGPT_ENDPOINT?.trim() || defaultOpenAIChatGPTEndpoint;
  const openAIChatGPTModel = env.OPENAI_CHATGPT_MODEL?.trim() || defaultOpenAIChatGPTModel;

  return [
    {
      id: mockProfileId,
      name: "Mock streaming provider",
      type: "mock",
      vendor: "local",
      runtime: "mock",
      authMode: "none",
      billingSource: "local",
      source: "builtin",
      enabled: true,
      runOptionSupport: {
        model: "unsupported",
        reasoningEffort: "metadata-only",
        temperature: "unsupported",
        usage: "unsupported"
      },
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
      vendor: "openai",
      runtime: "openai-compatible",
      authMode: "env-api-key",
      billingSource: "platform-api",
      source: "env",
      enabled: true,
      baseUrl: openAIBaseUrl,
      model: openAIModel,
      defaultRunOptions: { model: openAIModel },
      runOptionSupport: {
        model: "supported",
        reasoningEffort: "metadata-only",
        temperature: "supported",
        usage: "provider-reported"
      },
      credentialRef: "env:OPENAI_API_KEY",
      status: {
        state: hasOpenAIKey ? "configured" : "missing_credential",
        message: hasOpenAIKey
          ? "OPENAI_API_KEY is present. Use the test button to verify the endpoint."
          : "OPENAI_API_KEY is missing; runs that request this profile will fall back to mock.",
        credentialStatus: hasOpenAIKey ? "present" : "missing",
        errorCode: hasOpenAIKey ? undefined : "missing_credential"
      }
    },
    {
      id: openAIChatGPTProfileId,
      name: "OpenAI ChatGPT",
      type: "openai-chatgpt",
      vendor: "openai",
      runtime: "chatgpt-codex",
      authMode: "oauth-device",
      billingSource: "consumer-subscription",
      source: "builtin",
      enabled: true,
      endpoint: openAIChatGPTEndpoint,
      model: openAIChatGPTModel,
      defaultRunOptions: { model: openAIChatGPTModel },
      runOptionSupport: {
        model: "supported",
        reasoningEffort: "metadata-only",
        temperature: "unsupported",
        usage: "provider-reported"
      },
      credentialRef: openAIChatGPTCredentialRef,
      experimental: true,
      status: {
        state: "needs_auth",
        message: "OpenAI ChatGPT OAuth is not connected. Use Settings → Providers → Connect.",
        credentialStatus: "missing",
        errorCode: "auth_required"
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
  if (credential.oauth) {
    return credential.oauth.expiresAt && credential.oauth.expiresAt <= Date.now() ? "expired" : "present";
  }
  return credential.apiKey ? "present" : "missing";
}

function chatGPTStatusFromInspection(inspection: OpenAIChatGPTCredentialInspection | undefined): ProviderStatus {
  if (!inspection || inspection.kind === "missing") {
    return {
      state: "needs_auth",
      message: "OpenAI ChatGPT OAuth is not connected. Use Connect to start device authorization.",
      credentialStatus: "missing",
      errorCode: "auth_required"
    };
  }

  if (inspection.kind === "invalid") {
    return {
      state: "error",
      message: `OpenAI ChatGPT credential file is invalid: ${inspection.message}`,
      credentialStatus: "missing",
      errorCode: "invalid_credential_file"
    };
  }

  if (inspection.expired) {
    return {
      state: "expired",
      message: "OpenAI ChatGPT OAuth access token is expired. The next test or run will try to refresh it.",
      credentialStatus: "expired",
      errorCode: "credential_expired"
    };
  }

  return {
    state: "connected",
    message: `OpenAI ChatGPT OAuth credential is connected and stored in ${openAIChatGPTCredentialRef} (tokens are not returned by the API).`,
    credentialStatus: "present"
  };
}

function normalizeOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
