import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunInspector, type RunInspectorProps } from "../src/client/RunInspector";
import {
  assumedContextWindowTokens,
  boundHistoricalContextText,
  ContextBudgetExceededError,
  contextEstimatorVersion,
  estimateJsonTokens,
  estimateTextTokens,
  InvalidContextPolicyError,
  planContext,
  resolveContextBudget,
  type ResolvedContextBudget
} from "../src/kernel/context-budget";
import { buildContext } from "../src/kernel/context-builder";
import { RunEventBus } from "../src/kernel/event-bus";
import { Kernel, KernelError } from "../src/kernel/kernel";
import { contextPlanToJson } from "../src/kernel/kernel-metadata";
import { toolLoopSyntheticMessages } from "../src/kernel/tool-execution";
import {
  buildCodexRequestPayload,
  defaultCodexInstructions,
  openAIChatGPTContextPlanning,
  parseOpenAIChatGPTModelCatalog
} from "../src/providers/openai-chatgpt";
import {
  buildOpenAICompatibleRequestMessages,
  OpenAICompatibleProvider,
  openAICompatibleContextPlanning,
  openAICompatibleSystemMessageWrapperTokens,
  openAICompatibleTransportWrapperTokens,
  parseOpenAICompatibleModelCatalog
} from "../src/providers/openai-compatible";
import { MockProvider, mockContextWindowTokens, mockModelId } from "../src/providers/mock";
import { isProviderContextLengthFailure, ProviderContextLengthError } from "../src/providers/provider-errors";
import { parseAgentDefinitionPatch } from "../src/server/request-parsers";
import { ProviderRegistry } from "../src/providers/registry";
import type { ProviderAdapter, ProviderCredential, ProviderRunContext, ProviderRunInput } from "../src/providers/types";
import type {
  AgentDefinition,
  ContextMessage,
  ContextPlan,
  ContextPreviewResponse,
  JsonObject,
  Message,
  ModelToolDefinition,
  ProviderListResponse,
  ProviderModelCatalog,
  ProviderProfile,
  ProviderResolution,
  ProviderTestResponse,
  RunOptions,
  Session
} from "../src/shared/types";
import { SQLiteStore } from "../src/store/sqlite";
import { ToolRegistry } from "../src/tools/registry";

const fixtureTime = "2026-08-10T00:00:00.000Z";
const rawPromptSentinel = "CONTEXT_PLAN_RAW_PROMPT_SENTINEL_6f17";

function catalogCapabilityScenario(): void {
  const chatGPT = parseOpenAIChatGPTModelCatalog(
    {
      models: [
        {
          slug: "bounded-model",
          visibility: "list",
          context_window: 128_000,
          max_context_window: 96_000,
          supported_reasoning_levels: []
        },
        { slug: "single-window", visibility: "list", context_window: 64_000 },
        { slug: "invalid-window", visibility: "list", context_window: -1, max_context_window: 1.5 }
      ]
    },
    "chatgpt-fixture",
    fixtureTime
  );
  assert.deepEqual(chatGPT.models[0].context, { windowTokens: 96_000, source: "provider" });
  assert.deepEqual(chatGPT.models[1].context, { windowTokens: 64_000, source: "provider" });
  assert.equal(chatGPT.models[2].context, undefined);
  assert.match(chatGPT.warning ?? "", /smaller positive integer/);

  const compatible = parseOpenAICompatibleModelCatalog(
    { data: [{ id: "unknown-window", context_window: 1_000_000, max_context_window: 1_000_000 }] },
    "compatible-fixture",
    fixtureTime
  );
  assert.equal(compatible.models[0].context, undefined, "non-standard OpenAI-compatible context fields were trusted");
}

async function mockCapabilityScenario(): Promise<void> {
  const profile = providerProfile("mock", "mock", mockModelId);
  const catalog = await new MockProvider().listModels(profile, {});
  assert.deepEqual(catalog.models[0].context, { windowTokens: mockContextWindowTokens, source: "adapter" });

  assert.deepEqual(resolveContextBudget({ windowTokens: 32_000, source: "provider" }, null), {
    windowTokens: 32_000,
    windowSource: "provider",
    reservedOutputTokens: 2_048,
    safetyMarginTokens: 3_200,
    inputBudgetTokens: 26_752,
    capabilityStale: false
  });
  const override = resolveContextBudget(
    { windowTokens: 32_000, source: "provider" },
    { contextWindowTokensOverride: 20_000, reservedOutputTokens: 1_000, safetyMarginRatio: 0.05 }
  );
  assert.deepEqual(override, {
    windowTokens: 20_000,
    windowSource: "user",
    reservedOutputTokens: 1_000,
    safetyMarginTokens: 1_000,
    inputBudgetTokens: 18_000,
    capabilityStale: false
  });
  assert.equal(resolveContextBudget(null, null).windowTokens, assumedContextWindowTokens);
  assert.equal(resolveContextBudget(null, null).windowSource, "assumed");
  const registry = new ProviderRegistry({}, [new MockProvider()]);
  assert.deepEqual(await registry.resolveModelContextCapability("mock", undefined), {
    windowTokens: mockContextWindowTokens,
    source: "adapter"
  });
}

