import assert from "node:assert/strict";
import { RunType } from "@/run/type";
import Database from "better-sqlite3";
import { type ChildProcess, type spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatHeader } from "../src/client/ChatHeader";
import { RunActionButton } from "../src/client/RunActionButton";
import { shellToolStateFromResponse } from "../src/client/ToolPanels";
import {
  applyRunEventToMessages,
  isCurrentSessionOperation,
  isCurrentSessionRequest,
  isCurrentTrackedRunRequest,
  isMatchingPermissionResponse,
  prepareMessagesForRunReplay,
  runDisplayStatus,
  selectRecoveredRun,
  shouldApplyRunEvent,
  terminalNoticeFromEvent,
  terminalNoticeFromMessages,
  updateRunFromEvent
} from "../src/client/run-recovery";
import { RunEventBus } from "../src/kernel/event-bus";
import { Kernel, KernelError } from "../src/kernel/kernel";
import { RunWriter } from "../src/kernel/run-writer";
import { refreshOpenAIChatGPTCredential } from "../src/providers/openai-chatgpt-auth";
import { OpenAIChatGPTProvider } from "../src/providers/openai-chatgpt";
import type { OpenAIChatGPTCredential, OpenAIChatGPTCredentialStore } from "../src/providers/openai-chatgpt-credentials";
import type { ProviderRegistry } from "../src/providers/registry";
import type { ProviderAdapter, ProviderCredential, ProviderRunContext, ProviderRunInput, ProviderRunWriter } from "../src/providers/types";
import { DatabaseLease } from "../src/server/database-lease";
import { parsePermissionStatus } from "../src/server/request-parsers";
import { OrderedRunEventReplay, planRunEventCursor, resolveRunEventCursor, runEventCursorControl } from "../src/server/run-event-replay";
import { toolSettingsSettingKey } from "../src/shared/tool-settings";
import {
  isTerminalRunEventType,
  type JsonObject,
  type Message,
  type PublicRunSummary,
  type ProviderProfile,
  type ProviderTestResponse,
  type RunEvent,
  type ToolInvocation
} from "../src/shared/types";
import { SQLiteStore } from "../src/store/sqlite";
import { ToolRegistry } from "../src/tools/registry";
import { createShellExecTool } from "../src/tools/shell-exec";

