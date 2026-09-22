import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import express from "express";
import { ContextSegmentBoundary, isCurrentContextUiRequest } from "../src/client/App";
import { Kernel } from "../src/kernel/kernel";
import { RunEventBus } from "../src/kernel/event-bus";
import type { ProviderAdapter, ProviderCredential, ProviderRunContext, ProviderRunInput } from "../src/providers/types";
import type { ProviderRegistry } from "../src/providers/registry";
import { ProviderContextLengthError } from "../src/providers/provider-errors";
import type {
  ProviderListResponse,
  ProviderProfile,
  ProviderResolution,
  ProviderTestResponse
} from "../src/shared/types";
import { SQLiteStore } from "../src/store/sqlite";
import { ToolRegistry } from "../src/tools/registry";
import { registerApiRoutes } from "../src/server/routes";
import { defaultToolSettings } from "../src/shared/tool-settings";

const fixtureTime = "2026-08-26T00:00:00.000Z";

class CompactionProvider implements ProviderAdapter {
  readonly id = "openai-compatible";
  readonly label = "Compaction fake provider";
  readonly contextPlanning = {
    requiredInstructions: [],
    fixedWrapperTokens: 24,
    perMessageTokens: 8,
    toolEnvelopeTokens: 16
  };
  mode: "success" | "empty" | "malformed" | "tool" | "failure" | "context-overflow" | "oversized" | "delay" | "block" = "success";
  compactionInputs: ProviderRunInput[] = [];
  summaryCount = 0;
  summaryPadding = 0;

  async test(profile: ProviderProfile, _credential: ProviderCredential): Promise<ProviderTestResponse> {
    return { ok: true, profile, status: profile.status, message: "fake", checkedAt: fixtureTime };
  }

  async run(input: ProviderRunInput, context: ProviderRunContext) {
    const compaction = input.context.systemPrompt.includes("cumulative continuity summary");
    if (!compaction) {
      await context.writer.writeDelta("normal answer");
      await context.writer.writeUsage({ inputTokens: 20, outputTokens: 3, totalTokens: 23 });
      return { toolCalls: [] };
    }
    this.compactionInputs.push(input);
    this.summaryCount += 1;
    await context.writer.writeUsage({ inputTokens: 100, outputTokens: 40, totalTokens: 140 });
    if (this.mode === "failure") {
      throw new Error("fake provider failed with Bearer abcdefghijklmnopqrstuvwxyz");
    }
    if (this.mode === "context-overflow") {
      throw new ProviderContextLengthError();
    }
    if (this.mode === "block") {
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("compaction interrupted")), { once: true });
      });
    }
    if (this.mode === "delay") {
      await delay(40);
    }
    if (this.mode === "empty") {
      return { toolCalls: [] };
    }
    if (this.mode === "malformed") {
      await context.writer.writeDelta("A summary without required continuity sections.");
      return { toolCalls: [] };
    }
    if (this.mode === "tool") {
      return { toolCalls: [{ id: "unexpected", name: "shell_exec", arguments: {} }] };
    }
    if (this.mode === "oversized") {
      await context.writer.writeDelta("O".repeat(13_000));
      return { toolCalls: [] };
    }
    await context.writer.writeDelta(
      [
        "Goals and user intent",
        `Cumulative fixture summary ${this.summaryCount} ${"P".repeat(this.summaryPadding)}`,
        "Decisions and constraints",
        "Keep the logical session.",
        "Current implementation and changed files",
        "Segment fixture.",
        "Validation and results",
        "Fake-provider smoke passed.",
        "Open issues and next work",
        "Continue safely.",
        "Important tool results",
        "None."
      ].join("\n")
    );
    return { toolCalls: [] };
  }
}

function fixtureRegistry(
  adapter: ProviderAdapter,
  capabilityResolver: () => Promise<{ windowTokens: number; source: "provider" }> = async () => ({
    windowTokens: 8_192,
    source: "provider"
  })
): ProviderRegistry {
  const profile: ProviderProfile = {
    id: "fixture-provider",
    name: "Fixture provider",
    type: "openai-compatible",
    vendor: "fixture",
    runtime: "fake",
    authMode: "none",
    billingSource: "local",
    source: "builtin",
    enabled: true,
    model: "fixture-model",
    defaultRunOptions: { model: "fixture-model" },
    runOptionSupport: {
      model: "supported",
      reasoningEffort: "unsupported",
      temperature: "supported",
      usage: "provider-reported"
    },
    status: { state: "available", message: "fake", credentialStatus: "not_required" }
  };
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
    async resolveModelContextCapability() {
      return capabilityResolver();
    }
  } as unknown as ProviderRegistry;
}

