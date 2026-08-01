import { MockProvider, mockModelId } from "./mock";
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
  ProviderModelCatalog,
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
const defaultModelCatalogTtlMs = 5 * 60 * 1000;

export interface ProviderRegistryOptions {
  openAIChatGPTCredentials?: OpenAIChatGPTCredentialStore;
  modelCatalogTtlMs?: number;
  now?: () => number;
}

export interface ProviderModelCatalogRequestOptions {
  refresh?: boolean;
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

interface ModelCatalogCacheEntry {
  catalog: ProviderModelCatalog;
  expiresAt: number;
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
  private readonly modelCatalogCache = new Map<string, ModelCatalogCacheEntry>();
  private readonly modelCatalogRequests = new Map<string, Promise<ProviderModelCatalog>>();
  private readonly modelCatalogGenerations = new Map<string, number>();
  private readonly openAIChatGPTCredentials: OpenAIChatGPTCredentialStore;
  private readonly modelCatalogTtlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    adapters: ProviderAdapter[],
    options: ProviderRegistryOptions = {}
  ) {
    this.openAIChatGPTCredentials = options.openAIChatGPTCredentials ?? new OpenAIChatGPTCredentialStore();
    this.modelCatalogTtlMs =
      typeof options.modelCatalogTtlMs === "number" && Number.isFinite(options.modelCatalogTtlMs) && options.modelCatalogTtlMs >= 0
        ? options.modelCatalogTtlMs
        : defaultModelCatalogTtlMs;
    this.now = options.now ?? Date.now;
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

  async getModelCatalog(id: string, options: ProviderModelCatalogRequestOptions = {}): Promise<ProviderModelCatalog | null> {
    const profile = this.getProfile(id);
    if (!profile) {
      return null;
    }
    const cached = this.modelCatalogCache.get(profile.id);
    if (!options.refresh && cached && cached.expiresAt > this.now()) {
      return cloneModelCatalog(cached.catalog);
    }

    const currentRequest = this.modelCatalogRequests.get(profile.id);
    if (currentRequest) {
      return cloneModelCatalog(await currentRequest);
    }

    const generation = this.modelCatalogGenerations.get(profile.id) ?? 0;
    const request = this.loadModelCatalog(profile, cached?.catalog ?? null, generation);
    this.modelCatalogRequests.set(profile.id, request);
    try {
      return cloneModelCatalog(await request);
    } finally {
      if (this.modelCatalogRequests.get(profile.id) === request) {
        this.modelCatalogRequests.delete(profile.id);
      }
    }
  }

  invalidateModelCatalog(id?: string): void {
    if (id === undefined) {
      for (const profileId of this.profiles.keys()) {
        this.invalidateModelCatalog(profileId);
      }
      return;
    }
    const profileId = this.normalizeProfileId(id);
    if (!profileId) {
      return;
    }
    this.modelCatalogGenerations.set(profileId, (this.modelCatalogGenerations.get(profileId) ?? 0) + 1);
    this.modelCatalogCache.delete(profileId);
    this.modelCatalogRequests.delete(profileId);
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

  private async loadModelCatalog(
    profile: ProviderProfile,
    lastGood: ProviderModelCatalog | null,
    generation: number
  ): Promise<ProviderModelCatalog> {
    const currentProfile = this.profileWithRuntimeStatus(profile);
    const adapter = this.adapters.get(currentProfile.type);
    try {
      if (!adapter?.listModels) {
        throw new Error("Provider adapter does not implement model listing.");
      }
      const catalog = await adapter.listModels(currentProfile, this.resolveCredential(currentProfile));
      const normalized: ProviderModelCatalog = {
        ...catalog,
        providerProfileId: currentProfile.id,
        stale: false,
        models: catalog.models.map(cloneModelCatalogItem)
      };
      if (normalized.status === "available" && (this.modelCatalogGenerations.get(profile.id) ?? 0) === generation) {
        this.modelCatalogCache.set(profile.id, {
          catalog: cloneModelCatalog(normalized),
          expiresAt: this.now() + this.modelCatalogTtlMs
        });
      }
      return normalized;
    } catch {
      const warning = "Remote model catalog is currently unavailable; no provider error body or credential data is exposed.";
      if (lastGood?.status === "available") {
        const staleCatalog: ProviderModelCatalog = {
          ...cloneModelCatalog(lastGood),
          stale: true,
          warning: joinWarnings(lastGood.warning, warning)
        };
        if ((this.modelCatalogGenerations.get(profile.id) ?? 0) === generation) {
          this.modelCatalogCache.set(profile.id, {
            catalog: cloneModelCatalog(staleCatalog),
            expiresAt: this.now()
          });
        }
        return staleCatalog;
      }
      return configuredModelCatalog(currentProfile, new Date(this.now()).toISOString(), warning);
    }
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
      const inspection = this.openAIChatGPTCredentials.inspectSync?.();
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

    const inspection = this.openAIChatGPTCredentials.inspectSync?.();
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
    { ...options, openAIChatGPTCredentials }
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
        reasoningEffort: "unsupported",
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
        reasoningEffort: "supported",
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

function configuredModelCatalog(profile: ProviderProfile, fetchedAt: string, warning: string): ProviderModelCatalog {
  const model = profile.defaultRunOptions?.model?.trim() || profile.model?.trim();
  return {
    providerProfileId: profile.id,
    status: model ? "configured-only" : "unavailable",
    source: "configured",
    stale: false,
    fetchedAt,
    warning,
    customModelAllowed: profile.type !== "mock",
    models: model
      ? [
          {
            id: model,
            reasoning: { support: profile.type === "mock" ? "unsupported" : "unknown", efforts: [] }
          }
        ]
      : []
  };
}

function cloneModelCatalog(catalog: ProviderModelCatalog): ProviderModelCatalog {
  return {
    ...catalog,
    models: catalog.models.map(cloneModelCatalogItem)
  };
}

function cloneModelCatalogItem(item: ProviderModelCatalog["models"][number]): ProviderModelCatalog["models"][number] {
  return {
    ...item,
    reasoning: {
      ...item.reasoning,
      efforts: item.reasoning.efforts.map((effort) => ({ ...effort }))
    }
  };
}

function joinWarnings(...warnings: Array<string | undefined>): string | undefined {
  const values = [...new Set(warnings.map((warning) => warning?.trim()).filter((warning): warning is string => Boolean(warning)))];
  return values.length > 0 ? values.join(" ") : undefined;
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
