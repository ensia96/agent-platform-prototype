import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import {
  buildOpenAIChatGPTModelsEndpoint,
  OpenAIChatGPTProvider,
  openAIChatGPTClientVersion,
  parseOpenAIChatGPTModelCatalog
} from "../src/providers/openai-chatgpt";
import { OpenAIChatGPTCredentialStore, type OpenAIChatGPTCredential } from "../src/providers/openai-chatgpt-credentials";
import { MockProvider } from "../src/providers/mock";
import { OpenAICompatibleProvider, parseOpenAICompatibleModelCatalog } from "../src/providers/openai-compatible";
import { ProviderRegistry } from "../src/providers/registry";
import type { ProviderAdapter } from "../src/providers/types";
import { reconcileModelOverride, reconcileReasoningEffort } from "../src/client/model-catalog";
import { parseRunOptionsFromBody } from "../src/server/request-parsers";
import { registerApiRoutes, type ApiRouteDependencies } from "../src/server/routes";
import { defaultToolSettings } from "../src/shared/tool-settings";
import { buildRunOptionPlan } from "../src/kernel/kernel-metadata";
import type { ProviderModelCatalog, ProviderProfile } from "../src/shared/types";

const fixtureTime = "2026-08-01T00:00:00.000Z";

function verifyOpenAICompatibleParser(): void {
  const catalog = parseOpenAICompatibleModelCatalog(
    {
      object: "list",
      data: [
        { id: "chat-exact-1", object: "model", created: 123, owned_by: "fixture-owner", private_field: "RAW_SECRET" },
        { id: "embedding-exact-1", object: "model" },
        { id: "chat-exact-1", owned_by: "duplicate-must-not-win" },
        { id: "bad\u0000id" },
        { id: " padded-id " },
        { id: "" },
        null
      ]
    },
    "openai-compatible",
    fixtureTime
  );

  assert.equal(catalog.status, "available");
  assert.equal(catalog.source, "provider");
  assert.equal(catalog.customModelAllowed, true);
  assert.deepEqual(catalog.models, [
    { id: "chat-exact-1", owner: "fixture-owner", created: 123, reasoning: { support: "unknown", efforts: [] } },
    { id: "embedding-exact-1", reasoning: { support: "unknown", efforts: [] } }
  ]);
  assert.match(catalog.warning ?? "", /may include embedding/i);
  assert.equal(JSON.stringify(catalog).includes("RAW_SECRET"), false);
  assert.throws(() => parseOpenAICompatibleModelCatalog({ data: "not-an-array" }, "fixture"), /data array/);
}

function chatGPTFixture(): unknown {
  return {
    models: [
      {
        slug: "hidden-model",
        visibility: "hide",
        priority: 0,
        supported_reasoning_levels: [{ effort: "high" }]
      },
      {
        slug: "model-second",
        display_name: "Second model",
        visibility: "list",
        priority: 20,
        default_reasoning_level: "not-advertised",
        supported_reasoning_levels: [{ effort: "future-tier", description: "Opaque future tier" }]
      },
      {
        slug: "model-first",
        display_name: "First model",
        description: "Fixture description\nwith a line break.",
        visibility: "list",
        priority: 10,
        default_reasoning_level: "max",
        supported_reasoning_levels: [
          { effort: "none", description: "No reasoning" },
          { effort: "max", description: "Maximum reasoning" },
          { effort: "future-opaque", description: "Future value" },
          { effort: "ultra", description: "Must be hidden" },
          { effort: "ULTRA", description: "Must also be hidden" },
          { effort: "max", description: "Duplicate" },
          { effort: "bad\u0000effort" },
          { effort: "x".repeat(65) }
        ],
        raw_backend_secret: "RAW_CHATGPT_SECRET"
      },
      {
        slug: "model-first",
        display_name: "Lower-priority duplicate",
        visibility: "list",
        priority: 99,
        supported_reasoning_levels: []
      },
      { slug: "unknown-reasoning", visibility: "list", priority: 30 },
      { slug: "no-effort-model", visibility: "list", priority: 40, supported_reasoning_levels: [] },
      { slug: "not-listed", visibility: "LIST", priority: 1 },
      { slug: " padded-model ", visibility: "list", priority: 2 },
      { visibility: "list", priority: 2 },
      null
    ]
  };
}