async function capabilityCacheScenario(): Promise<void> {
  let now = 1_000;
  const adapter = new CatalogFixtureProvider();
  const registry = new ProviderRegistry({ OPENAI_API_KEY: "fake-only" }, [adapter], {
    modelCatalogTtlMs: 100,
    now: () => now
  });
  const cold = await registry.resolveModelContextCapability("openai-compatible", "fixture-window-model");
  assert.deepEqual(cold, { windowTokens: 48_000, source: "provider" });
  const warm = await registry.resolveModelContextCapability("openai-compatible", "fixture-window-model");
  assert.deepEqual(warm, cold);
  assert.equal(adapter.catalogCalls, 1, "warm runtime resolution ignored catalog TTL cache");
  now += 101;
  adapter.failCatalog = true;
  const stale = await registry.resolveModelContextCapability("openai-compatible", "fixture-window-model");
  assert.deepEqual(stale, { windowTokens: 48_000, source: "provider", stale: true });
  assert.equal(resolveContextBudget(stale, null).capabilityStale, true);

  const restartedAdapter = new CatalogFixtureProvider();
  const restarted = new ProviderRegistry({ OPENAI_API_KEY: "fake-only" }, [restartedAdapter], {
    modelCatalogTtlMs: 100,
    now: () => now
  });
  assert.deepEqual(await restarted.resolveModelContextCapability("openai-compatible", "fixture-window-model"), cold);
  assert.equal(restartedAdapter.catalogCalls, 1, "cold restart did not use the runtime lazy-fetch path");
  const unavailableAfterRestart = new CatalogFixtureProvider();
  unavailableAfterRestart.failCatalog = true;
  const coldFailureRegistry = new ProviderRegistry({ OPENAI_API_KEY: "fake-only" }, [unavailableAfterRestart], {
    modelCatalogTtlMs: 100,
    now: () => now
  });
  const unavailableCapability = await coldFailureRegistry.resolveModelContextCapability("openai-compatible", "fixture-window-model");
  assert.equal(unavailableCapability, null);
  const fallbackBudget = resolveContextBudget(unavailableCapability, null);
  assert.equal(fallbackBudget.windowSource, "assumed");
  assert.equal(fallbackBudget.capabilityStale, false, "cold restart failure incorrectly claimed a persisted last-good capability");
  const assumedContext = buildContext({
    session: sessionFixture("main"),
    agent: agentFixture(),
    messages: [],
    currentMessage: { content: "cold restart fallback", messageId: "cold-restart" },
    currentMessageId: "cold-restart",
    contextCapability: unavailableCapability
  });
  assert.ok(assumedContext.warnings.some((warning) => warning.includes("assumed fallback")));
}

function estimatorScenario(): void {
  const plain = estimateTextTokens("hello deterministic estimator");
  assert.equal(plain, estimateTextTokens("hello deterministic estimator"));
  assert.ok(estimateTextTokens("안녕하세요 세계 🌏") > 0);
  assert.ok(estimateTextTokens("const value = { nested: [1, 2, 3], enabled: true };") > plain);
  assert.ok(estimateJsonTokens({ z: 1, a: { code: "const x = 1;" } }) > 0);
  assert.equal(estimateJsonTokens({ a: 1, b: 2 }), estimateJsonTokens({ b: 2, a: 1 }), "JSON estimate was key-order dependent");
  assert.equal(contextEstimatorVersion, "conservative-utf8-v1");
}

function planningScenario(): void {
  const requiredMessages: ContextMessage[] = [{ role: "user", content: "current request", source: "current", messageId: "current" }];
  const broad = planContext({
    systemPrompt: "system runtime prompt",
    messages: requiredMessages,
    availableTools: [toolDefinition()],
    budget: budget(50_000)
  });
  const exact = planContext({
    systemPrompt: "system runtime prompt",
    messages: requiredMessages,
    availableTools: [toolDefinition()],
    budget: budget(broad.plan.estimatedInputTokens)
  });
  assert.equal(exact.plan.estimatedInputTokens, exact.plan.inputBudgetTokens);
  assert.equal(exact.plan.compactionRecommended, true);
  assert.equal(exact.plan.compactionReason, "budget_threshold");
  assert.throws(
    () =>
      planContext({
        systemPrompt: "system runtime prompt",
        messages: requiredMessages,
        availableTools: [toolDefinition()],
        budget: budget(broad.plan.estimatedInputTokens - 1)
      }),
    (error: unknown) => error instanceof ContextBudgetExceededError && error.code === "context_budget_exceeded"
  );
  const oversizedCurrent = "CURRENT_INPUT_MUST_NOT_BE_TRUNCATED".repeat(1_000);
  assert.throws(
    () =>
      planContext({
        systemPrompt: "system",
        messages: [{ role: "user", content: oversizedCurrent, source: "current", messageId: "oversized-current" }],
        availableTools: [],
        budget: budget(500)
      }),
    (error: unknown) =>
      error instanceof ContextBudgetExceededError && error.details.sourceIds.includes("oversized-current")
  );

  const history: ContextMessage[] = [];
  for (let turn = 1; turn <= 4; turn += 1) {
    history.push({ role: "user", content: `user-${turn} ${"u".repeat(160)}`, source: "session", messageId: `u${turn}` });
    history.push({ role: "assistant", content: `assistant-${turn} ${"a".repeat(160)}`, source: "session", messageId: `a${turn}` });
  }
  history.push(...requiredMessages);
  const full = planContext({ systemPrompt: "system", messages: history, availableTools: [], budget: budget(50_000) });
  const allTurns = full.plan.included.filter((candidate) => candidate.kind === "message_turn");
  const requiredTokens = full.plan.estimatedInputTokens - allTurns.reduce(sumTokens, 0) - 8 * 8;
  const recentTokens = full.plan.included.filter((candidate) => candidate.retention === "recent").reduce(sumTokens, 0);
  const trimmed = planContext({
    systemPrompt: "system",
    messages: history,
    availableTools: [],
    budget: budget(requiredTokens + recentTokens + 8 * 4)
  });
  assert.equal(trimmed.plan.trimmingApplied, true);
  assert.equal(trimmed.plan.compactionReason, "trimming_applied");
  assert.deepEqual(
    trimmed.messages.filter((message) => message.source === "session").map((message) => message.messageId),
    ["u3", "a3", "u4", "a4"],
    "recent complete turns were not preserved atomically"
  );
  assert.deepEqual(trimmed.plan.omitted.flatMap((candidate) => candidate.sourceIds), ["u1", "a1", "u2", "a2"]);

  const toolPair: ContextMessage[] = [
    { role: "user", content: "use tool", source: "session", messageId: "tool-user" },
    {
      role: "assistant",
      content: "[tool result]\ncompleted output",
      source: "session",
      messageId: "tool-assistant",
      parts: [
        { type: "tool_call", text: "", sourcePartId: "call-part" },
        { type: "tool_result", text: "completed output", sourcePartId: "result-part" }
      ]
    },
    ...requiredMessages
  ];
  const toolPlan = planContext({ systemPrompt: "system", messages: toolPair, availableTools: [], budget: budget(50_000) });
  const toolTurn = toolPlan.plan.included.find((candidate) => candidate.kind === "message_turn");
  assert.deepEqual(toolTurn?.sourceIds, ["tool-user", "tool-assistant"]);
}