async function providerCancellationScenario(): Promise<void> {
  const workingDirectory = mkdtempSync(join(tmpdir(), "agent-platform-provider-interrupt-"));
  try {
    const store = new SQLiteStore({ dbPath: ":memory:", defaultWorkingDirectory: workingDirectory });
    const eventBus = new RunEventBus();
    const provider = new BlockingProvider();
    const kernel = createKernel(store, eventBus, provider, new ToolRegistry(), workingDirectory);
    const session = kernel.createSession({ title: "provider cancel", workingDirectory });
    const created = await kernel.startRun(session.id, "block until cancelled");
    assert.equal("metadata" in created.run, false);
    assert.equal("baseUrl" in created.providerResolution, false);
    assert.equal("credentialRef" in created.providerResolution, false);
    await provider.started;

    const unsubscribe = kernel.subscribeRunEvents(created.run.id, () => undefined);
    unsubscribe();
    await delay(20);
    assert.equal(provider.signal?.aborted, false, "disconnecting an event subscriber must not abort the run");
    assert.equal(kernel.getRun(created.run.id).status, "running");

    const competingWriter = new RunWriter({
      store,
      eventBus,
      run: kernel.getRun(created.run.id),
      assistantMessageId: created.assistantMessageId
    });
    const lateWriter = new RunWriter({
      store,
      eventBus,
      run: kernel.getRun(created.run.id),
      assistantMessageId: created.assistantMessageId
    });
    const cancelling = kernel.cancelRun(created.run.id);
    assert.ok(cancelling.status === "cancelling" || cancelling.status === "cancelled");
    competingWriter.complete();
    assert.equal(kernel.getRun(created.run.id).status, "cancelling", "completion overwrote a cancellation CAS winner");
    await waitForRunStatus(kernel, created.run.id, "cancelled");
    assert.equal(
      store
        .getMessage(created.assistantMessageId)
        ?.parts.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .includes("late-before-terminal"),
      false,
      "provider output was persisted after cancellation started"
    );

    const beforeLateWrite = store.getMessage(created.assistantMessageId);
    lateWriter.writeDelta("must-not-be-written-after-terminal");
    lateWriter.complete();
    assert.deepEqual(store.getMessage(created.assistantMessageId), beforeLateWrite, "a losing writer mutated a terminal message");
    assert.deepEqual(terminalEventTypes(kernel, created.run.id), ["run_cancelled"]);
    const cancellationEventTypes = kernel.listRunEvents(created.run.id).map((event) => event.type);
    assert.ok(cancellationEventTypes.includes("run_cancelling"));
    assert.ok(cancellationEventTypes.indexOf("run_cancelling") < cancellationEventTypes.indexOf("run_cancelled"));
    assert.equal(kernel.cancelRun(created.run.id).status, "cancelled");
    assert.deepEqual(terminalEventTypes(kernel, created.run.id), ["run_cancelled"], "terminal cancel was not idempotent");

    const queued = await kernel.startRun(session.id, "cancel before queued provider execution");
    assert.equal(kernel.cancelRun(queued.run.id).status, "cancelled");
    await delay(0);
    assert.equal(provider.runs, 1, "provider started after the queued run was already cancelled");
    assert.deepEqual(terminalEventTypes(kernel, queued.run.id), ["run_cancelled"]);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

async function restartAndPermissionScenario(): Promise<void> {
  const workingDirectory = mkdtempSync(join(tmpdir(), "agent-platform-restart-interrupt-"));
  try {
    const dbPath = join(workingDirectory, "restart.db");
    const store = new SQLiteStore({ dbPath, defaultWorkingDirectory: workingDirectory });
    const leaseNow = Date.parse(timestamp(20));
    const ownerLease = new DatabaseLease({
      store,
      ownerId: "fixture-owner-live",
      pid: 101,
      ttlMs: 100,
      now: () => leaseNow,
      isProcessAlive: () => true
    });
    assert.equal(ownerLease.acquire().acquired, true);
    const session = store.createSession({
      id: randomUUID(),
      title: "restart reconciliation",
      workingDirectory,
      createdAt: timestamp(0),
      updatedAt: timestamp(0)
    });
    const runningSession = createStoredSession(store, workingDirectory, "restart-running", 1);
    const cancellingSession = createStoredSession(store, workingDirectory, "restart-cancelling", 2);
    const noMessageSession = createStoredSession(store, workingDirectory, "restart-no-message", 3);
    const legacyTerminalSession = createStoredSession(store, workingDirectory, "restart-legacy-terminal", 4);
    const running = createStoredRun(store, runningSession.id, "running", true, 1);
    const cancelling = createStoredRun(store, cancellingSession.id, "running", true, 2);
    assert.ok(
      store.requestRunCancellation({
        runId: cancelling.runId,
        updatedAt: timestamp(3),
        event: { id: randomUUID(), type: "run_cancelling", payload: { status: "cancelling" } }
      })
    );
    const noMessage = createStoredRun(store, noMessageSession.id, "running", false, 4);
    const waiting = createStoredRun(store, session.id, "running", true, 5);
    const pending = createPendingPermissionFixture(store, session.id, waiting, workingDirectory, "waiting", 6);
    assert.ok(
      store.transitionRunStatus(waiting.runId, ["waiting_permission"], "running", null, timestamp(9)),
      "legacy pending-permission fixture did not enter running state"
    );

    const legacyTerminal = createStoredRun(store, legacyTerminalSession.id, "running", true, 10);
    const legacyTerminalPending = createPendingPermissionFixture(
      store,
      legacyTerminalSession.id,
      legacyTerminal,
      workingDirectory,
      "legacy-terminal",
      11
    );
    writeLegacyTerminalRunFixture(dbPath, legacyTerminal.runId, timestamp(14));

    const competitorStore = new SQLiteStore({ dbPath, defaultWorkingDirectory: workingDirectory });
    const competitorKernel = createKernel(competitorStore, new RunEventBus(), new BlockingProvider(), new ToolRegistry(), workingDirectory);
    const competitorLease = new DatabaseLease({
      store: competitorStore,
      ownerId: "fixture-owner-competitor",
      pid: 202,
      ttlMs: 100,
      now: () => leaseNow + 10,
      isProcessAlive: () => true
    });
    assert.deepEqual(competitorLease.acquire().acquired, false, "second live database owner unexpectedly acquired the lease");
    assert.equal(competitorKernel.getRun(running.runId).status, "running", "Kernel construction interrupted a live owner's run");
    assert.equal(competitorKernel.getRun(cancelling.runId).status, "cancelling", "Kernel construction changed a live cancellation");

    const restartedStore = new SQLiteStore({ dbPath, defaultWorkingDirectory: workingDirectory });
    const takeoverLease = new DatabaseLease({
      store: restartedStore,
      ownerId: "fixture-owner-takeover",
      pid: 303,
      ttlMs: 100,
      now: () => leaseNow + 1_000,
      isProcessAlive: () => false
    });
    const takeover = takeoverLease.acquire();
    assert.equal(takeover.acquired, true);
    assert.equal(takeover.acquired && takeover.tookOverStaleLease, true);
    assert.equal(ownerLease.heartbeat(), false, "stale owner retained heartbeat authority after takeover");

    const kernel = createKernel(restartedStore, new RunEventBus(), new BlockingProvider(), new ToolRegistry(), workingDirectory);
    kernel.reconcileStartupState();
    for (const staleRunId of [running.runId, cancelling.runId, noMessage.runId]) {
      assert.equal(kernel.getRun(staleRunId).status, "interrupted");
      assert.deepEqual(terminalEventTypes(kernel, staleRunId), ["run_interrupted"]);
    }
    assert.equal(restartedStore.getMessage(running.messageId!)?.status, "interrupted");
    assert.equal(restartedStore.getMessage(cancelling.messageId!)?.status, "interrupted");
    assert.equal(kernel.getRun(waiting.runId).status, "waiting_permission");
    assert.equal(restartedStore.getPermissionRequest(pending.id)?.status, "pending");
    assert.equal(kernel.getRun(legacyTerminal.runId).status, "cancelled");
    assert.equal(restartedStore.getPermissionRequest(legacyTerminalPending.id)?.status, "expired");
    assert.equal(
      restartedStore.getMessage(legacyTerminal.messageId!)?.parts.find((part) => part.id === legacyTerminalPending.toolCallPartId)?.content.status,
      "cancelled"
    );
    assert.deepEqual(kernel.listRuns(session.id, true).map((run) => run.id), [waiting.runId]);
    await kernel.shutdown(10);
    assert.equal(kernel.getRun(waiting.runId).status, "waiting_permission", "shutdown did not preserve a waiting permission run");
    assert.equal(restartedStore.getPermissionRequest(pending.id)?.status, "pending", "shutdown expired a preserved permission");
    assert.equal(takeoverLease.release(), true);

    const secondRestartStore = new SQLiteStore({ dbPath, defaultWorkingDirectory: workingDirectory });
    const secondRestartLease = new DatabaseLease({ store: secondRestartStore, ownerId: "fixture-owner-second-restart", pid: 404 });
    assert.equal(secondRestartLease.acquire().acquired, true);
    const restartedKernel = createKernel(secondRestartStore, new RunEventBus(), new BlockingProvider(), new ToolRegistry(), workingDirectory);
    restartedKernel.reconcileStartupState();
    assert.equal(restartedKernel.cancelRun(waiting.runId).status, "cancelled");
    assert.equal(secondRestartStore.getPermissionRequest(pending.id)?.status, "expired");
    assert.equal(secondRestartStore.getMessage(waiting.messageId!)?.status, "cancelled");
    assert.deepEqual(terminalEventTypes(restartedKernel, waiting.runId), ["run_cancelled"]);
    await assert.rejects(
      restartedKernel.approvePermissionRequest(pending.id),
      (error: unknown) => error instanceof KernelError && error.statusCode === 409
    );
    assert.equal(secondRestartLease.release(), true);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

async function boundedShutdownScenario(): Promise<void> {
  const workingDirectory = mkdtempSync(join(tmpdir(), "agent-platform-shutdown-interrupt-"));
  const provider = new NonCooperativeProvider();
  try {
    const store = new SQLiteStore({ dbPath: ":memory:", defaultWorkingDirectory: workingDirectory });
    const eventBus = new RunEventBus();
    const kernel = createKernel(store, eventBus, provider, new ToolRegistry(), workingDirectory);
    const session = kernel.createSession({ title: "bounded shutdown", workingDirectory });
    const created = await kernel.startRun(session.id, "ignore abort until fixture release");
    await provider.started;

    await kernel.shutdown(25);
    assert.equal(kernel.getRun(created.run.id).status, "interrupted");
    assert.deepEqual(terminalEventTypes(kernel, created.run.id), ["run_interrupted"]);
    const terminalMessage = store.getMessage(created.assistantMessageId);

    provider.finish();
    await provider.finished;
    await delay(10);
    assert.deepEqual(store.getMessage(created.assistantMessageId), terminalMessage, "late provider output mutated an interrupted message");
    assert.deepEqual(terminalEventTypes(kernel, created.run.id), ["run_interrupted"]);

    const cooperativeProvider = new NonCooperativeProvider();
    const cooperativeStore = new SQLiteStore({ dbPath: ":memory:", defaultWorkingDirectory: workingDirectory });
    const cooperativeKernel = createKernel(
      cooperativeStore,
      new RunEventBus(),
      cooperativeProvider,
      new ToolRegistry(),
      workingDirectory
    );
    const cooperativeSession = cooperativeKernel.createSession({ title: "shutdown grace", workingDirectory });
    const cooperativeRun = await cooperativeKernel.startRun(cooperativeSession.id, "finish during shutdown grace");
    await cooperativeProvider.started;
    const cooperativeShutdown = cooperativeKernel.shutdown(1_000);
    cooperativeProvider.finish();
    await cooperativeShutdown;
    assert.equal(cooperativeKernel.getRun(cooperativeRun.run.id).status, "interrupted");
    assert.equal(
      cooperativeStore
        .getMessage(cooperativeRun.assistantMessageId)
        ?.parts.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .includes("after-terminal"),
      false,
      "provider output was persisted after the shutdown signal"
    );
  } finally {
    provider.finish();
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

async function genericToolTerminationScenario(): Promise<void> {
  for (const explicitCancel of [false, true]) {
    const workingDirectory = mkdtempSync(join(tmpdir(), `agent-platform-generic-tool-${explicitCancel ? "cancel" : "shutdown"}-`));
    try {
      const store = new SQLiteStore({ dbPath: ":memory:", defaultWorkingDirectory: workingDirectory });
      const tools = new ToolRegistry();
      const started = deferred<void>();
      const release = deferred<void>();
      tools.register({
        definition: {
          id: "shell.exec",
          name: "Resolve after abort",
          description: "Generic cancellation fixture",
          source: "custom",
          inputSchema: {},
          outputSchema: {},
          metadata: {}
        },
        executor: {
          async execute() {
            started.resolve();
            await release.promise;
            return { completedSentinel: true };
          }
        }
      });
      const kernel = createKernel(store, new RunEventBus(), new BlockingProvider(), tools, workingDirectory);
      store.setSetting(toolSettingsSettingKey, allowToolSettings(), new Date().toISOString());
      const session = kernel.createSession({ title: "generic tool abort", workingDirectory });
      const invocationPromise = kernel.invokeTool(session.id, "shell.exec", { command: "fixture resolve after abort" });
      await started.promise;
      const runId = await waitForActiveRunId(kernel, session.id);
      if (explicitCancel) {
        kernel.cancelRun(runId);
      }
      const shutdownPromise = kernel.shutdown(explicitCancel ? 1_000 : 25);
      if (!explicitCancel) {
        await shutdownPromise;
        const terminalMessage = store.listMessages(session.id).find((message) => message.runId === runId && message.role === "assistant");
        const terminalToolCall = terminalMessage?.parts.find((part) => part.type === "tool_call");
        assert.equal(terminalToolCall?.content.status, "cancelled", "bounded shutdown left a terminal tool call active");
      }
      release.resolve();
      const response = await invocationPromise;
      await shutdownPromise;

      const expectedStatus = explicitCancel ? "cancelled" : "interrupted";
      assert.equal(response.result?.status, "cancelled", "abort-following tool resolve was recorded as completed");
      assert.ok(response.result);
      assert.equal("metadata" in response.result, false);
      assert.equal(kernel.getRun(runId).status, expectedStatus);
      assert.equal(kernel.listRunEvents(runId).some((event) => event.type === "tool.completed"), false);
      assert.deepEqual(terminalEventTypes(kernel, runId), [explicitCancel ? "run_cancelled" : "run_interrupted"]);
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  }
}

async function asynchronousManualToolCancellationScenario(): Promise<void> {
  const workingDirectory = mkdtempSync(join(tmpdir(), "agent-platform-async-manual-tool-"));
  try {
    const store = new SQLiteStore({ dbPath: ":memory:", defaultWorkingDirectory: workingDirectory });
    const eventBus = new RunEventBus();
    const tools = new ToolRegistry();
    const started = deferred<void>();
    tools.register({
      definition: {
        id: "shell.exec",
        name: "Async Manual Fixture",
        description: "Waits for cancellation after the HTTP-style start response.",
        source: "custom",
        inputSchema: {},
        outputSchema: {},
        metadata: {}
      },
      executor: {
        toPublicInput() {
          return { command: "[REDACTED]" };
        },
        async execute(_input, context) {
          started.resolve();
          await new Promise<void>((resolvePromise) => {
            if (context.signal.aborted) {
              resolvePromise();
              return;
            }
            context.signal.addEventListener("abort", () => resolvePromise(), { once: true });
          });
          return { resolvedAfterAbort: true };
        }
      }
    });
    const kernel = createKernel(store, eventBus, new BlockingProvider(), tools, workingDirectory);
    store.setSetting(toolSettingsSettingKey, allowToolSettings(), new Date().toISOString());
    const session = kernel.createSession({ title: "async manual tool", workingDirectory });

    const startedAt = Date.now();
    const response = kernel.startToolInvocation(session.id, "shell.exec", {
      command: "fixture async manual INTERNAL_INPUT_SENTINEL"
    });
    assert.equal(response.state, "running");
    assert.equal(shellToolStateFromResponse(response), "running");
    assert.equal(response.run.status, "running");
    assert.equal(response.result, undefined);
    assert.equal("metadata" in response.run, false);
    assert.equal("input" in response.invocation, false);
    assert.equal("metadata" in response.invocation, false);
    const serializedResponse = JSON.stringify(response);
    assert.equal(serializedResponse.includes("INTERNAL_INPUT_SENTINEL"), false);
    assert.equal(serializedResponse.includes("[REDACTED]"), true, "sanitized display command was removed from the tool timeline");
    assert.ok(Date.now() - startedAt < 250, "manual tool start waited for execution completion");

    await started.promise;
    const cancelling = kernel.cancelRun(response.run.id);
    assert.ok(cancelling.status === "cancelling" || cancelling.status === "cancelled");
    await waitForRunStatus(kernel, response.run.id, "cancelled");
    const terminalMessage = kernel.listMessages(session.id).find((message) => message.runId === response.run.id);
    assert.equal(terminalMessage?.status, "cancelled");
    assert.ok(
      terminalMessage?.parts.some((part) => part.type === "tool_result" && part.content.status === "cancelled"),
      "async manual cancellation omitted the cancelled tool result"
    );
    const eventTypes = kernel.listRunEvents(response.run.id).map((event) => event.type);
    assert.ok(eventTypes.includes("run_cancelling"));
    assert.ok(eventTypes.includes("tool.failed"));
    assert.equal(eventTypes.includes("tool.completed"), false);
    assert.deepEqual(terminalEventTypes(kernel, response.run.id), ["run_cancelled"]);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

async function manualToolDenyCompatibilityScenario(): Promise<void> {
  const workingDirectory = mkdtempSync(join(tmpdir(), "agent-platform-manual-deny-"));
  try {
    const store = new SQLiteStore({ dbPath: ":memory:", defaultWorkingDirectory: workingDirectory });
    const tools = new ToolRegistry();
    let executions = 0;
    tools.register({
      definition: {
        id: "shell.exec",
        name: "Denied Shell Fixture",
        description: "Must not execute under the deny policy.",
        source: "custom",
        inputSchema: {},
        outputSchema: {},
        metadata: {}
      },
      executor: {
        async execute() {
          executions += 1;
          return {};
        }
      }
    });
    const kernel = createKernel(store, new RunEventBus(), new BlockingProvider(), tools, workingDirectory);
    store.setSetting(toolSettingsSettingKey, denyToolSettings(), new Date().toISOString());

    const syncSession = kernel.createSession({ title: "sync deny", workingDirectory });
    const syncResponse = await kernel.invokeTool(syncSession.id, "shell.exec", { command: "fixture denied sync" });
    assert.equal(syncResponse.state, "denied");
    assert.equal(syncResponse.run.status, "failed");

    const asyncSession = kernel.createSession({ title: "async deny", workingDirectory });
    const asyncResponse = kernel.startToolInvocation(asyncSession.id, "shell.exec", { command: "fixture denied async" });
    assert.equal(asyncResponse.state, "denied");
    assert.equal(asyncResponse.run.status, "failed");
    assert.equal(executions, 0, "denied sync/async manual invocations executed their tool");
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

async function waitingCancelRegistryScenario(): Promise<void> {
  const workingDirectory = mkdtempSync(join(tmpdir(), "agent-platform-waiting-registry-"));
  try {
    const store = new SQLiteStore({ dbPath: ":memory:", defaultWorkingDirectory: workingDirectory });
    const tools = new ToolRegistry();
    tools.register({
      definition: {
        id: "fixture.permission",
        name: "Permission fixture",
        description: "Waiting cancellation fixture",
        source: "custom",
        inputSchema: {},
        outputSchema: {},
        metadata: {}
      },
      executor: { execute: async () => ({ shouldNotRun: true }) }
    });
    const kernel = createKernel(store, new RunEventBus(), new BlockingProvider(), tools, workingDirectory);
    store.setSetting(toolSettingsSettingKey, askToolSettings(), new Date().toISOString());
    const session = kernel.createSession({ title: "waiting registry", workingDirectory });
    const response = await kernel.invokeTool(session.id, "fixture.permission", {});
    assert.equal(response.run.status, "waiting_permission");
    assert.equal("metadata" in response.run, false);
    assert.ok(response.permissionRequest);
    assert.equal(
      isMatchingPermissionResponse(response.permissionRequest, response, response.run.id, response.run.id),
      true
    );
    assert.equal(
      isMatchingPermissionResponse(response.permissionRequest, response, "newer-run", response.run.id),
      false,
      "an older permission response matched a newer tracked run"
    );
    assert.equal(
      isMatchingPermissionResponse(
        response.permissionRequest,
        { ...response, invocation: { ...response.invocation, id: "different-invocation" } },
        response.run.id,
        response.run.id
      ),
      false,
      "a mismatched permission invocation passed the response guard"
    );
    const waitingEvents = kernel.listRunEvents(response.run.id);
    const waitingSnapshotEvent = [...waitingEvents].reverse().find((event) => event.type === "assistant_message_updated");
    const waitingSnapshot = (waitingSnapshotEvent?.payload as { message?: Message } | undefined)?.message;
    assert.ok(waitingSnapshot, "waiting permission did not emit a canonical assistant message snapshot");
    assert.equal("usage" in waitingSnapshot, true);
    const storedWaitingSnapshot = [...store.listEvents(response.run.id)]
      .reverse()
      .find((event) => event.type === "assistant_message_updated")?.payload as { message?: Message } | undefined;
    assert.equal(storedWaitingSnapshot?.message?.metadata.pendingPermissionRequestId, response.permissionRequest?.id);
    assert.equal(
      waitingSnapshot.parts.find((part) => part.id === response.toolCallPartId)?.content.status,
      "pending_permission"
    );
    assert.equal(response.commandOutputPartId, undefined, "non-shell tools must not synthesize a command output part");
    assert.equal(waitingSnapshot.parts.some((part) => part.type === "command_output"), false);
    let replayedWaitingMessages: Message[] = [];
    for (const event of waitingEvents) {
      replayedWaitingMessages = applyRunEventToMessages(replayedWaitingMessages, event);
    }
    assert.deepEqual(
      replayedWaitingMessages.find((message) => message.id === response.message.id),
      waitingSnapshot,
      "event replay did not reconstruct the canonical waiting message"
    );
    assert.equal(
      updateRunFromEvent(response.run, waitingSnapshotEvent!).status,
      "waiting_permission",
      "a waiting message snapshot incorrectly resumed the public run"
    );
    const executions = (kernel as unknown as { executions: Map<string, unknown> }).executions;
    assert.equal(executions.has(response.run.id), true);
    assert.equal(kernel.cancelRun(response.run.id).status, "cancelled");
    assert.equal(executions.has(response.run.id), false, "waiting cancellation leaked its execution registry entry");
    assert.equal(store.getPermissionRequest(response.permissionRequest!.id)?.status, "expired");
    assert.equal(store.getMessage(response.message.id)?.parts.find((part) => part.id === response.toolCallPartId)?.content.status, "cancelled");

    const asyncSession = kernel.createSession({ title: "waiting registry async", workingDirectory });
    const asyncResponse = kernel.startToolInvocation(asyncSession.id, "fixture.permission", {});
    assert.equal(asyncResponse.state, "pending_permission");
    assert.equal(asyncResponse.run.status, "waiting_permission");
    assert.equal(kernel.cancelRun(asyncResponse.run.id).status, "cancelled");
    assert.equal(store.getPermissionRequest(asyncResponse.permissionRequest!.id)?.status, "expired");
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

async function publicRunProjectionAndStoreInvariantScenario(): Promise<void> {
  const workingDirectory = mkdtempSync(join(tmpdir(), "agent-platform-public-run-"));
  try {
    const store = new SQLiteStore({ dbPath: ":memory:", defaultWorkingDirectory: workingDirectory });
    const kernel = createKernel(store, new RunEventBus(), new BlockingProvider(), new ToolRegistry(), workingDirectory);
    const session = kernel.createSession({ title: "public run", workingDirectory });
    const now = new Date().toISOString();
    const run = store.createRun({
      id: randomUUID(),
      sessionId: session.id,
      provider: "fixture-provider",
      status: "running",
      createdAt: now,
      updatedAt: now,
      error: "Authorization: Bearer public-run-secret-token",
      metadata: {
        model: "safe-model",
        runOptions: { model: "safe-model", reasoningEffort: "safe-effort" },
        contextSnapshot: { systemPrompt: "PRIVATE_CONTEXT_SENTINEL" },
        input: { command: "SECRET_COMMAND_SENTINEL" },
        credential: "SECRET_CREDENTIAL_SENTINEL"
      }
    });
    const summary = kernel.getPublicRun(run.id);
    const serialized = JSON.stringify(summary);
    assert.equal("metadata" in summary, false);
    assert.equal(summary.model, "safe-model");
    assert.equal(serialized.includes("PRIVATE_CONTEXT_SENTINEL"), false);
    assert.equal(serialized.includes("SECRET_COMMAND_SENTINEL"), false);
    assert.equal(serialized.includes("SECRET_CREDENTIAL_SENTINEL"), false);
    assert.equal(serialized.includes("public-run-secret-token"), false);
    assert.match(summary.error ?? "", /\[REDACTED\]/);
    assert.deepEqual(kernel.listPublicRuns(session.id, true), [summary]);

    const internalStartedEvent = store.appendEvent({
      id: randomUUID(),
      runId: run.id,
      sessionId: session.id,
      type: "run_started",
      createdAt: now,
      payload: {
        runId: run.id,
        sessionId: session.id,
        provider: "fixture-provider",
        providerResolution: {
          requestedProvider: null,
          requestedProviderProfileId: null,
          providerProfileId: "fixture-provider",
          providerProfileName: "Fixture",
          providerType: "mock",
          baseUrl: "PRIVATE_BASE_URL_SENTINEL",
          credentialRef: "PRIVATE_CREDENTIAL_REF_SENTINEL",
          fallback: null
        },
        context: { systemPrompt: "PRIVATE_EVENT_CONTEXT_SENTINEL" },
        agent: { systemPrompt: "PRIVATE_EVENT_AGENT_SENTINEL" }
      }
    });
    const internalMessage = messageFixture(randomUUID(), run.id, "safe public text");
    internalMessage.sessionId = session.id;
    internalMessage.error = "Authorization: Bearer PRIVATE_MESSAGE_ERROR_TOKEN";
    internalMessage.metadata = { context: "PRIVATE_MESSAGE_METADATA_SENTINEL" };
    internalMessage.parts[0].metadata = { credential: "PRIVATE_PART_METADATA_SENTINEL" };
    const internalMessageEvent = store.appendEvent({
      id: randomUUID(),
      runId: run.id,
      sessionId: session.id,
      type: "assistant_message_updated",
      createdAt: now,
      payload: { message: internalMessage }
    });
    const publicEvents = kernel.listRunEvents(run.id);
    const serializedEvents = JSON.stringify(publicEvents);
    for (const sentinel of [
      "PRIVATE_BASE_URL_SENTINEL",
      "PRIVATE_CREDENTIAL_REF_SENTINEL",
      "PRIVATE_EVENT_CONTEXT_SENTINEL",
      "PRIVATE_EVENT_AGENT_SENTINEL",
      "PRIVATE_MESSAGE_METADATA_SENTINEL",
      "PRIVATE_PART_METADATA_SENTINEL",
      "PRIVATE_MESSAGE_ERROR_TOKEN"
    ]) {
      assert.equal(serializedEvents.includes(sentinel), false, `public event replay exposed ${sentinel}`);
    }
    assert.deepEqual(store.listEvents(run.id, internalStartedEvent.seq).map((event) => event.id), [internalMessageEvent.id]);
    assert.equal(store.getLatestEventSeq(run.id), internalMessageEvent.seq);

    assert.throws(
      () =>
        store.appendEvent({
          id: randomUUID(),
          runId: run.id,
          sessionId: session.id,
          type: "run_completed",
          createdAt: now,
          payload: {}
        }),
      /finalizeRun/
    );
    assert.equal(store.listEvents(run.id).length, 2);
    assert.throws(
      () => store.transitionRunStatus(run.id, ["running"], "completed" as never, null, now),
      /must be written through finalizeRun/
    );
    kernel.cancelRun(run.id);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

function usageSnapshotReplayScenario(): void {
  const workingDirectory = mkdtempSync(join(tmpdir(), "agent-platform-usage-snapshot-"));
  try {
    const store = new SQLiteStore({ dbPath: ":memory:", defaultWorkingDirectory: workingDirectory });
    const eventBus = new RunEventBus();
    const kernel = createKernel(store, eventBus, new BlockingProvider(), new ToolRegistry(), workingDirectory);
    const session = kernel.createSession({ title: "usage snapshot", workingDirectory });
    const now = new Date().toISOString();
    const run = store.createRun({
      id: randomUUID(),
      sessionId: session.id,
      provider: "fixture-provider",
      status: "running",
      metadata: {},
      createdAt: now,
      updatedAt: now
    });
    const message = store.createMessage({
      id: randomUUID(),
      sessionId: session.id,
      runId: run.id,
      role: "assistant",
      status: "streaming",
      metadata: {},
      createdAt: now,
      updatedAt: now
    });
    store.appendEvent({
      id: randomUUID(),
      runId: run.id,
      sessionId: session.id,
      type: "assistant_message_created",
      createdAt: now,
      payload: { message }
    });
    const usage = { inputTokens: 13, outputTokens: 8, reasoningTokens: 3, totalTokens: 21 };
    const writer = new RunWriter({ store, eventBus, run, assistantMessageId: message.id });
    writer.writeUsage(usage);
    assert.equal(writer.completeMessage()?.status, "completed");
    assert.equal(kernel.getRun(run.id).status, "running", "message completion terminated its run");
    assert.equal(kernel.listRunEvents(run.id).some((event) => isTerminalRunEventType(event.type)), false);
    new RunWriter({ store, eventBus, run: kernel.getRun(run.id), assistantMessageId: message.id }).complete();

    const events = kernel.listRunEvents(run.id);
    const update = events.find((event) => event.type === "assistant_message_updated");
    const terminal = events.find((event) => event.type === "run_completed");
    assert.deepEqual((update?.payload as { message?: Message }).message?.usage, usage);
    assert.deepEqual((terminal?.payload as { usage?: unknown }).usage, usage);
    assert.deepEqual(kernel.getPublicRun(run.id).usage, usage);
    let replayed: Message[] = [];
    for (const event of events) {
      replayed = applyRunEventToMessages(replayed, event);
    }
    assert.deepEqual(replayed.find((item) => item.id === message.id)?.usage, usage);
    assert.equal(replayed.find((item) => item.id === message.id)?.status, "completed");
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

async function approvedPermissionPreparationFailureScenario(): Promise<void> {
  const workingDirectory = mkdtempSync(join(tmpdir(), "agent-platform-permission-restore-failure-"));
  try {
    const store = new SQLiteStore({ dbPath: ":memory:", defaultWorkingDirectory: workingDirectory });
    const kernel = createKernel(store, new RunEventBus(), new BlockingProvider(), new ToolRegistry(), workingDirectory);
    const session = kernel.createSession({ title: "permission restore failure", workingDirectory });
    const run = createStoredRun(store, session.id, "running", true, 1);
    const permission = createPendingPermissionFixture(
      store,
      session.id,
      run,
      workingDirectory,
      "missing-tool",
      2,
      "fixture.missing-tool"
    );

    await assert.rejects(kernel.approvePermissionRequest(permission.id), (error: unknown) => error instanceof KernelError && error.statusCode === 404);
    assert.equal(store.getPermissionRequest(permission.id)?.status, "approved");
    assert.equal(kernel.getRun(run.runId).status, "failed", "resolved permission restoration failure left the run active");
    assert.deepEqual(terminalEventTypes(kernel, run.runId), ["run_failed"]);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

async function singleActiveRunInvariantScenario(): Promise<void> {
  const workingDirectory = mkdtempSync(join(tmpdir(), "agent-platform-single-active-"));
  try {
    const store = new SQLiteStore({ dbPath: ":memory:", defaultWorkingDirectory: workingDirectory });
    const provider = new BlockingProvider();
    const kernel = createKernel(store, new RunEventBus(), provider, new ToolRegistry(), workingDirectory);
    const session = kernel.createSession({ title: "single active", workingDirectory });
    const first = await kernel.startRun(session.id, "first active run");
    await provider.started;

    let conflict: unknown;
    try {
      await kernel.startRun(session.id, "must be rejected");
    } catch (error) {
      conflict = error;
    }
    assert.ok(conflict instanceof KernelError);
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.code, "active_run_exists");
    const publicConflict = conflict.details?.run as PublicRunSummary | undefined;
    assert.equal(publicConflict?.id, first.run.id);
    assert.equal(JSON.stringify(publicConflict).includes("metadata"), false);
    assert.deepEqual(kernel.listPublicRuns(session.id, true).map((run) => run.id), [first.run.id]);
    assert.equal(kernel.listMessages(session.id).filter((message) => message.runId !== first.run.id).length, 0);

    kernel.cancelRun(first.run.id);
    await waitForRunStatus(kernel, first.run.id, "cancelled");
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

function runRecoveryAndReplayScenario(): void {
  const older = publicRunFixture("run-older", "running", timestamp(1));
  const latest = publicRunFixture("run-latest", "waiting_permission", timestamp(2));
  const selection = selectRecoveredRun([older, latest]);
  assert.equal(selection.run?.id, latest.id);
  assert.match(selection.warning ?? "", /2 active runs/);
  assert.equal(JSON.stringify(selection.run).includes("metadata"), false);
  assert.equal(isCurrentSessionRequest("session-a", 4, "session-a", 4), true);
  assert.equal(isCurrentSessionOperation("session-a", 4, 9, "session-a", 4, 9), true);
  assert.equal(
    isCurrentSessionOperation("session-a", 4, 10, "session-a", 4, 9),
    false,
    "an older same-session request passed the request identity guard"
  );
  assert.equal(isCurrentSessionRequest("session-b", 5, "session-a", 4), false);
  assert.equal(
    isCurrentSessionRequest("session-a", 6, "session-a", 4),
    false,
    "a response from before an away-and-back session switch passed the generation guard"
  );
  assert.equal(isCurrentTrackedRunRequest("session-a", 4, "run-a", "session-a", 4, "run-a"), true);
  assert.equal(
    isCurrentTrackedRunRequest("session-a", 4, null, "session-a", 4, "run-a"),
    false,
    "a cancel response won after terminal SSE detached its tracked run"
  );
  assert.equal(
    isCurrentTrackedRunRequest("session-a", 4, "run-b", "session-a", 4, "run-a"),
    false,
    "a stale cancel response replaced a newly recovered run"
  );

  const waitingDisplay = runDisplayStatus(latest, "connected", null);
  assert.equal(waitingDisplay.label, "waiting for approval");
  const reconnectingDisplay = runDisplayStatus({ ...latest, status: "running" }, "reconnecting", null);
  assert.equal(reconnectingDisplay.label, "reconnecting");
  const cancellingDisplay = runDisplayStatus({ ...latest, status: "cancelling" }, "connected", null);
  assert.equal(cancellingDisplay.label, "cancelling");
  assert.equal(
    updateRunFromEvent(older, runEventFixture(1, "run_cancelling", { status: "cancelling" }, older.id)).status,
    "cancelling"
  );

  const activeMessage = messageFixture("assistant-active", latest.id, "Hello");
  const priorMessage = messageFixture("assistant-prior", "run-prior", "Earlier");
  let messages = prepareMessagesForRunReplay([priorMessage, activeMessage], latest.id);
  assert.deepEqual(messages.map((message) => message.id), [priorMessage.id]);

  const replayEvents: RunEvent[] = [
    runEventFixture(1, "assistant_message_created", { message: messageFixture(activeMessage.id, latest.id, "") }, latest.id),
    runEventFixture(2, "delta", { messageId: activeMessage.id, text: "Hel" }, latest.id),
    runEventFixture(3, "delta", { messageId: activeMessage.id, text: "lo" }, latest.id)
  ];
  let cursor = 0;
  for (const event of [...replayEvents, replayEvents[2]]) {
    if (!shouldApplyRunEvent(cursor, latest.id, event)) {
      continue;
    }
    cursor = event.seq;
    messages = applyRunEventToMessages(messages, event);
  }
  assert.equal(messageText(messages.find((message) => message.id === activeMessage.id)), "Hello");
  assert.equal(cursor, 3, "duplicate reconnect event advanced the cursor");

  const replayedMessage = messages.find((message) => message.id === activeMessage.id)!;
  const reasoningPart = {
    id: `${activeMessage.id}:reasoning`,
    messageId: activeMessage.id,
    seq: 1,
    type: "reasoning_summary" as const,
    text: "Safe summary",
    content: { summary: "Safe summary" },
    metadata: {},
    createdAt: timestamp(4),
    updatedAt: timestamp(4)
  };
  let structuredMessages = applyRunEventToMessages(
    messages,
    runEventFixture(4, "assistant_message_updated", { message: { ...replayedMessage, parts: [...replayedMessage.parts, reasoningPart] } }, latest.id)
  );
  const toolCallPart = {
    id: `${activeMessage.id}:tool`,
    messageId: activeMessage.id,
    seq: 2,
    type: "tool_call" as const,
    text: "Tool call",
    content: { callId: "call", toolId: "shell.exec", status: "running" },
    metadata: {},
    createdAt: timestamp(5),
    updatedAt: timestamp(5)
  };
  structuredMessages = applyRunEventToMessages(
    structuredMessages,
    runEventFixture(5, "tool_call.created", { messageId: activeMessage.id, part: toolCallPart }, latest.id)
  );
  const structuredParts = structuredMessages.find((message) => message.id === activeMessage.id)?.parts ?? [];
  assert.ok(structuredParts.some((part) => part.type === "reasoning_summary"));
  assert.ok(structuredParts.some((part) => part.type === "tool_call"));

  const terminalEvent = runEventFixture(
    6,
    "run_cancelled",
    { messageId: activeMessage.id },
    latest.id
  );
  messages = applyRunEventToMessages(messages, terminalEvent);
  assert.equal(messages.find((message) => message.id === activeMessage.id)?.status, "cancelled");
  assert.equal(terminalNoticeFromEvent(terminalEvent)?.status, "cancelled");
  assert.equal(terminalNoticeFromMessages(messages)?.status, "cancelled");
  assert.equal(updateRunFromEvent(latest, terminalEvent).status, "cancelled");
  const resumedRun = updateRunFromEvent(
    latest,
    runEventFixture(5, "permission.approved", { requestId: "permission" }, latest.id)
  );
  assert.equal(resumedRun.status, "running", "permission resolution replay left the recovered run waiting");

  assert.equal(resolveRunEventCursor("2", "4"), 4);
  assert.equal(resolveRunEventCursor("5", "4"), 4);
  assert.equal(resolveRunEventCursor("malformed", "4"), 4);
  assert.equal(resolveRunEventCursor("5", "malformed"), 5);
  assert.throws(() => resolveRunEventCursor("-1", undefined), /non-negative integer/);
  assert.deepEqual(planRunEventCursor(50, 7, false), { after: 7, canonicalized: true, noContent: false });
  assert.deepEqual(planRunEventCursor(50, 7, true), { after: 7, canonicalized: true, noContent: true });
  assert.deepEqual(planRunEventCursor(6, 7, true), { after: 6, canonicalized: false, noContent: false });
  assert.equal(runEventCursorControl(7), 'event: run_cursor\nid: 7\ndata: {"cursor":7}\n\n');
  const canonicalReconnectCursor = resolveRunEventCursor("50", "7");
  const terminalAfterAheadDisconnect: number[] = [];
  new OrderedRunEventReplay(latest.id, canonicalReconnectCursor, (event) => terminalAfterAheadDisconnect.push(event.seq)).replay([
    runEventFixture(8, "run_cancelled", { messageId: activeMessage.id }, latest.id)
  ]);
  assert.deepEqual(
    terminalAfterAheadDisconnect,
    [8],
    "an ahead query overrode the canonical Last-Event-ID and skipped a later terminal event"
  );
  const emitted: number[] = [];
  const orderedReplay = new OrderedRunEventReplay(latest.id, 1, (event) => emitted.push(event.seq));
  orderedReplay.pushLive(runEventFixture(3, "delta", { text: "duplicate" }, latest.id));
  orderedReplay.pushLive(runEventFixture(4, "delta", { text: "live" }, latest.id));
  orderedReplay.replay([
    runEventFixture(1, "run_started", {}, latest.id),
    runEventFixture(2, "delta", { text: "history" }, latest.id),
    runEventFixture(3, "delta", { text: "history-race" }, latest.id)
  ]);
  orderedReplay.pushLive(runEventFixture(4, "delta", { text: "duplicate-live" }, latest.id));
  orderedReplay.pushLive(runEventFixture(5, "delta", { text: "next" }, latest.id));
  assert.deepEqual(emitted, [2, 3, 4, 5], "replay/live sequence was missing, duplicated, or out of order");
  const reentrantEvents: number[] = [];
  let reentrantReplay!: OrderedRunEventReplay;
  reentrantReplay = new OrderedRunEventReplay(latest.id, 1, (event) => {
    reentrantEvents.push(event.seq);
    if (event.seq === 2) {
      reentrantReplay.pushLive(runEventFixture(3, "delta", { text: "during-replay" }, latest.id));
    }
  });
  reentrantReplay.replay([runEventFixture(2, "delta", { text: "history" }, latest.id)]);
  assert.deepEqual(reentrantEvents, [2, 3], "event buffered during replay was dropped");

  const largeReplaySequences: number[] = [];
  const largeReplay = new OrderedRunEventReplay(latest.id, 0, (event) => largeReplaySequences.push(event.seq));
  largeReplay.pushLive(runEventFixture(10_001, "delta", { text: "live-after-large-history" }, latest.id));
  largeReplay.replay(
    Array.from({ length: 10_000 }, (_, index) => runEventFixture(index + 1, "delta", { text: "history" }, latest.id))
  );
  assert.equal(largeReplaySequences.length, 10_001);
  assert.equal(largeReplaySequences[0], 1);
  assert.equal(largeReplaySequences.at(-1), 10_001);

  const usage = { inputTokens: 11, outputTokens: 7, reasoningTokens: 3, totalTokens: 18 };
  const usageMessage = { ...messageFixture("assistant-usage", latest.id, "usage"), usage };
  let usageMessages = applyRunEventToMessages(
    [],
    runEventFixture(7, "assistant_message_updated", { message: usageMessage }, latest.id)
  );
  usageMessages = applyRunEventToMessages(
    usageMessages,
    runEventFixture(8, "run_completed", { messageId: usageMessage.id }, latest.id)
  );
  assert.deepEqual(usageMessages[0]?.usage, usage, "terminal replay discarded usage from the latest message snapshot");
  assert.deepEqual(
    updateRunFromEvent(latest, runEventFixture(7, "assistant_message_updated", { message: usageMessage }, latest.id)).usage,
    usage,
    "public run replay did not retain usage from a message snapshot"
  );

  const headerHtml = renderToStaticMarkup(
    createElement(ChatHeader, {
      session: { id: "session", title: "Recovered", workingDirectory: "/fixture", createdAt: timestamp(0), updatedAt: timestamp(0) },
      provider: null,
      modelOverride: "",
      activeRunId: latest.id,
      statusLabel: reconnectingDisplay.label,
      statusTone: reconnectingDisplay.tone,
      lastProviderResolution: null,
      lastUnsupportedRunOptions: [],
      inspectorOpen: true,
      inspectorModal: false,
      pendingPermissionCount: 1,
      inspectorToggleRef: { current: null },
      onToggleInspector: () => undefined
    })
  );
  assert.match(headerHtml, /reconnecting/);
  const cancellingControlHtml = renderToStaticMarkup(
    createElement(RunActionButton, {
      activeRun: { ...latest, status: "cancelling" },
      cancelPending: true,
      runDisabled: true,
      onCancel: () => undefined
    })
  );
  assert.match(cancellingControlHtml, /Cancelling/);
  assert.match(cancellingControlHtml, /disabled/);
  const cancelControlHtml = renderToStaticMarkup(
    createElement(RunActionButton, {
      activeRun: { ...latest, status: "running" },
      cancelPending: false,
      runDisabled: true,
      onCancel: () => undefined
    })
  );
  assert.match(cancelControlHtml, />Cancel</);
  const terminalControlHtml = renderToStaticMarkup(
    createElement(RunActionButton, {
      activeRun: { ...latest, status: "cancelled", currentPhase: null },
      cancelPending: false,
      runDisabled: true,
      onCancel: () => undefined
    })
  );
  assert.equal(terminalControlHtml.includes(">Cancel<"), false);
}

async function shellCancellationScenario(): Promise<void> {
  const workingDirectory = mkdtempSync(join(tmpdir(), "agent-platform-shell-interrupt-"));
  try {
    const store = new SQLiteStore({ dbPath: ":memory:", defaultWorkingDirectory: workingDirectory });
    const eventBus = new RunEventBus();
    const tools = new ToolRegistry();
    tools.register(createShellExecTool());
    const kernel = createKernel(store, eventBus, new BlockingProvider(), tools, workingDirectory);
    store.setSetting(toolSettingsSettingKey, allowToolSettings(), new Date().toISOString());
    const session = kernel.createSession({ title: "shell cancel", workingDirectory });

    const descendantPidPath = join(workingDirectory, "descendant.pid");
    const command = longRunningNodeCommand(descendantPidPath);
    const invocationPromise = kernel.invokeTool(session.id, "shell.exec", { command, timeoutMs: 10_000 });
    const runId = await waitForActiveRunId(kernel, session.id);
    if (process.platform !== "win32") {
      await waitFor(() => existsSync(descendantPidPath), "shell descendant pid file");
    }

    const cancelStartedAt = Date.now();
    kernel.cancelRun(runId);
    const response = await invocationPromise;
    const cancelDurationMs = Date.now() - cancelStartedAt;
    assert.equal(response.result?.status, "cancelled");
    assert.ok(response.toolResultPartId, "cooperative shell cancellation did not persist a cancelled tool result");
    assert.equal(
      response.message.parts.find((part) => part.id === response.toolResultPartId)?.content.status,
      "cancelled"
    );
    assert.equal(kernel.getRun(runId).status, "cancelled");
    assert.ok(cancelDurationMs < 5_000, `shell cancellation took ${cancelDurationMs}ms`);
    assert.deepEqual(terminalEventTypes(kernel, runId), ["run_cancelled"]);

    if (process.platform !== "win32") {
      const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
      assert.ok(Number.isInteger(descendantPid) && descendantPid > 0, "invalid shell descendant pid fixture");
      await waitFor(() => !isProcessAlive(descendantPid), "shell descendant process exit");
    }

    const timeoutResponse = await kernel.invokeTool(session.id, "shell.exec", {
      command: longRunningNodeCommand(),
      timeoutMs: 50
    });
    assert.equal(timeoutResponse.result?.status, "failed");
    assert.equal(timeoutResponse.result?.output.timedOut, true);
    assert.equal(timeoutResponse.run.status, "failed");
    assert.deepEqual(terminalEventTypes(kernel, timeoutResponse.run.id), ["run_failed"]);

    const baselineTimeouts = activeTimeoutCount();
    const fakeChild = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdout: null,
      stderr: null,
      kill: () => true
    }) as unknown as ChildProcess;
    const fakeSpawn = (() => {
      queueMicrotask(() => fakeChild.emit("error", new Error("fixture spawn error")));
      return fakeChild;
    }) as unknown as typeof spawn;
    const spawnErrorTool = createShellExecTool({ spawn: fakeSpawn });
    const spawnController = new AbortController();
    const spawnPromise = spawnErrorTool.executor.execute(
      { command: "fixture spawn error", cwd: workingDirectory, timeoutMs: 10_000 },
      {
        invocation: toolInvocationFixture(session.id),
        cwd: workingDirectory,
        signal: spawnController.signal,
        emit: () => undefined
      }
    );
    spawnController.abort();
    await assert.rejects(spawnPromise, /fixture spawn error/);
    await delay(0);
    assert.ok(activeTimeoutCount() <= baselineTimeouts, "shell spawn error left a force-kill timeout active");
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

async function chatGPTRefreshCancellationScenario(): Promise<void> {
  const credential = expiredChatGPTCredential();
  const refreshStarted = deferred<void>();
  const requestedUrls: string[] = [];
  let refreshSignal: AbortSignal | null = null;
  const hangingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrls.push(String(input));
    refreshSignal = init?.signal ?? null;
    refreshStarted.resolve();
    return abortableNeverResponse(init?.signal);
  }) as typeof fetch;
  const credentialStore = { write: async () => undefined } as unknown as OpenAIChatGPTCredentialStore;
  const provider = new OpenAIChatGPTProvider({ credentialStore, fetch: hangingFetch, refreshTimeoutMs: 40 });
  const controller = new AbortController();
  const runPromise = provider.run(chatGPTRunInput(credential), { signal: controller.signal, writer: noOpProviderWriter() });
  await refreshStarted.promise;

  const abortError = new Error("fixture run abort");
  abortError.name = "AbortError";
  const abortStartedAt = Date.now();
  controller.abort(abortError);
  await assert.rejects(runPromise, /fixture run abort/);
  assert.ok(Date.now() - abortStartedAt < 250, "run waited for shared credential refresh after cancellation");
  assert.equal(refreshSignal?.aborted, false, "run cancellation aborted the shared refresh request");
  assert.equal(requestedUrls.length, 1, "provider request started after cancellation while refresh was pending");
  await delay(70);
  assert.equal(refreshSignal?.aborted, true, "credential refresh did not enforce its own timeout");

  let alreadyAbortedFetchCalls = 0;
  const alreadyAbortedProvider = new OpenAIChatGPTProvider({
    credentialStore,
    refreshTimeoutMs: 40,
    fetch: (async () => {
      alreadyAbortedFetchCalls += 1;
      return Response.json({});
    }) as typeof fetch
  });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(abortError);
  await assert.rejects(
    alreadyAbortedProvider.run(chatGPTRunInput(credential), { signal: alreadyAborted.signal, writer: noOpProviderWriter() }),
    /fixture run abort/
  );
  assert.equal(alreadyAbortedFetchCalls, 0, "aborted run started credential refresh or provider fetch");

  const timeoutStartedAt = Date.now();
  let timeoutError: unknown;
  try {
    await refreshOpenAIChatGPTCredential(credential, {
      timeoutMs: 20,
      fetch: (async (_input, init) => abortableNeverResponse(init?.signal)) as typeof fetch
    });
  } catch (error) {
    timeoutError = error;
  }
  assert.ok(timeoutError instanceof Error);
  assert.match(timeoutError.message, /timed out after 20ms/);
  assert.equal(timeoutError.message.includes(credential.refresh), false, "refresh timeout exposed credential material");
  assert.ok(Date.now() - timeoutStartedAt < 500, "credential refresh timeout was not bounded");

  const nonCooperativeStartedAt = Date.now();
  await assert.rejects(
    refreshOpenAIChatGPTCredential(credential, {
      timeoutMs: 20,
      fetch: (async () => new Promise<Response>(() => undefined)) as typeof fetch
    }),
    /timed out after 20ms/
  );
  assert.ok(Date.now() - nonCooperativeStartedAt < 500, "refresh timeout depended on fetch honoring AbortSignal");
}

async function abortableNeverResponse(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_resolvePromise, rejectPromise) => {
    const rejectAbort = () => {
      const error = new Error("fixture refresh fetch aborted");
      error.name = "AbortError";
      rejectPromise(error);
    };
    if (!signal) {
      rejectPromise(new Error("fixture refresh fetch did not receive a timeout signal"));
      return;
    }
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function expiredChatGPTCredential(): OpenAIChatGPTCredential {
  return {
    type: "oauth",
    access: "fixture-expired-access",
    refresh: "fixture-refresh-secret",
    expiresAt: 0,
    updatedAt: timestamp(0)
  };
}

function chatGPTRunInput(credential: OpenAIChatGPTCredential): ProviderRunInput {
  const now = timestamp(0);
  const profile: ProviderProfile = {
    id: "openai-chatgpt",
    name: "Fixture ChatGPT",
    type: "openai-chatgpt",
    vendor: "openai",
    runtime: "chatgpt-codex",
    authMode: "oauth-device",
    billingSource: "consumer-subscription",
    source: "builtin",
    enabled: true,
    model: "fixture-model",
    status: { state: "connected", message: "fixture", credentialStatus: "present" }
  };
  const agent = {
    id: "main",
    name: "Fixture",
    description: null,
    systemPrompt: "fixture",
    modelProfileId: null,
    defaultRunOptions: null,
    skillIds: [],
    toolIds: [],
    metadata: {},
    createdAt: now,
    updatedAt: now
  };
  return {
    session: { id: "fixture-session", title: "fixture", workingDirectory: "/fixture", createdAt: now, updatedAt: now },
    context: {
      agent,
      systemPrompt: "fixture",
      workingDirectory: "/fixture",
      messages: [{ role: "user", content: "fixture" }],
      availableTools: [],
      runOptions: { model: "fixture-model" },
      metadata: {}
    },
    messages: [{ role: "user", content: "fixture" }],
    sourceMessages: [],
    profile,
    credential: { oauth: credential },
    requestedRunOptions: { model: "fixture-model" },
    runOptions: { model: "fixture-model" },
    unsupportedRunOptions: []
  };
}

function noOpProviderWriter(): ProviderRunWriter {
  return {
    writeDelta: () => undefined,
    writeUsage: () => undefined,
    writeMetadata: () => undefined
  };
}

class BlockingProvider implements ProviderAdapter {
  readonly id = "interrupt-fixture";
  readonly label = "Interrupt fixture";
  private readonly startedDeferred = deferred<void>();
  signal: AbortSignal | null = null;
  runs = 0;

  get started(): Promise<void> {
    return this.startedDeferred.promise;
  }

  async test(profile: ProviderProfile, _credential: ProviderCredential): Promise<ProviderTestResponse> {
    return { ok: true, profile, status: profile.status, message: "fixture", checkedAt: new Date().toISOString() };
  }

  async run(_input: ProviderRunInput, context: ProviderRunContext) {
    this.runs += 1;
    this.signal = context.signal;
    this.startedDeferred.resolve();
    await context.writer.writeDelta("started");
    if (!context.signal.aborted) {
      await new Promise<void>((resolvePromise) => context.signal.addEventListener("abort", () => resolvePromise(), { once: true }));
    }
    await context.writer.writeDelta("late-before-terminal");
    return { toolCalls: [] };
  }
}

class NonCooperativeProvider implements ProviderAdapter {
  readonly id = "non-cooperative-interrupt-fixture";
  readonly label = "Non-cooperative interrupt fixture";
  private readonly startedDeferred = deferred<void>();
  private readonly releaseDeferred = deferred<void>();
  private readonly finishedDeferred = deferred<void>();

  get started(): Promise<void> {
    return this.startedDeferred.promise;
  }

  get finished(): Promise<void> {
    return this.finishedDeferred.promise;
  }

  finish(): void {
    this.releaseDeferred.resolve();
  }

  async test(profile: ProviderProfile, _credential: ProviderCredential): Promise<ProviderTestResponse> {
    return { ok: true, profile, status: profile.status, message: "fixture", checkedAt: new Date().toISOString() };
  }

  async run(_input: ProviderRunInput, context: ProviderRunContext) {
    await context.writer.writeDelta("before-shutdown");
    this.startedDeferred.resolve();
    await this.releaseDeferred.promise;
    await context.writer.writeDelta("after-terminal");
    this.finishedDeferred.resolve();
    return { toolCalls: [] };
  }
}

function createKernel(
  store: SQLiteStore,
  eventBus: RunEventBus,
  provider: ProviderAdapter,
  tools: ToolRegistry,
  workingDirectory: string
): Kernel {
  return new Kernel({
    store,
    eventBus,
    providers: fakeProviderRegistry(provider),
    tools,
    toolExecutionCwd: workingDirectory
  });
}

function fakeProviderRegistry(adapter: ProviderAdapter): ProviderRegistry {
  const profile: ProviderProfile = {
    id: "interrupt-fixture",
    name: "Interrupt fixture",
    type: "mock",
    vendor: "local",
    runtime: "mock",
    authMode: "none",
    billingSource: "local",
    source: "builtin",
    enabled: true,
    status: { state: "available", message: "fixture", credentialStatus: "not_required" }
  };
  return {
    resolveRun(selection: { provider?: string; providerProfileId?: string }) {
      return {
        adapter,
        profile,
        credential: {},
        providerResolution: {
          requestedProvider: selection.provider ?? null,
          requestedProviderProfileId: selection.providerProfileId ?? null,
          providerProfileId: profile.id,
          providerProfileName: profile.name,
          providerType: profile.type,
          fallback: null
        }
      };
    }
  } as unknown as ProviderRegistry;
}

function createStoredRun(
  store: SQLiteStore,
  sessionId: string,
  status: "running",
  withAssistantMessage: boolean,
  tick: number
): { runId: string; messageId: string | null } {
  const runId = randomUUID();
  store.createRun({
    id: runId,
    sessionId,
    provider: "interrupt-fixture",
    status,
    createdAt: timestamp(tick),
    updatedAt: timestamp(tick)
  });
  if (!withAssistantMessage) {
    return { runId, messageId: null };
  }
  const messageId = randomUUID();
  store.createMessage({
    id: messageId,
    sessionId,
    runId,
    role: "assistant",
    status: "streaming",
    createdAt: timestamp(tick),
    updatedAt: timestamp(tick)
  });
  return { runId, messageId };
}

function publicRunFixture(id: string, status: RunType.Status, updatedAt: string): PublicRunSummary {
  return {
    id,
    sessionId: "recovery-session",
    provider: "fixture-provider",
    status,
    model: "fixture-model",
    runOptions: { model: "fixture-model" },
    usage: null,
    currentPhase: status === "waiting_permission" ? "waiting_permission" : status === "cancelling" ? "cancelling" : status === "running" ? "running" : null,
    createdAt: timestamp(0),
    updatedAt,
    error: null
  };
}

function messageFixture(id: string, runId: string, text: string): Message {
  return {
    id,
    sessionId: "recovery-session",
    runId,
    role: "assistant",
    status: "streaming",
    error: null,
    metadata: {},
    model: null,
    runOptions: null,
    usage: null,
    createdAt: timestamp(0),
    updatedAt: timestamp(0),
    parts: text
      ? [
          {
            id: `${id}:text`,
            messageId: id,
            seq: 0,
            type: "text",
            text,
            content: { text },
            metadata: {},
            createdAt: timestamp(0),
            updatedAt: timestamp(0)
          }
        ]
      : []
  };
}

function runEventFixture(seq: number, type: RunEvent["type"], payload: unknown, runId: string): RunEvent {
  return {
    id: `event-${seq}-${type}`,
    runId,
    sessionId: "recovery-session",
    seq,
    type,
    createdAt: timestamp(seq),
    payload
  };
}

function messageText(message: Message | undefined): string {
  return message?.parts.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
}

function createStoredSession(store: SQLiteStore, workingDirectory: string, title: string, tick: number) {
  return store.createSession({
    id: randomUUID(),
    title,
    workingDirectory,
    createdAt: timestamp(tick),
    updatedAt: timestamp(tick)
  });
}

function writeLegacyTerminalRunFixture(dbPath: string, runId: string, updatedAt: string): void {
  const database = new Database(dbPath);
  try {
    const result = database
      .prepare("UPDATE runs SET status = 'cancelled', error = NULL, updated_at = ? WHERE id = ? AND status = 'waiting_permission'")
      .run(updatedAt, runId);
    assert.equal(result.changes, 1, "legacy terminal-run fixture could not bypass the current atomic finalization contract");
  } finally {
    database.close();
  }
}

function createPendingPermissionFixture(
  store: SQLiteStore,
  sessionId: string,
  run: { runId: string; messageId: string | null },
  workingDirectory: string,
  suffix: string,
  tick: number,
  toolId = "shell.exec"
): ReturnType<SQLiteStore["createPermissionRequest"]> {
  assert.ok(run.messageId, `${suffix}: assistant message is required`);
  const invocationId = `call-${suffix}`;
  const toolCallPartId = randomUUID();
  const commandOutputPartId = randomUUID();
  store.addMessagePart({
    id: toolCallPartId,
    messageId: run.messageId,
    seq: 1,
    type: "tool_call",
    text: "approval required",
    content: { callId: invocationId, toolId, status: "pending_permission" },
    createdAt: timestamp(tick),
    updatedAt: timestamp(tick)
  });
  store.addMessagePart({
    id: commandOutputPartId,
    messageId: run.messageId,
    seq: 2,
    type: "command_output",
    text: "",
    content: { callId: invocationId, text: "" },
    createdAt: timestamp(tick + 1),
    updatedAt: timestamp(tick + 1)
  });
  return store.createPermissionRequest({
    id: randomUUID(),
    sessionId,
    runId: run.runId,
    messageId: run.messageId,
    invocationId,
    toolId,
    toolName: toolId,
    caller: "model",
    permissionDecision: "requires_approval",
    inputSummary: "approval required",
    publicInput: { command: "safe fixture" },
    executionInput: { command: "safe fixture", cwd: workingDirectory },
    riskLevel: "high",
    reason: "fixture",
    status: "pending",
    toolCallPartId,
    commandOutputPartId,
    metadata: { agentToolLoop: true, executionCwd: workingDirectory },
    createdAt: timestamp(tick + 2),
    updatedAt: timestamp(tick + 2)
  });
}

function allowToolSettings(): JsonObject {
  return {
    defaultAction: "allow",
    denyPatternsText: "",
    askPatternsText: "",
    allowPatternsText: "",
    shell: { defaultTimeoutMs: 1_000, maxTimeoutMs: 20_000, maxOutputChars: 8_000 }
  };
}

function askToolSettings(): JsonObject {
  return {
    ...allowToolSettings(),
    defaultAction: "ask"
  };
}

function denyToolSettings(): JsonObject {
  return {
    ...allowToolSettings(),
    defaultAction: "deny"
  };
}

function longRunningNodeCommand(descendantPidPath?: string): string {
  const childCode = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const code = descendantPidPath
    ? `const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',${JSON.stringify(
        childCode
      )}],{stdio:'ignore'});writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid));setInterval(()=>{},1000)`
    : childCode;
  return `${shellQuote(process.execPath)} -e ${shellQuote(code)}`;
}

function shellQuote(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function terminalEventTypes(kernel: Kernel, runId: string): string[] {
  return kernel
    .listRunEvents(runId)
    .map((event) => event.type)
    .filter(isTerminalRunEventType);
}

async function waitForRunStatus(kernel: Kernel, runId: string, status: RunType.Status): Promise<void> {
  await waitFor(() => kernel.getRun(runId).status === status, `run ${runId} status ${status}`);
}

async function waitForActiveRunId(kernel: Kernel, sessionId: string): Promise<string> {
  let runId = "";
  await waitFor(() => {
    runId = kernel.listRuns(sessionId, true)[0]?.id ?? "";
    return Boolean(runId);
  }, "active tool run");
  return runId;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function activeTimeoutCount(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

function toolInvocationFixture(sessionId: string): ToolInvocation {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    toolId: "shell.exec",
    toolName: "Shell Exec",
    sessionId,
    runId: randomUUID(),
    messageId: randomUUID(),
    caller: "manual",
    status: "running",
    permissionDecision: "allowed",
    input: {},
    metadata: {},
    createdAt: now,
    updatedAt: now
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function timestamp(tick: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick)).toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function permissionStatusQueryScenario(): void {
  for (const input of [undefined, null, ""]) {
    assert.equal(parsePermissionStatus(input), undefined, "absent status must preserve the unfiltered query");
  }
  for (const input of ["pending", "approved", "denied", "expired"]) {
    assert.equal(parsePermissionStatus(input), input);
  }
  for (const input of [[], ["pending"], ["pending", "approved"]]) {
    assert.throws(() => parsePermissionStatus(input), (error: unknown) => error instanceof KernelError && error.statusCode === 400 && error.message === "Permission status query must be a single value.");
  }
  for (const input of [false, 0, {}, "unknown", " pending", "pending ", "PENDING", "allow", "deny"]) {
    assert.throws(() => parsePermissionStatus(input), (error: unknown) => error instanceof KernelError && error.statusCode === 400 && error.message === "Permission status must be one of pending, approved, denied, expired.");
  }
}

permissionStatusQueryScenario();
await providerCancellationScenario();
await restartAndPermissionScenario();
await boundedShutdownScenario();
await genericToolTerminationScenario();
await asynchronousManualToolCancellationScenario();
await manualToolDenyCompatibilityScenario();
await waitingCancelRegistryScenario();
await publicRunProjectionAndStoreInvariantScenario();
usageSnapshotReplayScenario();
await approvedPermissionPreparationFailureScenario();
await singleActiveRunInvariantScenario();
runRecoveryAndReplayScenario();
await chatGPTRefreshCancellationScenario();
await shellCancellationScenario();
console.log(
  "Interrupt smoke passed: sync/async manual compatibility, canonical cursor reconnect, public DTO/redaction, replay, terminal CAS, and session race guards."
);