function verifyChatGPTParserAndEndpoint(): void {
  const catalog = parseOpenAIChatGPTModelCatalog(chatGPTFixture(), "openai-chatgpt", fixtureTime);
  assert.deepEqual(catalog.models.map((model) => model.id), ["model-first", "model-second", "unknown-reasoning", "no-effort-model"]);
  assert.equal(catalog.customModelAllowed, true);
  assert.deepEqual(catalog.models[0].reasoning, {
    support: "supported",
    efforts: [
      { value: "none", description: "No reasoning" },
      { value: "max", description: "Maximum reasoning" },
      { value: "future-opaque", description: "Future value" }
    ],
    defaultEffort: "max"
  });
  assert.deepEqual(catalog.models[1].reasoning, {
    support: "supported",
    efforts: [{ value: "future-tier", description: "Opaque future tier" }]
  });
  assert.deepEqual(catalog.models[2].reasoning, { support: "unknown", efforts: [] });
  assert.deepEqual(catalog.models[3].reasoning, { support: "unsupported", efforts: [] });
  assert.equal(JSON.stringify(catalog).includes("RAW_CHATGPT_SECRET"), false);
  assert.equal(JSON.stringify(catalog).toLowerCase().includes("ultra"), false);
  assert.throws(() => parseOpenAIChatGPTModelCatalog({ models: null }, "fixture"), /models array/);

  assert.equal(
    buildOpenAIChatGPTModelsEndpoint("https://chatgpt.com/backend-api/codex/responses?ignored=1"),
    `https://chatgpt.com/backend-api/codex/models?client_version=${openAIChatGPTClientVersion}`
  );
  assert.throws(() => buildOpenAIChatGPTModelsEndpoint("https://example.com/v1/responses"), /\/codex\//);
}

async function verifyAdapterRequests(): Promise<void> {
  let openAIRequest: { url: string; headers: Headers } | null = null;
  const openAIFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    openAIRequest = { url: String(input), headers: new Headers(init?.headers) };
    return Response.json({ data: [{ id: "adapter-openai-model" }] });
  }) as typeof fetch;
  const openAIProvider = new OpenAICompatibleProvider({ fetch: openAIFetch });
  const openAIProfile = profileFixture({
    id: "openai-compatible",
    type: "openai-compatible",
    runtime: "openai-compatible",
    authMode: "env-api-key",
    billingSource: "platform-api",
    source: "env",
    baseUrl: "https://fixture.example/v1",
    credentialRef: "env:FIXTURE_KEY"
  });
  const openAICatalog = await openAIProvider.listModels(openAIProfile, { apiKey: "fixture-key" });
  assert.equal(openAIRequest?.url, "https://fixture.example/v1/models");
  assert.equal(openAIRequest?.headers.get("authorization"), "Bearer fixture-key");
  assert.deepEqual(openAICatalog.models.map((model) => model.id), ["adapter-openai-model"]);

  let chatGPTRequest: { url: string; headers: Headers } | null = null;
  const chatGPTFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    chatGPTRequest = { url: String(input), headers: new Headers(init?.headers) };
    return Response.json(chatGPTFixture());
  }) as typeof fetch;
  const credentialStore = new OpenAIChatGPTCredentialStore({ runtimeDir: join(tmpdir(), "model-catalog-smoke-unused") });
  const chatGPTProvider = new OpenAIChatGPTProvider({ credentialStore, fetch: chatGPTFetch });
  const chatGPTProfile = profileFixture({
    id: "openai-chatgpt",
    type: "openai-chatgpt",
    runtime: "chatgpt-codex",
    authMode: "oauth-device",
    billingSource: "consumer-subscription",
    source: "builtin",
    endpoint: "https://chatgpt.com/backend-api/codex/responses"
  });
  const oauth: OpenAIChatGPTCredential = {
    type: "oauth",
    access: "fixture-access",
    refresh: "fixture-refresh",
    expiresAt: Date.now() + 3_600_000,
    accountId: "fixture-account",
    updatedAt: fixtureTime
  };
  const chatGPTCatalog = await chatGPTProvider.listModels(chatGPTProfile, { oauth });
  assert.equal(chatGPTRequest?.url, `https://chatgpt.com/backend-api/codex/models?client_version=${openAIChatGPTClientVersion}`);
  assert.equal(chatGPTRequest?.headers.get("authorization"), "Bearer fixture-access");
  assert.equal(chatGPTRequest?.headers.get("chatgpt-account-id"), "fixture-account");
  assert.equal(chatGPTRequest?.headers.get("originator"), "agent-platform-prototype");
  assert.deepEqual(chatGPTCatalog.models.map((model) => model.id), ["model-first", "model-second", "unknown-reasoning", "no-effort-model"]);
}