function contiguousSuffixAndFinalizationScenario(): void {
  const current: ContextMessage = { role: "user", content: "current", source: "current", messageId: "current" };
  const messages: ContextMessage[] = [
    { role: "user", content: "old", source: "session", messageId: "old-u" },
    { role: "assistant", content: "old answer", source: "session", messageId: "old-a", metadata: { status: "completed" } },
    { role: "user", content: "middle huge", source: "session", messageId: "huge-u" },
    { role: "assistant", content: "H".repeat(8_000), source: "session", messageId: "huge-a", metadata: { status: "completed" } },
    { role: "user", content: "new", source: "session", messageId: "new-u" },
    { role: "assistant", content: "new answer", source: "session", messageId: "new-a", metadata: { status: "completed" } },
    current
  ];
  const wide = planContext({ systemPrompt: "system", messages, availableTools: [], budget: budget(50_000) });
  const turns = wide.plan.included.filter((item) => item.kind === "message_turn");
  const requiredBase = wide.plan.estimatedInputTokens - turns.reduce(sumTokens, 0) - 8 * 6;
  const oldAndNewCost = turns[0].estimatedTokens + turns[2].estimatedTokens + 8 * 4;
  const noHole = planContext({ systemPrompt: "system", messages, availableTools: [], budget: budget(requiredBase + oldAndNewCost) });
  assert.deepEqual(
    noHole.messages.filter((message) => message.source === "session").map((message) => message.messageId),
    ["new-u", "new-a"]
  );
  assert.equal(noHole.plan.historyWatermark, "new-a");
  assert.equal(noHole.plan.historyThroughMessageId, "new-a");
  assert.equal(noHole.plan.selectedHistoryFromMessageId, "new-u");
  assert.equal(noHole.plan.selectedHistoryThroughMessageId, "new-a");
  assert.deepEqual(noHole.plan.omitted.map((item) => item.reason), ["before_selected_suffix_boundary", "suffix_boundary_turn_exceeds_budget"]);
  assert.deepEqual(noHole.plan.omitted.flatMap((item) => item.sourceIds), ["old-u", "old-a", "huge-u", "huge-a"]);

  const oversizedLatest = planContext({
    systemPrompt: "system",
    messages: messages.slice(0, 4).concat(current),
    availableTools: [],
    budget: budget(requiredBase + turns[0].estimatedTokens + 16)
  });
  assert.deepEqual(oversizedLatest.messages.filter((message) => message.source === "session"), []);
  assert.equal(oversizedLatest.plan.selectedHistoryFromMessageId, null);
  assert.equal(oversizedLatest.plan.omitted.at(-1)?.reason, "suffix_boundary_turn_exceeds_budget");

  const lifecycle: ContextMessage[] = [
    { role: "assistant", content: "orphan", source: "session", messageId: "orphan", metadata: { status: "completed" } },
    { role: "user", content: "complete", source: "session", messageId: "done-u" },
    { role: "assistant", content: "done", source: "session", messageId: "done-a", metadata: { status: "completed" } },
    { role: "user", content: "user only", source: "session", messageId: "user-only", metadata: { status: "failed" } },
    { role: "assistant", content: "failed", source: "session", messageId: "failed-a", metadata: { status: "failed" } },
    { role: "user", content: "interrupted", source: "session", messageId: "interrupted-u" },
    { role: "assistant", content: "partial", source: "session", messageId: "interrupted-a", metadata: { status: "streaming" } },
    current
  ];
  const finalized = planContext({ systemPrompt: "system", messages: lifecycle, availableTools: [], budget: budget(50_000) });
  assert.deepEqual(finalized.messages.filter((message) => message.source === "session").map((message) => message.messageId), ["done-u", "done-a"]);
  assert.ok(finalized.plan.omitted.some((item) => item.reason === "orphan_assistant_excluded"));
  assert.equal(finalized.plan.omitted.filter((item) => item.reason === "unfinished_user_turn_excluded").length, 2);
}