async function startRunSegmentRaceScenario(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "agent-platform-segment-race-"));
  try {
    const provider = new CompactionProvider();
    let delayed = false;
    let releaseCapability: (() => void) | null = null;
    const registry = fixtureRegistry(provider, async () => {
      if (delayed) {
        delayed = false;
        await new Promise<void>((resolvePromise) => {
          releaseCapability = resolvePromise;
        });
      }
      return { windowTokens: 8_192, source: "provider" };
    });
    const store = new SQLiteStore({ dbPath: join(directory, "race.db"), defaultWorkingDirectory: directory });
    const kernel = new Kernel({ store, eventBus: new RunEventBus(), providers: registry, tools: new ToolRegistry(), toolExecutionCwd: directory });
    const agent = kernel.createAgentDefinition({
      name: "Segment race",
      systemPrompt: "Race fixture.",
      modelProfileId: "fixture-provider",
      contextPolicy: { automaticCompaction: false },
      toolIds: []
    });
    const session = kernel.createSession({ title: "Race", agentId: agent.id, workingDirectory: directory });
    for (let turn = 1; turn <= 5; turn += 1) await completedTurn(kernel, session.id, `race-history-${turn}`);
    const oldSegmentId = kernel.getSession(session.id).activeSegmentId;
    delayed = true;
    const starting = kernel.startRun(session.id, "planned against the changing segment");
    await waitUntil(() => releaseCapability !== null);
    const compacted = await kernel.compactSession(session.id);
    assert.equal(compacted.state, "completed");
    const newSegmentId = kernel.getSession(session.id).activeSegmentId;
    assert.notEqual(newSegmentId, oldSegmentId);
    releaseCapability!();
    const started = await starting;
    await waitForRunStatus(kernel, started.run.id, "completed");
    assert.equal(kernel.getRun(started.run.id).segmentId, newSegmentId);
    const replannedRecord = (kernel.getRun(started.run.id).metadata.contextPlanRecords as unknown as Array<{
      plan: { activeSegmentId: string; inheritedArtifactId: string | null };
    }>)[0];
    assert.equal(replannedRecord.plan.activeSegmentId, newSegmentId);
    assert.equal(replannedRecord.plan.inheritedArtifactId, compacted.artifact?.id ?? null);
    assert.ok(kernel.listMessages(session.id).filter((message) => message.runId === started.run.id).every((message) => message.segmentId === newSegmentId));
    assert.equal(store.listMessagesBySegment(oldSegmentId).some((message) => message.runId === started.run.id), false);
    closeStore(store);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function unsuccessfulPrefixScenario(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "agent-platform-unsuccessful-prefix-"));
  try {
    const provider = new CompactionProvider();
    const store = new SQLiteStore({ dbPath: join(directory, "prefix.db"), defaultWorkingDirectory: directory });
    const kernel = new Kernel({ store, eventBus: new RunEventBus(), providers: fixtureRegistry(provider), tools: new ToolRegistry(), toolExecutionCwd: directory });
    const agent = kernel.createAgentDefinition({
      name: "Prefix categories",
      systemPrompt: "Summarize terminal audit entries.",
      modelProfileId: "fixture-provider",
      contextPolicy: { automaticCompaction: false },
      toolIds: []
    });
    const session = kernel.createSession({ title: "Prefix", agentId: agent.id, workingDirectory: directory });
    const failedRun = store.createRun({
      id: "failed-prefix-run",
      sessionId: session.id,
      segmentId: session.activeSegmentId,
      provider: "fixture-provider",
      status: "running",
      createdAt: fixtureTime,
      updatedAt: fixtureTime
    });
    store.createMessage({ id: "failed-prefix-user", sessionId: session.id, runId: failedRun.id, segmentId: session.activeSegmentId, role: "user", status: "completed", createdAt: fixtureTime, updatedAt: fixtureTime });
    store.addMessagePart({ id: "failed-prefix-user-text", messageId: "failed-prefix-user", seq: 0, text: "attempt the risky migration", createdAt: fixtureTime, updatedAt: fixtureTime });
    store.createMessage({ id: "failed-prefix-assistant", sessionId: session.id, runId: failedRun.id, segmentId: session.activeSegmentId, role: "assistant", status: "failed", metadata: { error: "sanitized failure" }, createdAt: fixtureTime, updatedAt: fixtureTime });
    store.finalizeRun({ runId: failedRun.id, expectedStatuses: ["running"], status: "failed", error: "sanitized failure", updatedAt: fixtureTime, event: { id: "failed-prefix-event", type: "run_failed", payload: {} } });

    createTerminalAttempt(store, session.id, session.activeSegmentId, "cancelled", 1);
    createTerminalAttempt(store, session.id, session.activeSegmentId, "interrupted", 2);

    const toolRun = store.createRun({ id: "standalone-tool-run", sessionId: session.id, segmentId: session.activeSegmentId, provider: "tool:shell.exec", status: "running", createdAt: "2026-08-26T00:00:03.000Z", updatedAt: "2026-08-26T00:00:03.000Z" });
    const toolMessage = store.createMessage({ id: "standalone-tool-message", sessionId: session.id, runId: toolRun.id, segmentId: session.activeSegmentId, role: "assistant", status: "completed", createdAt: "2026-08-26T00:00:03.000Z", updatedAt: "2026-08-26T00:00:03.000Z" });
    store.addMessagePart({ id: "standalone-tool-output", messageId: toolMessage.id, seq: 0, type: "command_output", text: "standalone result", content: { callId: "standalone", text: "standalone result" }, createdAt: fixtureTime, updatedAt: fixtureTime });
    store.finalizeRun({ runId: toolRun.id, expectedStatuses: ["running"], status: "completed", error: null, updatedAt: fixtureTime, event: { id: "standalone-tool-event", type: "run_completed", payload: {} } });
    store.createMessage({ id: "orphan-audit-message", sessionId: session.id, segmentId: session.activeSegmentId, role: "assistant", status: "completed", createdAt: "2026-08-26T00:00:04.000Z", updatedAt: "2026-08-26T00:00:04.000Z" });
    store.addMessagePart({ id: "orphan-audit-text", messageId: "orphan-audit-message", seq: 0, text: "corrupt orphan body must not block", createdAt: fixtureTime, updatedAt: fixtureTime });
    for (let turn = 1; turn <= 4; turn += 1) await completedTurn(kernel, session.id, `successful-after-failure-${turn}`);
    const compacted = await kernel.compactSession(session.id);
    assert.equal(compacted.state, "completed", compacted.message);
    const categories = compacted.artifact!.sourceCategories.map((entry) => entry.category);
    assert.deepEqual(categories.slice(0, 5), ["unsuccessful_turn", "unsuccessful_turn", "unsuccessful_turn", "standalone_tool", "orphan_record"]);
    assert.equal(categories.filter((category) => category === "completed_turn").length, 2);
    assert.ok(compacted.artifact!.sourceMessageIds.includes("failed-prefix-user"));
    assert.ok(compacted.artifact!.sourceMessageIds.includes("orphan-audit-message"));
    const categorizedPrompt = provider.compactionInputs.at(-1)!.messages.map((message) => message.content).join("\n");
    assert.match(categorizedPrompt, /attempt the risky migration/);
    assert.match(categorizedPrompt, /unsuccessful_turn/);
    assert.match(categorizedPrompt, /standalone result/);
    assert.equal(categorizedPrompt.includes("corrupt orphan body must not block"), false);
    closeStore(store);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function earlyFailureAuditScenario(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "agent-platform-early-compaction-failure-"));
  try {
    const provider = new CompactionProvider();
    const registry = fixtureRegistry(provider) as ProviderRegistry & { resolveRunExact: () => never };
    const originalResolveExact = registry.resolveRunExact.bind(registry);
    const store = new SQLiteStore({ dbPath: join(directory, "early.db"), defaultWorkingDirectory: directory });
    const kernel = new Kernel({ store, eventBus: new RunEventBus(), providers: registry, tools: new ToolRegistry(), toolExecutionCwd: directory });
    const agent = kernel.createAgentDefinition({ name: "Early failure", systemPrompt: "Audit safely.", modelProfileId: "fixture-provider", contextPolicy: { automaticCompaction: false }, toolIds: [] });
    const session = kernel.createSession({ title: "Early failure", agentId: agent.id, workingDirectory: directory });
    for (let turn = 1; turn <= 4; turn += 1) await completedTurn(kernel, session.id, `early-${turn}`);
    registry.resolveRunExact = (() => { throw new Error("Bearer abcdefghijklmnopqrstuvwxyz unavailable"); }) as never;
    const activeBefore = kernel.getSession(session.id).activeSegmentId;
    const failed = await kernel.compactSession(session.id);
    assert.equal(failed.state, "failed");
    assert.equal(failed.artifact?.status, "failed");
    assert.equal(failed.artifact?.error?.includes("abcdefghijklmnopqrstuvwxyz"), false);
    assert.equal(kernel.getSession(session.id).activeSegmentId, activeBefore);
    assert.equal(kernel.listContextSegments(session.id).find((segment) => segment.id === activeBefore)?.recentFailure?.id, failed.artifact?.id);
    registry.resolveRunExact = originalResolveExact;
    closeStore(store);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function completedTurn(kernel: Kernel, sessionId: string, text: string): Promise<string> {
  const created = await kernel.startRun(sessionId, text);
  await waitForRunStatus(kernel, created.run.id, "completed");
  return created.run.id;
}

async function manualAndLineageScenario(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "agent-platform-compaction-"));
  const dbPath = join(directory, "context.db");
  try {
    const provider = new CompactionProvider();
    const store = new SQLiteStore({ dbPath, defaultWorkingDirectory: directory });
    const kernel = new Kernel({
      store,
      eventBus: new RunEventBus(),
      providers: fixtureRegistry(provider),
      tools: new ToolRegistry(),
      toolExecutionCwd: directory
    });
    const agent = kernel.createAgentDefinition({
      name: "Compaction agent",
      systemPrompt: "Keep continuity.",
      modelProfileId: "fixture-provider",
      contextPolicy: { automaticCompaction: false, contextWindowTokensOverride: 8_192, reservedOutputTokens: 512, safetyMarginRatio: 0.05 },
      toolIds: []
    });
    const session = kernel.createSession({ title: "Logical session", agentId: agent.id, workingDirectory: directory });
    assert.equal(kernel.listContextSegments(session.id).length, 1);
    assert.equal(kernel.listContextSegments(session.id)[0].status, "active");
    assert.equal((await kernel.compactSession(session.id)).state, "noop");
    const conflictRun = store.createRun({
      id: "manual-conflict-run",
      sessionId: session.id,
      segmentId: session.activeSegmentId,
      provider: "fixture-provider",
      status: "running",
      createdAt: fixtureTime,
      updatedAt: fixtureTime
    });
    await assert.rejects(kernel.compactSession(session.id), (error: unknown) => (error as { code?: string }).code === "context_compaction_conflict");
    store.finalizeRun({
      runId: conflictRun.id,
      expectedStatuses: ["running"],
      status: "failed",
      error: "fixture cleanup",
      updatedAt: fixtureTime,
      event: { id: "manual-conflict-event", type: "run_failed", payload: {} }
    });

    const runIds: string[] = [];
    for (let turn = 1; turn <= 5; turn += 1) {
      runIds.push(await completedTurn(kernel, session.id, `turn-${turn}`));
    }
    const firstAssistant = store.getAssistantMessageForRun(runIds[0])!;
    store.addMessagePart({
      id: "compaction-tool-result",
      messageId: firstAssistant.id,
      seq: 1,
      type: "tool_result",
      text: "COMPACTION_DUPLICATE_OUTPUT",
      content: {
        callId: "compaction-call",
        status: "completed",
        output: "COMPACTION_DUPLICATE_OUTPUT",
        outputSummary: "command completed"
      },
      createdAt: fixtureTime,
      updatedAt: fixtureTime
    });
    store.addMessagePart({
      id: "compaction-command-output",
      messageId: firstAssistant.id,
      seq: 2,
      type: "command_output",
      text: "COMPACTION_DUPLICATE_OUTPUT",
      content: { callId: "compaction-call", text: "COMPACTION_DUPLICATE_OUTPUT", stream: "combined" },
      createdAt: fixtureTime,
      updatedAt: fixtureTime
    });
    const beforeMessages = kernel.listMessages(session.id);
    const beforeEvents = runIds.map((runId) => kernel.listRunEvents(runId).length);
    assert.equal(kernel.listContextSegments(session.id).length, 1, "disabled automatic compaction changed the segment");
    provider.summaryPadding = 4_000;
    const first = await kernel.compactSession(session.id);
    provider.summaryPadding = 0;
    assert.equal(first.state, "completed", first.message);
    assert.ok(first.artifact);
    assert.equal(first.artifact.sourceMessageIds.length, 6, "three old atomic turns were not sealed");
    assert.deepEqual(provider.compactionInputs[0].context.availableTools, []);
    assert.match(provider.compactionInputs[0].context.systemPrompt, /Goals and user intent/);
    assert.match(provider.compactionInputs[0].context.systemPrompt, /Important tool results/);
    const summaryRequest = provider.compactionInputs[0].messages.map((message) => message.content).join("\n");
    assert.equal((summaryRequest.match(/COMPACTION_DUPLICATE_OUTPUT/g) ?? []).length, 1);
    assert.match(summaryRequest, /command completed/);
    assert.equal(kernel.listContextSegments(session.id).filter((segment) => segment.status === "active").length, 1);
    const [sealed, active] = kernel.listContextSegments(session.id);
    assert.equal(sealed.status, "sealed");
    assert.equal(active.status, "active");
    assert.equal(active.messageCount, 4, "two recent turns were not preserved");
    const boundaryMarkup = renderToStaticMarkup(
      createElement(ContextSegmentBoundary, { segment: sealed, onToggle: () => undefined })
    );
    assert.match(boundaryMarkup, /이전 맥락이 압축되었습니다/);
    assert.match(boundaryMarkup, /요약 보기/);
    assert.match(boundaryMarkup, /원문 6개 메시지 보기/);
    assert.equal(boundaryMarkup.includes("normal answer</article>"), false, "sealed source messages were eagerly rendered");
    assert.deepEqual(kernel.listMessages(session.id).map((message) => message.id), beforeMessages.map((message) => message.id));
    assert.deepEqual(
      kernel.listMessages(session.id).map((message) => ({ id: message.id, status: message.status, error: message.error, parts: message.parts })),
      beforeMessages.map((message) => ({ id: message.id, status: message.status, error: message.error, parts: message.parts }))
    );
    assert.deepEqual(runIds.map((runId) => kernel.listRunEvents(runId).length), beforeEvents);
    assert.ok(runIds.slice(0, 3).every((runId) => kernel.getRun(runId).segmentId === sealed.id));
    assert.ok(runIds.slice(3).every((runId) => kernel.getRun(runId).segmentId === active.id));
    assert.throws(
      () =>
        store.createMessage({
          id: "sealed-write",
          sessionId: session.id,
          segmentId: sealed.id,
          role: "user",
          status: "completed",
          createdAt: fixtureTime,
          updatedAt: fixtureTime
        }),
      (error: unknown) => (error as { code?: string }).code === "context_segment_changed"
    );
    assert.throws(
      () =>
        store.createRun({
          id: "sealed-run-write",
          sessionId: session.id,
          segmentId: sealed.id,
          expectedActiveSegmentId: sealed.id,
          provider: "fixture-provider",
          status: "running",
          createdAt: fixtureTime,
          updatedAt: fixtureTime
        }),
      (error: unknown) => (error as { code?: string }).code === "context_segment_changed"
    );
    const activeMessagesForInvariant = store.listMessagesBySegment(active.id);
    const invariantSourceIds = activeMessagesForInvariant.slice(0, 2).map((message) => message.id);
    const invariantPreservedIds = activeMessagesForInvariant.slice(2).map((message) => message.id);
    const invariantSourceRunIds = [...new Set(activeMessagesForInvariant.slice(0, 2).flatMap((message) => message.runId ? [message.runId] : []))];
    const invariantPreservedRunIds = store.listRuns({ sessionId: session.id }).filter((run) => run.segmentId === active.id && !invariantSourceRunIds.includes(run.id)).map((run) => run.id);
    const invariantArtifact = {
      ...first.artifact,
      id: "invalid-membership-artifact",
      sourceSegmentId: active.id,
      targetSegmentId: null,
      previousArtifactId: active.inheritedArtifactId,
      sourceMessageIds: invariantSourceIds,
      sourceCategories: [{ category: "completed_turn" as const, messageIds: invariantSourceIds, runId: invariantSourceRunIds[0] ?? null, status: "completed" }],
      sourceFirstMessageId: invariantSourceIds[0],
      sourceLastMessageId: invariantSourceIds.at(-1) ?? null,
      createdAt: new Date().toISOString()
    };
    assert.equal(
      store.rotateContextSegment({
        sessionId: session.id,
        expectedActiveSegmentId: active.id,
        newSegmentId: "invalid-membership-target",
        preservedMessageIds: [...invariantPreservedIds, "foreign-message-id"],
        sourceRunIds: invariantSourceRunIds,
        preservedRunIds: invariantPreservedRunIds,
        artifact: invariantArtifact,
        rotatedAt: new Date().toISOString()
      }),
      null
    );
    assert.equal(
      store.rotateContextSegment({
        sessionId: session.id,
        expectedActiveSegmentId: active.id,
        newSegmentId: "foreign-artifact-target",
        preservedMessageIds: invariantPreservedIds,
        sourceRunIds: invariantSourceRunIds,
        preservedRunIds: invariantPreservedRunIds,
        artifact: { ...invariantArtifact, id: "foreign-artifact", sessionId: "foreign-session" },
        rotatedAt: new Date().toISOString()
      }),
      null
    );
    assert.equal(
      store.rotateContextSegment({
        sessionId: session.id,
        expectedActiveSegmentId: active.id,
        newSegmentId: "duplicate-membership-target",
        preservedMessageIds: [...invariantPreservedIds, invariantPreservedIds[0]],
        sourceRunIds: invariantSourceRunIds,
        preservedRunIds: invariantPreservedRunIds,
        artifact: { ...invariantArtifact, id: "duplicate-membership-artifact" },
        rotatedAt: new Date().toISOString()
      }),
      null
    );
    assert.equal(
      store.rotateContextSegment({
        sessionId: session.id,
        expectedActiveSegmentId: active.id,
        newSegmentId: "missing-membership-target",
        preservedMessageIds: invariantPreservedIds.slice(1),
        sourceRunIds: invariantSourceRunIds,
        preservedRunIds: invariantPreservedRunIds,
        artifact: { ...invariantArtifact, id: "missing-membership-artifact" },
        rotatedAt: new Date().toISOString()
      }),
      null
    );
    const splitSourceId = activeMessagesForInvariant[0].id;
    assert.equal(
      store.rotateContextSegment({
        sessionId: session.id,
        expectedActiveSegmentId: active.id,
        newSegmentId: "split-run-target",
        preservedMessageIds: activeMessagesForInvariant.slice(1).map((message) => message.id),
        sourceRunIds: invariantSourceRunIds,
        preservedRunIds: invariantPreservedRunIds,
        artifact: {
          ...invariantArtifact,
          id: "split-run-artifact",
          sourceMessageIds: [splitSourceId],
          sourceCategories: [{ category: "completed_turn", messageIds: [splitSourceId], runId: invariantSourceRunIds[0] ?? null, status: "completed" }],
          sourceFirstMessageId: splitSourceId,
          sourceLastMessageId: splitSourceId
        },
        rotatedAt: new Date().toISOString()
      }),
      null
    );
    assert.equal(
      store.rotateContextSegment({
        sessionId: session.id,
        expectedActiveSegmentId: active.id,
        newSegmentId: "invalid-run-target",
        preservedMessageIds: invariantPreservedIds,
        sourceRunIds: invariantSourceRunIds,
        preservedRunIds: [...invariantPreservedRunIds, "foreign-run-id"],
        artifact: { ...invariantArtifact, id: "invalid-run-artifact" },
        rotatedAt: new Date().toISOString()
      }),
      null
    );
    assert.equal(
      store.rotateContextSegment({
        sessionId: session.id,
        expectedActiveSegmentId: active.id,
        newSegmentId: "invalid-artifact-target",
        preservedMessageIds: invariantPreservedIds,
        sourceRunIds: invariantSourceRunIds,
        preservedRunIds: invariantPreservedRunIds,
        artifact: { ...invariantArtifact, id: "invalid-artifact", previousArtifactId: null },
        rotatedAt: new Date().toISOString()
      }),
      null
    );

    const api = await startFixtureApi(kernel, fixtureRegistry(provider), store, dbPath);
    try {
      const segmentsResponse = await fetch(`${api.origin}/api/sessions/${session.id}/context/segments`);
      assert.equal(segmentsResponse.headers.get("cache-control"), "no-store");
      const segmentsJson = await segmentsResponse.text();
      assert.equal(segmentsJson.includes("Keep continuity."), false);
      const artifactResponse = await fetch(`${api.origin}/api/sessions/${session.id}/context/artifacts/${first.artifact.id}`);
      assert.equal(artifactResponse.headers.get("cache-control"), "no-store");
      assert.equal((await artifactResponse.json() as { summary: string }).summary, first.artifact.summary);
      const sourceResponse = await fetch(`${api.origin}/api/sessions/${session.id}/context/segments/${sealed.id}/messages`);
      assert.equal(sourceResponse.headers.get("cache-control"), "no-store");
      const sourceJson = await sourceResponse.json() as Array<{ metadata: object }>;
      assert.equal(sourceJson.length, 6);
      assert.ok(sourceJson.every((message) => Object.keys(message.metadata).length === 0));
    } finally {
      await api.close();
    }

    const preview = await kernel.previewContext(session.id, { text: "next" });
    assert.equal(preview.plan.inheritedArtifactId, first.artifact.id);
    assert.equal(preview.plan.activeSegmentId, active.id);
    assert.ok(preview.plan.included.some((item) => item.kind === "compaction_summary"));
    assert.equal(preview.context.messages.some((message) => first.artifact!.sourceMessageIds.includes(message.messageId ?? "")), false);

    kernel.updateAgentDefinition({
      id: agent.id,
      expectedRevision: agent.revision,
      contextPolicy: { automaticCompaction: false, contextWindowTokensOverride: 1_200, reservedOutputTokens: 128, safetyMarginRatio: 0 },
      updatedAt: new Date().toISOString()
    });
    await assert.rejects(
      kernel.previewContext(session.id, { text: "blocked by oversized inherited summary" }),
      (error: unknown) => (error as { code?: string }).code === "context_summary_exceeds_budget"
    );
    const runCountBeforeSummaryFailure = kernel.listRuns(session.id).length;
    await assert.rejects(
      kernel.startRun(session.id, "must request explicit summary recovery"),
      (error: unknown) => (error as { code?: string }).code === "context_summary_exceeds_budget"
    );
    assert.equal(kernel.listRuns(session.id).length, runCountBeforeSummaryFailure);
    const segmentBeforeRecovery = kernel.getSession(session.id).activeSegmentId;
    provider.mode = "empty";
    const failedRecovery = await kernel.compactSession(session.id);
    assert.equal(failedRecovery.state, "failed");
    assert.equal(kernel.getContextSegment(session.id, segmentBeforeRecovery).inheritedArtifactId, first.artifact.id);
    provider.mode = "delay";
    const recoveryInputCount = provider.compactionInputs.length;
    const losingRecovery = kernel.compactSession(session.id);
    await waitUntil(() => provider.compactionInputs.length > recoveryInputCount);
    const competitorArtifact = {
      ...first.artifact,
      id: "summary-recovery-competitor",
      targetSegmentId: segmentBeforeRecovery,
      previousArtifactId: first.artifact.id,
      sourceCategories: [
        {
          category: "summary_recovery" as const,
          messageIds: first.artifact.sourceMessageIds,
          runId: null,
          status: "completed_artifact"
        }
      ],
      strategyVersion: "continuity-summary-recovery-v1",
      createdAt: new Date().toISOString()
    };
    const competitor = store.replaceInheritedContextArtifact({
      sessionId: session.id,
      expectedActiveSegmentId: segmentBeforeRecovery,
      expectedArtifactId: first.artifact.id,
      artifact: competitorArtifact,
      updatedAt: competitorArtifact.createdAt
    });
    assert.ok(competitor);
    assert.equal((await losingRecovery).state, "failed", "losing recovery overwrote a newer inherited artifact");
    assert.equal(kernel.getContextSegment(session.id, segmentBeforeRecovery).inheritedArtifactId, competitorArtifact.id);
    provider.mode = "success";
    const recovery = await kernel.compactSession(session.id);
    assert.equal(recovery.state, "completed", recovery.message);
    assert.equal(kernel.getSession(session.id).activeSegmentId, segmentBeforeRecovery, "summary-only recovery rotated messages");
    assert.equal(recovery.artifact?.previousArtifactId, competitorArtifact.id);
    assert.equal(recovery.artifact?.sourceCategories[0]?.category, "summary_recovery");
    assert.ok((recovery.artifact?.estimatedTokensAfter ?? Infinity) < first.artifact.estimatedTokensAfter);
    assert.equal(store.getContextArtifact(first.artifact.id)?.resolvedWindowTokens, 8_192, "artifact creation-time window snapshot changed");
    assert.equal(recovery.artifact?.resolvedWindowTokens, 1_200);
    const recoveredPreview = await kernel.previewContext(session.id, { text: "recovered" });
    assert.equal(recoveredPreview.plan.inheritedArtifactId, recovery.artifact?.id);

    let runAfterCompaction = "";
    for (let turn = 6; turn <= 8; turn += 1) {
      const runId = await completedTurn(kernel, session.id, `turn-${turn}`);
      if (!runAfterCompaction) runAfterCompaction = runId;
    }
    const runPlanRecords = kernel.getRun(runAfterCompaction).metadata.contextPlanRecords as unknown as Array<{
      plan: { activeSegmentId: string; inheritedArtifactId: string };
    }>;
    assert.equal(runPlanRecords[0].plan.inheritedArtifactId, recovery.artifact?.id);
    assert.equal(runPlanRecords[0].plan.activeSegmentId, active.id);
    assert.equal(JSON.stringify(kernel.getRun(runAfterCompaction).metadata).includes(recovery.artifact!.summary), false, "artifact summary was duplicated into run metadata");
    const second = await kernel.compactSession(session.id);
    assert.equal(second.state, "completed");
    assert.equal(second.artifact?.previousArtifactId, recovery.artifact?.id);
    assert.ok(provider.compactionInputs.at(-1)?.messages.some((message) => message.content.includes(recovery.artifact!.summary)));

    await completedTurn(kernel, session.id, "turn-9");
    provider.mode = "empty";
    const activeBeforeFailure = kernel.getSession(session.id).activeSegmentId;
    const failed = await kernel.compactSession(session.id);
    assert.equal(failed.state, "failed");
    assert.equal(failed.artifact?.status, "failed");
    assert.equal(kernel.getSession(session.id).activeSegmentId, activeBeforeFailure);
    assert.equal(kernel.listContextSegments(session.id).filter((segment) => segment.status === "active").length, 1);
    assert.equal(failed.artifact?.summary, "");
    for (const mode of ["malformed", "tool", "oversized", "context-overflow", "failure"] as const) {
      provider.mode = mode;
      const before = kernel.getSession(session.id).activeSegmentId;
      const result = await kernel.compactSession(session.id);
      assert.equal(result.state, "failed");
      assert.equal(kernel.getSession(session.id).activeSegmentId, before);
      assert.equal(result.artifact?.error?.includes("abcdefghijklmnopqrstuvwxyz"), false);
    }
    provider.mode = "delay";
    const beforeConcurrent = kernel.getSession(session.id).activeSegmentId;
    const concurrentCompaction = kernel.compactSession(session.id);
    await delay(5);
    await assert.rejects(kernel.compactSession(session.id), (error: unknown) => (error as { code?: string }).code === "context_compaction_conflict");
    await completedTurn(kernel, session.id, "concurrent-new-turn");
    const lostCas = await concurrentCompaction;
    assert.equal(lostCas.state, "failed");
    assert.equal(kernel.getSession(session.id).activeSegmentId, beforeConcurrent);
    assert.ok(kernel.listActiveMessages(session.id).some((message) => message.parts.some((part) => part.text.includes("concurrent-new-turn"))));
    closeStore(store);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function automaticAndCancellationScenario(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "agent-platform-auto-compaction-"));
  const dbPath = join(directory, "auto.db");
  try {
    const provider = new CompactionProvider();
    const store = new SQLiteStore({ dbPath, defaultWorkingDirectory: directory });
    const kernel = new Kernel({ store, eventBus: new RunEventBus(), providers: fixtureRegistry(provider), tools: new ToolRegistry(), toolExecutionCwd: directory });
    const agent = kernel.createAgentDefinition({
      name: "Automatic compaction",
      systemPrompt: "Automatic fixture.",
      modelProfileId: "fixture-provider",
      contextPolicy: { automaticCompaction: true, contextWindowTokensOverride: 2_048, reservedOutputTokens: 256, safetyMarginRatio: 0 },
      toolIds: []
    });
    const session = kernel.createSession({ title: "Automatic", agentId: agent.id, workingDirectory: directory });
    let finalRunId = "";
    for (let turn = 1; turn <= 5; turn += 1) {
      finalRunId = await completedTurn(kernel, session.id, `large-${turn}-${"x".repeat(1_400)}`);
      if (kernel.listContextSegments(session.id).length > 1) {
        break;
      }
    }
    assert.ok(kernel.listContextSegments(session.id).length > 1, "automatic threshold did not rotate a segment");
    const automaticArtifact = kernel.listContextSegments(session.id).find((segment) => segment.status === "sealed")!.artifact!;
    const finalRunMessageIds = new Set(kernel.listMessages(session.id).filter((message) => message.runId === finalRunId).map((message) => message.id));
    assert.equal(automaticArtifact.sourceMessageIds.some((id) => finalRunMessageIds.has(id)), false, "in-flight run crossed the segment boundary");
    const eventTypes = kernel.listRunEvents(finalRunId).map((event) => event.type);
    assert.ok(eventTypes.includes("context_compaction_started"));
    assert.ok(eventTypes.includes("context_compaction_completed"));
    assert.ok(eventTypes.includes("segment_rotated"));
    assert.equal(JSON.stringify(kernel.listRunEvents(finalRunId)).includes("Cumulative fixture summary"), false, "summary leaked into run events");
    const completedEvent = kernel.listRunEvents(finalRunId).find((event) => event.type === "context_compaction_completed")!;
    assert.equal((completedEvent.payload as { artifactId?: string }).artifactId, automaticArtifact.id);

    provider.mode = "empty";
    const failureSession = kernel.createSession({ title: "Automatic failure", agentId: agent.id, workingDirectory: directory });
    let failureRunId = "";
    for (let turn = 1; turn <= 5; turn += 1) {
      failureRunId = await completedTurn(kernel, failureSession.id, `auto-failure-${turn}-${"y".repeat(1_400)}`);
      if (kernel.listRunEvents(failureRunId).some((event) => event.type === "context_compaction_failed")) break;
    }
    assert.equal(kernel.getRun(failureRunId).status, "completed", "compaction failure failed the main answer");
    assert.equal(kernel.listContextSegments(failureSession.id).length, 1);
    assert.ok(kernel.listRunEvents(failureRunId).some((event) => event.type === "context_compaction_failed"));
    provider.mode = "success";

    for (let turn = 6; turn <= 8; turn += 1) {
      await completedTurn(kernel, session.id, `cancel-source-${turn}`);
    }
    provider.mode = "block";
    const activeBefore = kernel.getSession(session.id).activeSegmentId;
    const compacting = kernel.compactSession(session.id);
    await delay(10);
    await kernel.shutdown(20);
    const interrupted = await compacting;
    assert.equal(interrupted.state, "failed");
    assert.equal(kernel.getSession(session.id).activeSegmentId, activeBefore);
    closeStore(store);

    const restarted = new SQLiteStore({ dbPath, defaultWorkingDirectory: directory });
    const restartedSession = restarted.getSession(session.id)!;
    assert.equal(restartedSession.activeSegmentId, activeBefore);
    assert.equal(restarted.listContextSegments(session.id).filter((segment) => segment.status === "active").length, 1);
    closeStore(restarted);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function legacyBackfillScenario(): void {
  const directory = mkdtempSync(join(tmpdir(), "agent-platform-legacy-segment-"));
  const dbPath = join(directory, "legacy.db");
  try {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, working_directory TEXT, agent_id TEXT NOT NULL DEFAULT 'main',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL
      );
    `);
    db.prepare("INSERT INTO sessions (id, title, working_directory, agent_id, created_at, updated_at) VALUES (?, ?, ?, 'main', ?, ?)")
      .run("legacy", "Legacy", directory, fixtureTime, fixtureTime);
    db.prepare("INSERT INTO runs (id, session_id, provider, status, created_at, updated_at) VALUES ('legacy-run', 'legacy', 'mock', 'completed', ?, ?)")
      .run(fixtureTime, fixtureTime);
    db.prepare("INSERT INTO messages (id, session_id, run_id, role, status, created_at, updated_at) VALUES ('legacy-message', 'legacy', 'legacy-run', 'user', 'completed', ?, ?)")
      .run(fixtureTime, fixtureTime);
    db.close();
    const store = new SQLiteStore({ dbPath, defaultWorkingDirectory: directory });
    const session = store.getSession("legacy")!;
    assert.ok(session.activeSegmentId);
    assert.deepEqual(store.listContextSegments(session.id).map((segment) => [segment.ordinal, segment.status]), [[0, "active"]]);
    assert.equal(store.getRun("legacy-run")?.segmentId, session.activeSegmentId);
    assert.equal(store.getMessage("legacy-message")?.segmentId, session.activeSegmentId);
    closeStore(store);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function waitForRunStatus(kernel: Kernel, runId: string, expected: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = kernel.getRun(runId).status;
    if (status === expected) return;
    if (["failed", "cancelled", "interrupted"].includes(status)) assert.fail(`run reached ${status}`);
    await delay(5);
  }
  assert.fail(`run ${runId} did not reach ${expected}`);
}

function createTerminalAttempt(
  store: SQLiteStore,
  sessionId: string,
  segmentId: string,
  status: "cancelled" | "interrupted",
  ordinal: number
): void {
  const timestamp = `2026-08-26T00:00:0${ordinal}.000Z`;
  const runId = `${status}-prefix-run`;
  store.createRun({ id: runId, sessionId, segmentId, provider: "fixture-provider", status: "running", createdAt: timestamp, updatedAt: timestamp });
  store.createMessage({ id: `${status}-prefix-user`, sessionId, runId, segmentId, role: "user", status: "completed", createdAt: timestamp, updatedAt: timestamp });
  store.addMessagePart({ id: `${status}-prefix-user-text`, messageId: `${status}-prefix-user`, seq: 0, text: `${status} user intent`, createdAt: timestamp, updatedAt: timestamp });
  store.createMessage({ id: `${status}-prefix-assistant`, sessionId, runId, segmentId, role: "assistant", status, metadata: { error: `${status} safely` }, createdAt: timestamp, updatedAt: timestamp });
  store.finalizeRun({
    runId,
    expectedStatuses: ["running"],
    status,
    error: `${status} safely`,
    updatedAt: timestamp,
    event: {
      id: `${status}-prefix-event`,
      type: status === "cancelled" ? "run_cancelled" : "run_interrupted",
      payload: {}
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(2);
  }
  assert.fail("timed out waiting for fixture condition");
}

function closeStore(store: SQLiteStore): void {
  (store as unknown as { db: { close: () => void } }).db.close();
}

async function startFixtureApi(kernel: Kernel, providers: ProviderRegistry, store: SQLiteStore, dbPath: string) {
  const app = express();
  app.use(express.json());
  registerApiRoutes(app, {
    dbPath,
    kernel,
    providers,
    store,
    openAIChatGPTAuth: {} as never,
    getDaemonStatus: () => ({
      status: "ok",
      version: "fixture",
      pid: process.pid,
      startedAt: fixtureTime,
      uptimeSeconds: 0,
      mode: "test",
      port: 0,
      dbPath
    }),
    getToolSettings: () => defaultToolSettings
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolvePromise) => {
    const listening = app.listen(0, "127.0.0.1", () => resolvePromise(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())))
  };
}

legacyBackfillScenario();
assert.equal(isCurrentContextUiRequest("session-a", 3, "session-a", 3), true);
assert.equal(isCurrentContextUiRequest("session-a", 3, "session-b", 4), false);
await startRunSegmentRaceScenario();
await unsuccessfulPrefixScenario();
await earlyFailureAuditScenario();
await manualAndLineageScenario();
await automaticAndCancellationScenario();
console.log("context compaction smoke test passed");