async function verifyRegistryCache(): Promise<void> {
  let now = 0;
  let callCount = 0;
  let failWithSecret = false;
  let releaseInitialRequest: (() => void) | null = null;
  const initialGate = new Promise<void>((resolve) => {
    releaseInitialRequest = resolve;
  });
  let waitForInitialGate = true;

  const adapter: ProviderAdapter = {
    id: "openai-compatible",
    label: "Fixture adapter",
    async test() {
      throw new Error("unused");
    },
    async run() {
      return { toolCalls: [] };
    },
    async listModels(profile) {
      callCount += 1;
      if (waitForInitialGate) {
        await initialGate;
      }
      if (failWithSecret) {
        throw new Error("SECRET_PROVIDER_ERROR_BODY");
      }
      return availableCatalog(profile.id, `remote-model-${callCount}`);
    }
  };

  const registry = new ProviderRegistry(
    { OPENAI_API_KEY: "fixture-key", OPENAI_MODEL: "configured-model" },
    [adapter],
    { modelCatalogTtlMs: 100, now: () => now }
  );

  const firstRequest = registry.getModelCatalog("openai-compatible");
  const concurrentRequest = registry.getModelCatalog("openai");
  await Promise.resolve();
  assert.equal(callCount, 1, "concurrent aliases must share one provider request");
  waitForInitialGate = false;
  releaseInitialRequest?.();
  const [first, concurrent] = await Promise.all([firstRequest, concurrentRequest]);
  assert.equal(first?.models[0].id, "remote-model-1");
  assert.equal(concurrent?.models[0].id, "remote-model-1");

  if (first) {
    first.models[0].id = "caller-mutation";
  }
  now = 99;
  const cached = await registry.getModelCatalog("openai-compatible");
  assert.equal(callCount, 1);
  assert.equal(cached?.models[0].id, "remote-model-1", "cache results must be cloned for callers");

  const refreshed = await registry.getModelCatalog("openai-compatible", { refresh: true });
  assert.equal(callCount, 2);
  assert.equal(refreshed?.models[0].id, "remote-model-2");

  failWithSecret = true;
  now = 200;
  const stale = await registry.getModelCatalog("openai-compatible");
  assert.equal(stale?.status, "available");
  assert.equal(stale?.stale, true);
  assert.equal(stale?.customModelAllowed, true);
  assert.equal(stale?.models[0].id, "remote-model-2");
  assert.equal(JSON.stringify(stale).includes("SECRET_PROVIDER_ERROR_BODY"), false);
  const repeatedStale = await registry.getModelCatalog("openai-compatible");
  assert.equal(repeatedStale?.stale, true, "a failed refresh must not make the last-good catalog appear fresh again");

  registry.invalidateModelCatalog("openai");
  const configured = await registry.getModelCatalog("openai-compatible");
  assert.equal(configured?.status, "configured-only");
  assert.equal(configured?.source, "configured");
  assert.deepEqual(configured?.models.map((model) => model.id), ["configured-model"]);
  assert.equal(JSON.stringify(configured).includes("SECRET_PROVIDER_ERROR_BODY"), false);
  assert.equal(await registry.getModelCatalog("missing-profile"), null);
}