function toolReplanningAndNativeOverheadScenario(): void {
  const history: ContextMessage[] = [];
  for (let turn = 0; turn < 4; turn += 1) {
    history.push({ role: "user", content: `u${turn} ${"x".repeat(120)}`, source: "session", messageId: `u${turn}` });
    history.push({ role: "assistant", content: `a${turn} ${"y".repeat(120)}`, source: "session", messageId: `a${turn}`, metadata: { status: "completed" } });
  }
  const current: ContextMessage = { role: "user", content: "current", source: "current", messageId: "current" };
  const initialWide = planContext({ systemPrompt: "system", messages: [...history, current], availableTools: [], budget: budget(50_000) });
  const initial = planContext({
    systemPrompt: "system",
    messages: [...history, current],
    availableTools: [],
    budget: budget(initialWide.plan.estimatedInputTokens)
  });
  const synthetic: ContextMessage[] = [
    { role: "assistant", content: "tool-call-1/result-1", source: "synthetic", messageId: "active-1" }
  ];
  const replanned = planContext({
    systemPrompt: "system",
    messages: [...history, current, ...synthetic],
    availableTools: [],
    budget: budget(initial.plan.inputBudgetTokens)
  });
  assert.ok(replanned.plan.omitted.length > 0, "tool result did not evict compressible history");
  assert.equal(replanned.messages.at(-1)?.messageId, "active-1");
  assert.ok(replanned.plan.estimatedInputTokens <= replanned.plan.inputBudgetTokens);
  const multi = planContext({
    systemPrompt: "system",
    messages: [
      ...history,
      current,
      ...synthetic,
      { role: "assistant", content: "tool-call-2/result-2", source: "synthetic", messageId: "active-2" }
    ],
    availableTools: [],
    budget: budget(initial.plan.inputBudgetTokens)
  });
  assert.deepEqual(multi.messages.filter((message) => message.source === "synthetic").map((message) => message.messageId), ["active-1", "active-2"]);
  for (const omittedId of multi.plan.omitted.flatMap((item) => item.sourceIds)) {
    assert.equal(multi.messages.some((message) => message.messageId === omittedId), false, `trimmed ID ${omittedId} remained in payload`);
  }

  const chatGPT = planContext({
    systemPrompt: "agent instructions",
    messages: [current],
    availableTools: [toolDefinition()],
    budget: budget(50_000),
    providerOverhead: openAIChatGPTContextPlanning
  });
  assert.equal(chatGPT.plan.estimatedInputTokens, chatGPT.plan.providerNeutralTokens + chatGPT.plan.nativeOverheadTokens);
  assert.ok(chatGPT.plan.nativeOverheadTokens >= estimateTextTokens(defaultCodexInstructions));
  const compatible = planContext({
    systemPrompt: "agent instructions",
    messages: [current],
    availableTools: [toolDefinition()],
    budget: budget(50_000),
    providerOverhead: openAICompatibleContextPlanning
  });
  assert.equal(
    openAICompatibleContextPlanning.fixedWrapperTokens,
    openAICompatibleTransportWrapperTokens + openAICompatibleSystemMessageWrapperTokens
  );
  assert.ok(openAICompatibleSystemMessageWrapperTokens > 0);
  const built = buildContext({
    session: sessionFixture("main"),
    agent: agentFixture(),
    messages: [],
    currentMessage: { content: "native payload marker", messageId: "native-current" },
    currentMessageId: "native-current",
    availableTools: [toolDefinition()],
    providerOverhead: openAICompatibleContextPlanning
  }).context;
  const compatibleMessages = buildOpenAICompatibleRequestMessages(built);
  assert.ok(compatibleMessages.some((message) => message.role === "system" && message.content === built.systemPrompt));
  assert.ok(compatibleMessages.some((message) => message.content.includes("native payload marker")));
  assert.ok(compatible.plan.nativeOverheadTokens > 0);
  const codexPayload = buildCodexRequestPayload({
    session: sessionFixture("main"),
    context: built,
    messages: [],
    sourceMessages: [],
    profile: providerProfile("chatgpt", "openai-chatgpt", "gpt-fixture"),
    credential: {},
    requestedRunOptions: {},
    runOptions: { model: "gpt-fixture" },
    unsupportedRunOptions: []
  });
  assert.ok(codexPayload.instructions.includes(defaultCodexInstructions));
  assert.ok(codexPayload.instructions.includes(built.systemPrompt));
}

function metadataGrowthScenario(): void {
  const hugeSentinel = `HUGE_RAW_${"z".repeat(100_000)}`;
  const planned = planContext({
    systemPrompt: "system",
    messages: [
      { role: "user", content: "large historical request", source: "session", messageId: "large-u" },
      { role: "assistant", content: hugeSentinel, source: "session", messageId: "large-a", metadata: { status: "completed" } },
      { role: "user", content: "current", source: "current", messageId: "current" }
    ],
    availableTools: [],
    budget: budget(1_000)
  });
  const serializedPlan = JSON.stringify(contextPlanToJson(planned.plan));
  assert.equal(serializedPlan.includes(hugeSentinel), false);
  assert.ok(serializedPlan.length < 5_000, "ID/estimate-only plan grew with raw context content");
  const records = Array.from({ length: 64 }, (_, providerTurn) => ({
    planId: `plan-${providerTurn}`,
    providerTurn,
    toolIteration: providerTurn,
    createdAt: fixtureTime,
    plan: contextPlanToJson(planned.plan)
  }));
  assert.ok(
    JSON.stringify(records).length < records.length * (serializedPlan.length + 200),
    "plan-record metadata growth was not proportional to record count"
  );
}

function historicalOutputAndSyntheticScenario(): void {
  const originalOutput = `${"HEAD".repeat(1_500)}${"TAIL".repeat(1_500)}`;
  const message = messageFixture("tool-message", "assistant", "completed", [
    {
      id: "tool-result-part",
      messageId: "tool-message",
      seq: 0,
      type: "tool_result",
      text: originalOutput,
      content: { callId: "call-1", status: "completed", output: originalOutput, outputSummary: "completed" },
      metadata: {},
      createdAt: fixtureTime,
      updatedAt: fixtureTime
    },
    {
      id: "command-part",
      messageId: "tool-message",
      seq: 1,
      type: "command_output",
      text: originalOutput,
      content: { callId: "call-1", text: originalOutput, stream: "stdout" },
      metadata: {},
      createdAt: fixtureTime,
      updatedAt: fixtureTime
    }
  ]);
  const agent = agentFixture({ contextPolicy: { contextWindowTokensOverride: 16_384 } });
  const context = buildContext({
    session: sessionFixture(agent.id),
    agent,
    messages: [
      messageFixture("tool-user", "user", "completed", [
        {
          id: "tool-user-text",
          messageId: "tool-user",
          seq: 0,
          type: "text",
          text: "run command",
          content: { text: "run command" },
          metadata: {},
          createdAt: fixtureTime,
          updatedAt: fixtureTime
        }
      ]),
      message
    ],
    currentMessage: { content: "current", messageId: "current" },
    currentMessageId: "current",
    contextCapability: null
  });
  assert.equal(message.parts[0].text, originalOutput, "context-only bounding mutated the DB projection fixture");
  assert.ok(context.context.messages.find((item) => item.messageId === "tool-message")!.content.length <= 4_100);
  assert.match(context.context.messages.find((item) => item.messageId === "tool-message")!.content, /context-only truncation/);
  assert.match(context.context.messages.find((item) => item.messageId === "tool-message")!.content, /tool result.*completed/);
  assert.equal((context.context.messages.find((item) => item.messageId === "tool-message")!.content.match(/context-only truncation/g) ?? []).length, 1);
  assert.equal(context.plan.trimmingApplied, true);
  assert.equal(boundHistoricalContextText(originalOutput).length <= 4_000, true);

  const duplicateOutput = "DUPLICATE_COMMAND_OUTPUT_SENTINEL";
  const activeProjection = toolLoopSyntheticMessages(
    messageFixture("active-assistant", "assistant", "completed", [
      {
        id: "active-call",
        messageId: "active-assistant",
        seq: 0,
        type: "tool_call",
        text: "shell fixture",
        content: { callId: "active-call-id", toolId: "shell.exec", status: "completed" },
        metadata: {},
        createdAt: fixtureTime,
        updatedAt: fixtureTime
      },
      {
        id: "active-command",
        messageId: "active-assistant",
        seq: 1,
        type: "command_output",
        text: duplicateOutput,
        content: { callId: "active-call-id", text: duplicateOutput, stream: "combined" },
        metadata: {},
        createdAt: fixtureTime,
        updatedAt: fixtureTime
      },
      {
        id: "active-result",
        messageId: "active-assistant",
        seq: 2,
        type: "tool_result",
        text: duplicateOutput,
        content: { callId: "active-call-id", status: "completed", output: duplicateOutput, outputSummary: "completed" },
        metadata: {},
        createdAt: fixtureTime,
        updatedAt: fixtureTime
      }
    ])
  );
  assert.equal((activeProjection[0].content.match(/DUPLICATE_COMMAND_OUTPUT_SENTINEL/g) ?? []).length, 1);

  const synthetic = [{ role: "assistant" as const, content: "S".repeat(20_000), source: "synthetic" as const, messageId: "active-tool" }];
  const planned = planContext({
    systemPrompt: context.context.systemPrompt,
    messages: [...context.context.messages, ...synthetic],
    availableTools: context.context.availableTools,
    budget: budget(context.plan.inputBudgetTokens)
  });
  assert.ok(planned.messages.at(-1)!.content.length < synthetic[0].content.length);
  assert.ok(planned.plan.estimatedInputTokens <= planned.plan.inputBudgetTokens);
  assert.equal(planned.plan.included.at(-1)?.kind, "tool_result");

  assert.throws(
    () =>
      planContext({
        systemPrompt: context.context.systemPrompt,
        messages: [...context.context.messages, ...synthetic],
        availableTools: context.context.availableTools,
        budget: budget(40)
      }),
    ContextBudgetExceededError
  );
}