async function verifyConfiguredAndMockCatalogs(): Promise<void> {
  const credentialStore = new (class extends OpenAIChatGPTCredentialStore {
    override inspectSync() {
      return { kind: "missing" as const };
    }
  })({ runtimeDir: join(tmpdir(), "model-catalog-smoke-no-credentials") });
  const registry = new ProviderRegistry({}, [new MockProvider()], { openAIChatGPTCredentials: credentialStore });

  const chatGPTFallback = await registry.getModelCatalog("openai-chatgpt");
  assert.equal(chatGPTFallback?.status, "configured-only");
  assert.equal(chatGPTFallback?.source, "configured");
  assert.equal(chatGPTFallback?.customModelAllowed, true);
  assert.equal(chatGPTFallback?.models.length, 1);

  const mockCatalog = await registry.getModelCatalog("mock");
  assert.equal(mockCatalog?.source, "builtin");
  assert.equal(mockCatalog?.customModelAllowed, false);
  assert.equal(reconcileModelOverride(mockCatalog, "custom-mock-model"), "");
}

async function verifyModelCatalogRoute(): Promise<void> {
  let callCount = 0;
  const adapter: ProviderAdapter = {
    id: "openai-compatible",
    label: "Route fixture adapter",
    async test() {
      throw new Error("unused");
    },
    async run() {
      return { toolCalls: [] };
    },
    async listModels(profile) {
      callCount += 1;
      return availableCatalog(profile.id, `route-model-${callCount}`);
    }
  };
  const registry = new ProviderRegistry(
    { OPENAI_API_KEY: "fixture-key", OPENAI_MODEL: "configured-model" },
    [adapter],
    { modelCatalogTtlMs: 60_000 }
  );
  const app = express();
  app.use(express.json());
  registerApiRoutes(app, {
    dbPath: ":memory:",
    kernel: {} as ApiRouteDependencies["kernel"],
    openAIChatGPTAuth: {} as ApiRouteDependencies["openAIChatGPTAuth"],
    providers: registry,
    store: {
      listSettings: () => ({}),
      setSetting: () => undefined
    },
    getDaemonStatus: () => ({
      status: "ok",
      version: "fixture",
      pid: process.pid,
      startedAt: fixtureTime,
      uptimeSeconds: 0,
      mode: "test",
      port: 0,
      dbPath: ":memory:"
    }),
    getToolSettings: () => defaultToolSettings
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;

    const firstResponse = await fetch(`${origin}/api/providers/openai/models`);
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.headers.get("cache-control"), "no-store");
    const firstCatalog = (await firstResponse.json()) as ProviderModelCatalog;
    assert.equal(firstCatalog.providerProfileId, "openai-compatible");
    assert.equal(firstCatalog.models[0].id, "route-model-1");

    await fetch(`${origin}/api/providers/openai-compatible/models`);
    assert.equal(callCount, 1, "HTTP catalog requests must use the registry cache");
    const refreshResponse = await fetch(`${origin}/api/providers/openai-compatible/models?refresh=1`);
    assert.equal(refreshResponse.status, 200);
    assert.equal(((await refreshResponse.json()) as ProviderModelCatalog).models[0].id, "route-model-2");

    const missingResponse = await fetch(`${origin}/api/providers/missing-profile/models`);
    assert.equal(missingResponse.status, 404);
    assert.equal(missingResponse.headers.get("cache-control"), "no-store");
    assert.equal(((await missingResponse.json()) as { error: string }).error, "unknown_profile");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function verifyOpaqueEffortAndSelection(): void {
  assert.deepEqual(parseRunOptionsFromBody({ runOptions: { reasoningEffort: "  future-tier  " } }), {
    reasoningEffort: "future-tier"
  });
  assert.deepEqual(parseRunOptionsFromBody({ runOptions: { reasoningEffort: "none" } }), { reasoningEffort: "none" });
  assert.throws(() => parseRunOptionsFromBody({ runOptions: { reasoningEffort: "bad\nvalue" } }), /control characters/);
  assert.throws(() => parseRunOptionsFromBody({ runOptions: { reasoningEffort: "x".repeat(65) } }), /64 characters/);

  const catalog = parseOpenAIChatGPTModelCatalog(chatGPTFixture(), "openai-chatgpt", fixtureTime);
  const profile = profileFixture({
    id: "openai-chatgpt",
    type: "openai-chatgpt",
    runtime: "chatgpt-codex",
    authMode: "oauth-device",
    billingSource: "consumer-subscription",
    source: "builtin",
    model: "model-first",
    defaultRunOptions: { model: "model-first" }
  });
  assert.equal(reconcileReasoningEffort(catalog, profile, null, "", "max"), "max");
  assert.equal(reconcileReasoningEffort(catalog, profile, null, "", "future-opaque"), "future-opaque");
  assert.equal(reconcileReasoningEffort(catalog, profile, null, "", "high"), "");
  assert.equal(reconcileReasoningEffort(catalog, profile, null, "unknown-reasoning", "max"), "");
  assert.equal(reconcileReasoningEffort(catalog, profile, null, "removed-model", "max"), "");
  assert.equal(reconcileReasoningEffort(null, profile, null, "", "max"), "");
  assert.equal(reconcileModelOverride(catalog, "model-first"), "model-first");
  assert.equal(reconcileModelOverride(catalog, "removed-model"), "removed-model");
  assert.equal(reconcileModelOverride(availableCatalog("openai-compatible", "known"), "custom-model"), "custom-model");

  const chatGPTPlan = buildRunOptionPlan(profile, { reasoningEffort: "future-opaque" });
  assert.equal(chatGPTPlan.runOptions.reasoningEffort, "future-opaque");
  assert.deepEqual(chatGPTPlan.unsupportedRunOptions, []);
  const openAIPlan = buildRunOptionPlan(
    profileFixture({
      id: "openai-compatible",
      type: "openai-compatible",
      runtime: "openai-compatible",
      authMode: "env-api-key",
      billingSource: "platform-api",
      source: "env"
    }),
    { reasoningEffort: "future-opaque" }
  );
  assert.equal(openAIPlan.runOptions.reasoningEffort, undefined);
  assert.deepEqual(openAIPlan.unsupportedRunOptions, ["reasoningEffort"]);
}

function availableCatalog(providerProfileId: string, modelId: string): ProviderModelCatalog {
  return {
    providerProfileId,
    status: "available",
    source: "provider",
    stale: false,
    fetchedAt: fixtureTime,
    customModelAllowed: true,
    models: [{ id: modelId, reasoning: { support: "unknown", efforts: [] } }]
  };
}

function profileFixture(overrides: Partial<ProviderProfile> & Pick<ProviderProfile, "id" | "type" | "runtime" | "authMode" | "billingSource" | "source">): ProviderProfile {
  return {
    name: `Fixture ${overrides.id}`,
    vendor: overrides.type === "mock" ? "local" : "openai",
    enabled: true,
    status: { state: "configured", message: "fixture", credentialStatus: "present" },
    ...overrides
  };
}

async function main(): Promise<void> {
  verifyOpenAICompatibleParser();
  verifyChatGPTParserAndEndpoint();
  await verifyAdapterRequests();
  await verifyRegistryCache();
  await verifyConfiguredAndMockCatalogs();
  await verifyModelCatalogRoute();
  verifyOpaqueEffortAndSelection();
  console.log("model catalog smoke test passed");
}

await main();