async function kernelPersistenceScenario(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "agent-platform-context-budget-"));
  const dbPath = join(directory, "context.db");
  try {
    const adapter = new RecordingProvider();
    const registry = fixtureRegistry(adapter, { windowTokens: 8_192, source: "provider" });
    let store = new SQLiteStore({ dbPath, defaultWorkingDirectory: directory });
    let kernel = new Kernel({ store, eventBus: new RunEventBus(), providers: registry, tools: new ToolRegistry(), toolExecutionCwd: directory });
    const agent = kernel.createAgentDefinition({
      name: "Budget Agent",
      systemPrompt: rawPromptSentinel,
      modelProfileId: "fixture-provider",
      contextPolicy: { contextWindowTokensOverride: 4_096, reservedOutputTokens: 512, safetyMarginRatio: 0.05 },
      toolIds: []
    });
    const session = kernel.createSession({ title: "Budget", workingDirectory: directory, agentId: agent.id });
    const preview = await kernel.previewContext(session.id, { text: "same current prompt" });
    assert.equal(preview.plan.windowSource, "user");
    assert.equal(preview.plan.windowTokens, 4_096);
    assert.equal(preview.plan.inputBudgetTokens, 3_380);
    assert.equal(JSON.stringify(preview.plan).includes(rawPromptSentinel), false, "safe ContextPlan leaked raw prompt content");

    const started = await kernel.startRun(session.id, "same current prompt");
    await waitForRunStatus(kernel, started.run.id, "completed");
    const [providerInput] = adapter.inputs;
    assert.ok(providerInput);
    assert.deepEqual(planComparable(providerInput.context.plan), planComparable(preview.plan));
    const internalRun = store.getRun(started.run.id)!;
    const planRecords = internalRun.metadata.contextPlanRecords as unknown as Array<{ plan: ContextPlan }>;
    assert.equal(planRecords.length, 1);
    assert.deepEqual(planComparable(planRecords[0].plan), planComparable(preview.plan));
    assert.equal((internalRun.metadata.agentSnapshot as JsonObject).contextPolicy !== undefined, true);
    const assistantMetadata = store.getMessage(started.assistantMessageId)!.metadata;
    assert.equal("contextSnapshot" in assistantMetadata, false);
    assert.equal("contextPlanRecords" in assistantMetadata, false);
    assert.deepEqual((internalRun.metadata.executionSnapshot as JsonObject).contextPolicy, {
      contextWindowTokensOverride: 4_096,
      reservedOutputTokens: 512,
      safetyMarginRatio: 0.05
    });
    const publicJson = JSON.stringify(kernel.getPublicRun(started.run.id));
    assert.equal(publicJson.includes(rawPromptSentinel), false);
    assert.equal(publicJson.includes("contextSnapshot"), false);
    const publicContext = kernel.getPublicRun(started.run.id).context;
    assert.equal(publicContext?.providerTurn, 0);
    assert.equal(publicContext?.toolIteration, 0);
    assert.equal(publicContext?.inputBudgetTokens, preview.plan.inputBudgetTokens);
    assert.equal(publicContext?.estimatedInputTokens, preview.plan.estimatedInputTokens);
    assert.equal(publicContext?.providerNeutralTokens, preview.plan.providerNeutralTokens);
    assert.equal(publicContext?.nativeOverheadTokens, preview.plan.nativeOverheadTokens);
    assert.equal(publicContext?.windowSource, "user");

    const overflowAgent = kernel.createAgentDefinition({
      name: "Required Overflow Agent",
      systemPrompt: "small system",
      modelProfileId: "fixture-provider",
      contextPolicy: { contextWindowTokensOverride: 1_024, reservedOutputTokens: 128, safetyMarginRatio: 0 },
      toolIds: []
    });
    const overflowSession = kernel.createSession({ title: "Required overflow", workingDirectory: directory, agentId: overflowAgent.id });
    const beforeOverflowRunCount = kernel.listRuns(overflowSession.id).length;
    await assert.rejects(
      kernel.startRun(overflowSession.id, "REQUIRED_INPUT".repeat(2_000)),
      (error: unknown) => error instanceof KernelError && error.code === "context_budget_exceeded" && error.statusCode === 400
    );
    assert.equal(kernel.listRuns(overflowSession.id).length, beforeOverflowRunCount, "preflight overflow created a run row");
    kernel.updateSession(overflowSession.id, { agentId: "main" });
    kernel.deleteAgentDefinition(overflowAgent.id, overflowAgent.revision);

    const invalidPolicyAgent = kernel.createAgentDefinition({
      name: "Invalid Context Policy Agent",
      systemPrompt: "small system",
      modelProfileId: "fixture-provider",
      contextPolicy: { contextWindowTokensOverride: 1_024, reservedOutputTokens: 900, safetyMarginRatio: 0.2 },
      toolIds: []
    });
    const invalidPolicySession = kernel.createSession({
      title: "Invalid policy",
      workingDirectory: directory,
      agentId: invalidPolicyAgent.id
    });
    for (const operation of [
      () => kernel.previewContext(invalidPolicySession.id, { text: "same policy" }),
      () => kernel.startRun(invalidPolicySession.id, "same policy")
    ]) {
      await assert.rejects(
        operation(),
        (error: unknown) => error instanceof KernelError && error.code === "invalid_context_policy" && error.statusCode === 400
      );
    }
    assert.equal(kernel.listRuns(invalidPolicySession.id).length, 0);
    kernel.updateSession(invalidPolicySession.id, { agentId: "main" });
    kernel.deleteAgentDefinition(invalidPolicyAgent.id, invalidPolicyAgent.revision);

    const updated = kernel.updateAgentDefinition({
      id: agent.id,
      expectedRevision: agent.revision,
      contextPolicy: { contextWindowTokensOverride: 6_000, reservedOutputTokens: 700, safetyMarginRatio: 0.1 },
      updatedAt: new Date().toISOString()
    });
    assert.throws(
      () =>
        kernel.updateAgentDefinition({
          id: agent.id,
          expectedRevision: agent.revision,
          contextPolicy: { contextWindowTokensOverride: 7_000 },
          updatedAt: new Date().toISOString()
        }),
      (error: unknown) => error instanceof KernelError && error.code === "agent_revision_conflict"
    );
    const clone = kernel.cloneAgentDefinition(updated.id, updated.revision);
    assert.deepEqual(clone.contextPolicy, updated.contextPolicy);
    kernel.updateSession(session.id, { agentId: "main" });
    kernel.deleteAgentDefinition(updated.id, updated.revision);
    await kernel.shutdown(100);
    closeStore(store);

    store = new SQLiteStore({ dbPath, defaultWorkingDirectory: directory });
    kernel = new Kernel({ store, eventBus: new RunEventBus(), providers: registry, tools: new ToolRegistry(), toolExecutionCwd: directory });
    assert.deepEqual(kernel.getAgentDefinition(clone.id).contextPolicy, {
      contextWindowTokensOverride: 6_000,
      reservedOutputTokens: 700,
      safetyMarginRatio: 0.1
    });
    const reloadedRecords = store.getRun(started.run.id)!.metadata.contextPlanRecords as unknown as Array<{ plan: ContextPlan }>;
    assert.deepEqual(planComparable(reloadedRecords[0].plan), planComparable(preview.plan));
    verifyContextPreviewMarkup(agent, session, preview, providerProfile("fixture-provider", "openai-compatible", "fixture-model"));
    closeStore(store);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function overflowClassificationScenario(): Promise<void> {
  assert.equal(
    isProviderContextLengthFailure({ status: 400, code: "context_length_exceeded", message: "maximum context length exceeded" }),
    true
  );
  assert.equal(isProviderContextLengthFailure({ status: 500, message: "temporary provider outage" }), false);
  assert.throws(
    () => resolveContextBudget({ windowTokens: 1_000, source: "provider" }, { reservedOutputTokens: 900, safetyMarginRatio: 0.1 }),
    (error: unknown) => error instanceof InvalidContextPolicyError && error.code === "invalid_context_policy"
  );
  const typed = new ProviderContextLengthError();
  assert.equal(typed.code, "context_length_exceeded");
  assert.deepEqual(
    parseAgentDefinitionPatch({
      expectedRevision: 2,
      contextPolicy: { contextWindowTokensOverride: 20_000, reservedOutputTokens: 1_000, safetyMarginRatio: 0.05 }
    }).contextPolicy,
    { contextWindowTokensOverride: 20_000, reservedOutputTokens: 1_000, safetyMarginRatio: 0.05 }
  );
  assert.equal(parseAgentDefinitionPatch({ contextPolicy: { automaticCompaction: true } }).contextPolicy?.automaticCompaction, true);
  assert.throws(() => parseAgentDefinitionPatch({ contextPolicy: { recursiveSummaryTree: true } }), /Unsupported Agent context policy/);

  const profile = providerProfile("overflow-provider", "openai-compatible", "overflow-model");
  const agent = agentFixture({ modelProfileId: profile.id });
  const context = buildContext({
    session: sessionFixture(agent.id),
    agent,
    messages: [],
    currentMessage: { content: "overflow fixture", messageId: "overflow-input" },
    currentMessageId: "overflow-input"
  }).context;
  const adapter = new OpenAICompatibleProvider({
    fetch: (async () =>
      Response.json(
        { error: { code: "context_length_exceeded", message: "maximum context length exceeded" } },
        { status: 400 }
      )) as typeof fetch
  });
  await assert.rejects(
    adapter.run(
      {
        session: sessionFixture(agent.id),
        context,
        messages: [],
        sourceMessages: [],
        profile,
        credential: { apiKey: "fixture-key" },
        requestedRunOptions: {},
        runOptions: { model: "overflow-model" },
        unsupportedRunOptions: []
      },
      { signal: new AbortController().signal, writer: noopWriter() }
    ),
    (error: unknown) => error instanceof ProviderContextLengthError && error.code === "context_length_exceeded"
  );

  for (const event of [
    { error: { code: "context_length_exceeded", message: "maximum context length exceeded", raw: "SECRET_BODY" } },
    { response: { error: { type: "too_many_tokens", message: "input token limit exceeded", raw: "SECRET_BODY" } } },
    { error: { message: "maximum context length exceeded", raw: "SECRET_BODY" } }
  ]) {
    const sseAdapter = new OpenAICompatibleProvider({
      fetch: (async () =>
        new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        })) as typeof fetch
    });
    await assert.rejects(
      sseAdapter.run(
        {
          session: sessionFixture(agent.id),
          context,
          messages: [],
          sourceMessages: [],
          profile,
          credential: { apiKey: "fixture-key" },
          requestedRunOptions: {},
          runOptions: { model: "overflow-model" },
          unsupportedRunOptions: []
        },
        { signal: new AbortController().signal, writer: noopWriter() }
      ),
      (error: unknown) => error instanceof ProviderContextLengthError && !error.message.includes("SECRET_BODY")
    );
  }
}

class RecordingProvider implements ProviderAdapter {
  readonly id = "openai-compatible";
  readonly label = "Context budget fixture";
  readonly inputs: ProviderRunInput[] = [];

  async test(profile: ProviderProfile, _credential: ProviderCredential): Promise<ProviderTestResponse> {
    return { ok: true, profile, status: profile.status, message: "fixture", checkedAt: fixtureTime };
  }

  async run(input: ProviderRunInput, context: ProviderRunContext) {
    this.inputs.push(input);
    await context.writer.writeDelta("context fixture complete");
    return { toolCalls: [] };
  }
}

class CatalogFixtureProvider implements ProviderAdapter {
  readonly id = "openai-compatible";
  readonly label = "Fake catalog fixture";
  readonly contextPlanning = openAICompatibleContextPlanning;
  catalogCalls = 0;
  failCatalog = false;

  async test(profile: ProviderProfile): Promise<ProviderTestResponse> {
    return { ok: true, profile, status: profile.status, message: "fixture", checkedAt: fixtureTime };
  }

  async listModels(profile: ProviderProfile): Promise<ProviderModelCatalog> {
    this.catalogCalls += 1;
    if (this.failCatalog) {
      throw new Error("fake catalog unavailable");
    }
    return {
      providerProfileId: profile.id,
      status: "available",
      source: "provider",
      stale: false,
      fetchedAt: fixtureTime,
      customModelAllowed: true,
      models: [
        {
          id: "fixture-window-model",
          reasoning: { support: "unknown", efforts: [] },
          context: { windowTokens: 48_000, source: "provider" }
        }
      ]
    };
  }

  async run(): Promise<{ toolCalls: [] }> {
    return { toolCalls: [] };
  }
}

function fixtureRegistry(adapter: ProviderAdapter, capability: { windowTokens: number; source: "provider" }): ProviderRegistry {
  const profile = providerProfile("fixture-provider", "openai-compatible", "fixture-model");
  const resolution: ProviderResolution = {
    requestedProvider: null,
    requestedProviderProfileId: profile.id,
    providerProfileId: profile.id,
    providerProfileName: profile.name,
    providerType: profile.type,
    model: profile.model,
    fallback: null
  };
  return {
    list(): ProviderListResponse {
      return { providers: [profile], defaultProviderProfileId: profile.id };
    },
    resolveRun() {
      return { adapter, profile, credential: {}, providerResolution: resolution };
    },
    resolveRunExact() {
      return { adapter, profile, credential: {}, providerResolution: resolution };
    },
    getModelContextCapability(_providerProfileId: string, modelId: string) {
      return modelId === profile.model ? capability : null;
    }
  } as unknown as ProviderRegistry;
}

function verifyContextPreviewMarkup(agent: AgentDefinition, session: Session, preview: ContextPreviewResponse, provider: ProviderProfile): void {
  const noop = () => undefined;
  const catalog: ProviderModelCatalog = {
    providerProfileId: provider.id,
    status: "available",
    source: "provider",
    stale: false,
    fetchedAt: fixtureTime,
    customModelAllowed: false,
    models: [
      {
        id: provider.model!,
        reasoning: { support: "unknown", efforts: [] },
        context: { windowTokens: 8_192, source: "provider" }
      }
    ]
  };
  const props: RunInspectorProps = {
    onClose: noop,
    modal: false,
    returnFocusRef: { current: null },
    setup: {
      agents: [agent],
      agentId: agent.id,
      agentSaveState: "idle",
      agentError: null,
      providers: [provider],
      providerProfileId: "",
      effectiveProviderProfileId: provider.id,
      defaultProviderProfileId: provider.id,
      modelOverride: "",
      reasoningEffort: "",
      temperature: "",
      modelCatalog: catalog,
      modelCatalogState: "loaded",
      modelCatalogError: null,
      disabled: false,
      onRefreshModelCatalog: noop,
      onAgentChange: noop,
      onProviderChange: noop,
      onModelOverrideChange: noop,
      onReasoningEffortChange: noop,
      onTemperatureChange: noop
    },
    sessionContext: {
      session,
      workingDirectoryDraft: session.workingDirectory,
      saveState: "idle",
      error: null,
      disabled: false,
      onWorkingDirectoryChange: noop,
      onSaveWorkingDirectory: noop
    },
    runStatus: {
      activeRun: null,
      statusLabel: "idle",
      statusTone: "idle",
      connectionState: "idle",
      terminalNotice: null,
      recoveryWarning: null,
      cancelPending: false,
      onCancel: noop,
      providerNotice: null,
      lastProviderResolution: null,
      lastRunOptions: null,
      lastRunUsage: null,
      lastUnsupportedRunOptions: []
    },
    permissions: { items: [], busyRequestId: null, onRefresh: noop, onApprove: noop, onDeny: noop },
    advanced: {
      contextPreview: preview,
      contextPreviewState: "idle",
      onPreviewContext: noop,
      compactionState: "idle",
      onCompactContext: noop,
      shellTool: null,
      sessionWorkingDirectory: session.workingDirectory,
      shellCommand: "",
      shellCwd: "",
      shellTimeoutMs: "",
      shellToolState: "idle",
      lastShellResponse: null,
      shellDisabled: false,
      onShellCommandChange: noop,
      onShellCwdChange: noop,
      onShellTimeoutChange: noop,
      onRunShell: noop
    }
  };
  const markup = renderToStaticMarkup(createElement(RunInspector, props));
  assert.match(markup, /Context window/);
  assert.match(markup, /4,096 tokens · user/);
  assert.match(markup, /Total estimated input/);
  assert.match(markup, /Compact now/);
  assert.match(markup, /8,192 context \(provider\)/);
}

function budget(inputBudgetTokens: number): ResolvedContextBudget {
  return {
    windowTokens: inputBudgetTokens + 128,
    windowSource: "assumed",
    reservedOutputTokens: 128,
    safetyMarginTokens: 0,
    inputBudgetTokens,
    capabilityStale: false
  };
}

function sumTokens(total: number, candidate: { estimatedTokens: number }): number {
  return total + candidate.estimatedTokens;
}

function toolDefinition(): ModelToolDefinition {
  return {
    id: "shell.exec",
    providerName: "shell_exec",
    name: "Shell",
    description: "Fixture tool schema",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
    metadata: {}
  };
}

function agentFixture(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "fixture-agent",
    revision: 1,
    name: "Fixture Agent",
    description: null,
    systemPrompt: "Fixture system prompt",
    modelProfileId: "fixture-provider",
    defaultRunOptions: null,
    contextPolicy: null,
    skillIds: [],
    toolIds: [],
    metadata: {},
    createdAt: fixtureTime,
    updatedAt: fixtureTime,
    ...overrides
  };
}

function sessionFixture(agentId: string): Session {
  return {
    id: "fixture-session",
    title: "Fixture",
    workingDirectory: "/fixture",
    agentId,
    createdAt: fixtureTime,
    updatedAt: fixtureTime
  };
}

function messageFixture(id: string, role: Message["role"], status: Message["status"], parts: Message["parts"]): Message {
  return {
    id,
    sessionId: "fixture-session",
    runId: null,
    role,
    status,
    error: null,
    metadata: {},
    model: null,
    runOptions: null,
    usage: null,
    createdAt: fixtureTime,
    updatedAt: fixtureTime,
    parts
  };
}

function providerProfile(id: string, type: ProviderProfile["type"], model: string): ProviderProfile {
  return {
    id,
    name: `Fixture ${id}`,
    type,
    vendor: "fixture",
    runtime: type,
    authMode: "none",
    billingSource: "local",
    source: "builtin",
    enabled: true,
    model,
    status: { state: "available", message: "fixture", credentialStatus: "not_required" }
  };
}

function planComparable(plan: ContextPlan): JsonObject {
  return {
    windowTokens: plan.windowTokens,
    windowSource: plan.windowSource,
    reservedOutputTokens: plan.reservedOutputTokens,
    safetyMarginTokens: plan.safetyMarginTokens,
    inputBudgetTokens: plan.inputBudgetTokens,
    estimatedInputTokens: plan.estimatedInputTokens,
    providerNeutralTokens: plan.providerNeutralTokens,
    nativeOverheadTokens: plan.nativeOverheadTokens,
    capabilityStale: plan.capabilityStale,
    historyWatermark: plan.historyWatermark,
    historyThroughMessageId: plan.historyThroughMessageId,
    selectedHistoryFromMessageId: plan.selectedHistoryFromMessageId,
    selectedHistoryThroughMessageId: plan.selectedHistoryThroughMessageId,
    activeSegmentId: plan.activeSegmentId,
    inheritedArtifactId: plan.inheritedArtifactId,
    preTrimEstimatedInputTokens: plan.preTrimEstimatedInputTokens,
    compactionRecommended: plan.compactionRecommended,
    compactionReason: plan.compactionReason,
    trimmingApplied: plan.trimmingApplied,
    estimatorVersion: plan.estimatorVersion,
    included: plan.included.map(({ sourceIds: _sourceIds, ...item }) => item),
    omitted: plan.omitted.map(({ sourceIds: _sourceIds, ...item }) => item)
  };
}

async function waitForRunStatus(kernel: Kernel, runId: string, expected: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = kernel.getRun(runId).status;
    if (status === expected) {
      return;
    }
    if (["completed", "failed", "cancelled", "interrupted"].includes(status)) {
      assert.fail(`run ${runId} reached ${status} while waiting for ${expected}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  assert.fail(`run ${runId} did not reach ${expected}`);
}

function closeStore(store: SQLiteStore): void {
  (store as unknown as { db: { close: () => void } }).db.close();
}

function noopWriter(): ProviderRunContext["writer"] {
  return {
    writeDelta() {},
    writeUsage() {},
    writeMetadata() {}
  };
}

async function main(): Promise<void> {
  catalogCapabilityScenario();
  await mockCapabilityScenario();
  await capabilityCacheScenario();
  estimatorScenario();
  planningScenario();
  contiguousSuffixAndFinalizationScenario();
  toolReplanningAndNativeOverheadScenario();
  metadataGrowthScenario();
  historicalOutputAndSyntheticScenario();
  await kernelPersistenceScenario();
  await overflowClassificationScenario();
  console.log("context budget smoke test passed");
}

await main();
