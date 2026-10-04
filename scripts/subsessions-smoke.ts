import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import express from "express";
import { registerApiRoutes } from "../src/server/routes";
import { defaultToolSettings } from "../src/shared/tool-settings";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Kernel } from "../src/kernel/kernel";
import { RunEventBus } from "../src/kernel/event-bus";
import { RunWriter } from "../src/kernel/run-writer";
import { SQLiteStore } from "../src/store/sqlite";
import { ToolRegistry } from "../src/tools/registry";
import type { ProviderRegistry } from "../src/providers/registry";
import type { ProviderAdapter, ProviderRunInput, ProviderRunContext } from "../src/providers/types";
import type { ProviderProfile, ProviderTestResponse } from "../src/shared/types";
import { SubsessionLinks } from "../src/client/SubsessionPanel";
import { runDisplayStatus, updateRunFromEvent } from "../src/client/run-recovery";
import { navigateToRelatedSession } from "../src/client/session-navigation";
import { ChildActionsController } from "../src/client/child-actions";
import { requestJson } from "../src/client/api";
import { admissionScenarios } from "./subsessions-admission-smoke";
import { childActionScenarios } from "./child-actions-smoke";
import type { InvokeToolResponse, Session } from "../src/shared/types";

function childResultSentinel(sessionId: string): string { return `UNIQUE_CHILD_RESULT_FD4E_${sessionId}`; }

class FakeProvider implements ProviderAdapter {
  id = "mock";
  label = "Subsession test provider";
  targetAgentId = "";
  childCount = 1;
  parentCalls = 0;
  parentInFlight = 0;
  maximumParentInFlight = 0;
  inputs: ProviderRunInput[] = [];
  releaseChildren: Array<() => void> = [];
  blockChildren = false;
  failChildren = false;
  childDelegates = false;
  childShell = false;
  childCalls = 0;
  batch = false;
  childOutput = "";
  writeBeforeChildBlock = false;
  afterParentDelta?: () => void;
  async test(profile: ProviderProfile): Promise<ProviderTestResponse> {
    return { ok: true, profile, status: profile.status, message: "fake", checkedAt: new Date().toISOString() };
  }
  async run(input: ProviderRunInput, context: ProviderRunContext) {
    this.inputs.push(input);
    if (input.context.systemPrompt.includes("cumulative continuity summary")) {
      await context.writer.writeDelta("Goals and user intent\nDelegate work.\nDecisions and constraints\nIndependent children.\nCurrent implementation and changed files\nNone.\nValidation and results\nChild result received.\nOpen issues and next work\nContinue.\nImportant tool results\nChild result references preserved.");
      return { toolCalls: [] };
    }
    if (input.context.agent.id === this.targetAgentId) {
      this.childCalls++;
      if (this.writeBeforeChildBlock) await context.writer.writeDelta(childResultSentinel(input.session.id));
      if (this.childShell && this.childCalls === 1) return { toolCalls: [{ id: "child-shell", name: "shell_exec", arguments: { command: "fixture operation" } }] };
      if (this.childDelegates) return { toolCalls: [{ id: "recursive", name: "subsession_start", arguments: { agentId: this.targetAgentId, task: "nested" } }] };
      if (this.blockChildren) await new Promise<void>((resolve, reject) => {
        this.releaseChildren.push(resolve);
        if (context.signal.aborted) reject(context.signal.reason);
        else context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
      if (this.failChildren) throw new Error("fake child failure");
      await context.writer.writeDelta(`${childResultSentinel(input.session.id)} ${this.childOutput || "x".repeat(7000)}`);
      return { toolCalls: [] };
    }
    this.parentInFlight++;
    this.maximumParentInFlight = Math.max(this.maximumParentInFlight, this.parentInFlight);
    try {
      this.parentCalls++;
      if (this.batch && this.parentCalls === 1) return { toolCalls: Array.from({ length: this.childCount },(_,i) => ({ id: `batch-${i}`, name: "subsession_start", arguments: { agentId: this.targetAgentId, task: `batch task ${i}` } })) };
      if (this.batch) {
        await context.writer.writeDelta("Batch parent answer");
        return { toolCalls: [] };
      }
      if (this.parentCalls <= this.childCount) return { toolCalls: [{ id: `delegate-${this.parentCalls}`, name: "subsession_start", arguments: { agentId: this.targetAgentId, task: `Independent task ${this.parentCalls}`, title: `Child ${this.parentCalls}` } }] };
      const hasResults = input.context.messages.some((message) => message.content.includes("[child result handoff]"));
      await context.writer.writeDelta(hasResults ? "PARENT_FINAL_AFTER_HANDOFF" : "PARENT_INTERMEDIATE_WAITING");
      this.afterParentDelta?.();
      await context.writer.writeDelta(" parent delta two");
      this.afterParentDelta?.();
      await context.writer.writeDelta(" parent delta three");
      this.afterParentDelta?.();
      return { toolCalls: [] };
    } finally { this.parentInFlight--; }
  }
}

function registry(provider: FakeProvider): ProviderRegistry {
  const profile: ProviderProfile = { id: "mock", name: "Fake", type: "mock", enabled: true, source: "builtin",
    status: { state: "available", message: "fixture", credentialStatus: "not_required" } };
  const resolve = () => ({ adapter: provider, profile, credential: {}, providerResolution: {
    requestedProvider: null, requestedProviderProfileId: null, providerProfileId: "mock", providerProfileName: "Fake", providerType: "mock", fallback: null
  } });
  return { list: () => ({ providers: [profile], defaultProviderProfileId: "mock" }), resolveRun: resolve,
    resolveRunExact: resolve, resolveModelContextCapability: async () => ({ windowTokens: 32768, source: "adapter" }) } as unknown as ProviderRegistry;
}

async function fixture(operation: (f: ReturnType<typeof createFixture>) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "subsessions-smoke-"));
  const f = createFixture(directory);
  try { await operation(f); }
  finally { await f.kernel.shutdown(1000); (f.store as unknown as { db: { close(): void } }).db.close(); rmSync(directory, { recursive: true, force: true }); }
}
function createFixture(directory: string) {
  const store = new SQLiteStore({ dbPath: join(directory,"test.db"), defaultWorkingDirectory: directory });
  const provider = new FakeProvider();
  const providers = registry(provider);
  const tools = new ToolRegistry();
  tools.register({ definition: { id: "shell.exec", name: "Fake shell", description: "No actual process", source: "builtin", inputSchema: {}, outputSchema: {}, metadata: {} },
    executor: { execute: async (_input,context) => {
      await context.emit({invocationId:context.invocation.id,toolId:"shell.exec",type:"tool.stdout.delta",createdAt:new Date().toISOString(),payload:{text:"FAKE_COMPLETED_TOOL_PROGRESS_SENTINEL"}});
      return { exitCode: 0, stdout: "FAKE_COMPLETED_TOOL_PROGRESS_SENTINEL" };
    } } });
  const kernel = new Kernel({ store, eventBus: new RunEventBus(), providers, tools, toolExecutionCwd: directory });
  const childAgent = kernel.createAgentDefinition({ name: "Worker", systemPrompt: "CHILD_PRIVATE_PROFILE", modelProfileId: "mock", toolIds: [], contextPolicy: { automaticCompaction: false } });
  const parentAgent = kernel.createAgentDefinition({ name: "Orchestrator", systemPrompt: "PARENT_PRIVATE_PROFILE", modelProfileId: "mock", toolIds: ["subsession.start"], contextPolicy: { automaticCompaction: false } });
  provider.targetAgentId = childAgent.id;
  const session = kernel.createSession({ title: "Root", agentId: parentAgent.id, workingDirectory: directory });
  return { store, provider, providers, tools, kernel, childAgent, parentAgent, session, directory };
}
async function until(predicate: () => boolean, label = "condition") {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve,5)); }
  assert.fail(`Timeout: ${label}`);
}
async function approveNext(f: ReturnType<typeof createFixture>, runId: string) {
  await until(() => f.kernel.getRun(runId).status === "waiting_permission", "delegation approval");
  const request = f.kernel.listPermissionRequests("pending").find((item) => item.runId === runId)!;
  assert.match(request.inputSummary, /Target tools:/);
  assert.equal(request.toolId, "subsession.start");
  await f.kernel.approvePermissionRequest(request.id);
}

async function successScenario(blocked: boolean, count: number) {
  await fixture(async (f) => {
    f.provider.blockChildren = blocked;
    f.provider.childCount = count;
    let checkedParentDeltas = 0;
    f.provider.afterParentDelta = () => {
      for (const child of f.store.subsessions.list()) {
        if (!child.deliveredPartId) continue;
        const part = f.store.listMessages(f.session.id).flatMap((m) => m.parts).find((p) => p.id === child.deliveredPartId)!;
        assert.equal(part.type, "tool_result", "parent text delta overwrote the child handoff type");
        assert.ok(part.seq >= 1, "handoff occupied reserved text sequence 0");
        assert.ok(part.text.includes(childResultSentinel(child.childSessionId)), "parent text delta overwrote unique child result");
        checkedParentDeltas++;
      }
    };
    assert.deepEqual(f.kernel.getAgentDefinition("main").toolIds, ["shell.exec","subsession.start"]);
    assert.equal(f.session.parentSessionId, null);
    const started = await f.kernel.startRun(f.session.id,"PARENT_TASK_ONLY");
    for (let i=0; i<count; i++) await approveNext(f, started.run.id);
    if (blocked) {
      await until(() => f.kernel.getRun(started.run.id).status === "waiting_children", "waiting children");
      assert.equal(f.kernel.getPublicRun(started.run.id).children?.unfinished, count);
      assert.match(runDisplayStatus(f.kernel.getPublicRun(started.run.id),"reconnecting",null).label,/waiting for children/);
      const waitEvent = f.kernel.listRunEvents(started.run.id).find((event) => event.type === "run_waiting_children")!;
      const snapshot = f.kernel.getPublicRun(started.run.id);
      assert.equal(updateRunFromEvent(snapshot,{...waitEvent,runId:"different-run"}),snapshot);
      await assert.rejects(f.kernel.startRun(f.session.id,"must not start during wait"));
      await assert.rejects(f.kernel.compactSession(f.session.id));
      for (const release of f.provider.releaseChildren) release();
    }
    await until(() => f.kernel.getRun(started.run.id).status === "completed", "parent final");
    const children = f.kernel.listSubsessions(f.session.id);
    assert.equal(children.length,count);
    assert.ok(children.every((item) => item.acknowledged && item.deliveredPartId));
    assert.ok(checkedParentDeltas >= count * 3, "handoffs were not checked after multiple actual parent deltas");
    assert.equal(f.provider.maximumParentInFlight,1);
    for (const child of children) {
      const session = f.kernel.getSession(child.childSessionId);
      assert.equal(session.parentSessionId,f.session.id);
      assert.equal(session.workingDirectory,f.session.workingDirectory);
      const childInput = f.provider.inputs.find((input) => input.session.id === child.childSessionId)!;
      assert.equal(childInput.context.agent.id,f.childAgent.id);
      assert.equal(childInput.context.availableTools.length,0);
      assert.ok(!JSON.stringify(childInput.context).includes("PARENT_TASK_ONLY"));
      assert.ok(child.result!.length < 6100);
      const part = f.store.listMessages(f.session.id).flatMap((m) => m.parts).find((p) => p.id === child.deliveredPartId)!;
      assert.equal(part.type,"tool_result");
      assert.equal(part.content.outputSummary,part.text);
      assert.ok(part.text.includes(childResultSentinel(child.childSessionId)));
    }
    const parentMessages = f.store.listMessages(f.session.id);
    assert.ok(parentMessages.some((message) => message.parts.some((part) => part.text.includes("PARENT_FINAL_AFTER_HANDOFF"))));
    assert.equal(parentMessages.flatMap((message) => message.parts).filter((part) => part.type === "command_output").length,0);
    assert.equal(parentMessages.flatMap((message) => message.parts).filter((part) => part.metadata.subsessionHandoff === true).length,count);
    f.store.subsessions.reconcile();
    assert.equal(f.store.subsessions.deliver(started.run.id,started.assistantMessageId),false);
    const html = renderToStaticMarkup(createElement(SubsessionLinks,{ parentSessionId: f.session.id, children, onOpen: () => undefined, initiallyExpanded:true }));
    assert.match(html,/부모 대화 열기/); assert.match(html,/자식 대화 열기/);
    assert.ok(!JSON.stringify(f.kernel.getPublicRun(started.run.id)).includes("PARENT_PRIVATE_PROFILE"));
    assert.ok(f.provider.inputs.filter((input) => input.session.id === f.session.id).some((input) => input.context.messages.some((m) => m.content.includes("childSessionId"))));
    const nextContext = await f.kernel.previewContext(f.session.id,{ text: "next turn" });
    for (const child of children) assert.ok(nextContext.context.messages.some((message) => message.content.includes(childResultSentinel(child.childSessionId))),"unique child result absent from next-turn history");
    if (!blocked) {
      for (let i=0;i<3;i++) {
        const next = await f.kernel.startRun(f.session.id,`later turn ${i}`);
        await until(() => f.kernel.getRun(next.run.id).status === "completed");
      }
      const compacted = await f.kernel.compactSession(f.session.id);
      assert.equal(compacted.state,"completed",compacted.message);
      assert.ok(f.provider.inputs.at(-1)!.context.messages.some((message) => message.content.includes(childResultSentinel(children[0].childSessionId))),"actual compaction request omitted unique child result");
      assert.equal(f.kernel.getSession(children[0].childSessionId).parentSessionId,f.session.id);
    }
  });
}

async function cancelScenario() {
  await fixture(async (f) => {
    f.provider.blockChildren = true;
    const started = await f.kernel.startRun(f.session.id,"cancel parent");
    await approveNext(f,started.run.id);
    await until(() => f.kernel.getRun(started.run.id).status === "waiting_children");
    const child = f.kernel.listSubsessions(f.session.id)[0];
    const unrelatedSession = f.kernel.createSession({ title:"Unrelated",workingDirectory:f.directory });
    const unrelated = f.store.createRun({id:"unrelated-active",sessionId:unrelatedSession.id,provider:"mock",status:"running",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    f.kernel.cancelRun(started.run.id);
    await until(() => f.kernel.getRun(child.childRunId).status === "cancelled");
    assert.equal(f.kernel.getRun(started.run.id).status,"cancelled");
    f.store.subsessions.reconcile();
    assert.equal(f.kernel.listSubsessions(f.session.id)[0].status,"cancelled");
    assert.equal(f.kernel.listSubsessions(f.session.id)[0].acknowledged,false);
    assert.equal(f.kernel.getRun(unrelated.id).status,"running","parent cancellation escaped owned children");
    f.kernel.cancelRun(unrelated.id);
    await new Promise((resolve) => setTimeout(resolve,20));
    assert.equal(f.kernel.getRun(started.run.id).status,"cancelled","late child resurrected parent");
  });
}

async function permissionBoundaryScenario() {
  await fixture(async (f) => {
    f.provider.blockChildren = true;
    f.provider.childCount = 2;
    const started = await f.kernel.startRun(f.session.id,"two children with separate approvals");
    await approveNext(f,started.run.id);
    await until(() => f.kernel.getRun(started.run.id).status === "waiting_permission");
    const callsAtPermission = f.provider.parentCalls;
    await until(() => f.provider.releaseChildren.length === 1,"child actually started");
    for (const release of f.provider.releaseChildren) release();
    await until(() => f.kernel.listSubsessions(f.session.id)[0].result !== null);
    await new Promise((resolve) => setTimeout(resolve,20));
    assert.equal(f.kernel.getRun(started.run.id).status,"waiting_permission");
    assert.equal(f.provider.parentCalls,callsAtPermission,"child result bypassed approval");
    f.provider.blockChildren = false;
    await approveNext(f,started.run.id);
    await until(() => f.kernel.getRun(started.run.id).status === "completed");
    assert.ok(f.kernel.listSubsessions(f.session.id).every((item) => item.acknowledged));
  });
}

async function restartScenario(deliveredBeforeCrash: boolean, wakeBeforeCrash = false) {
  await fixture(async (f) => {
    f.provider.blockChildren = true;
    const started = await f.kernel.startRun(f.session.id,"restart parent");
    f.provider.writeBeforeChildBlock = deliveredBeforeCrash;
    await approveNext(f,started.run.id);
    await until(() => f.kernel.getRun(started.run.id).status === "waiting_children");
    await until(() => f.provider.releaseChildren.length === 1);
    const child = f.kernel.listSubsessions(f.session.id)[0];
    await f.kernel.shutdown(1000);
    assert.equal(f.kernel.getRun(child.childRunId).status,"interrupted");
    assert.equal(f.kernel.getRun(started.run.id).status,"waiting_children");
    if (wakeBeforeCrash) assert.equal(f.store.subsessions.wake(started.run.id),true);
    if (deliveredBeforeCrash) {
      f.store.transitionRunStatus(started.run.id,["waiting_children"],"running",null,new Date().toISOString());
      const now = new Date().toISOString();
      const emptyAssistant = f.store.createMessage({ id: "empty-before-handoff", sessionId: f.session.id, runId: started.run.id,
        role: "assistant", status: "streaming", createdAt: now, updatedAt: now });
      assert.equal(emptyAssistant.parts.length,0);
      assert.equal(f.store.subsessions.deliver(started.run.id,emptyAssistant.id),true);
      const partId = f.store.subsessions.list(started.run.id)[0].deliveredPartId!;
      const handoffBefore = f.store.getMessage(emptyAssistant.id)!.parts.find((part) => part.id === partId)!;
      assert.equal(handoffBefore.seq,1);
      assert.equal(handoffBefore.type,"tool_result");
      assert.ok(handoffBefore.text.includes(childResultSentinel(child.childSessionId)));
      const writer = new RunWriter({ store: f.store, eventBus: new RunEventBus(), run: f.store.getRun(started.run.id)!, assistantMessageId: emptyAssistant.id });
      writer.writeDelta("FIRST_PARENT_DELTA_BEFORE_CRASH");
      assert.deepEqual(f.store.getMessage(emptyAssistant.id)!.parts.find((part) => part.id === partId),handoffBefore);
      assert.equal(f.store.getMessage(emptyAssistant.id)!.parts[0].type,"text");
      assert.equal(f.store.subsessions.deliver(started.run.id,emptyAssistant.id),false);
      assert.equal(f.store.subsessions.list(started.run.id)[0].acknowledged,false);
    }
    (f.store as unknown as { db: Database.Database }).db.close();
    f.store = new SQLiteStore({ dbPath: join(f.directory,"test.db"), defaultWorkingDirectory: f.directory });
    const restarted = new Kernel({ store: f.store, eventBus: new RunEventBus(), providers: f.providers, tools: new ToolRegistry(), toolExecutionCwd: f.directory });
    f.kernel = restarted;
    try {
      restarted.reconcileStartupState();
      await until(() => restarted.getRun(started.run.id).status === "completed","restarted parent handoff");
      assert.equal(f.store.subsessions.list(started.run.id)[0].acknowledged,true);
      assert.equal(f.store.listMessages(f.session.id).flatMap((m) => m.parts).filter((p) => p.metadata.subsessionHandoff === true).length,1);
      if (deliveredBeforeCrash) {
        const handoffId = f.store.subsessions.list(started.run.id)[0].deliveredPartId;
        const handoff = f.store.listMessages(f.session.id).flatMap((m) => m.parts).find((part) => part.id === handoffId)!;
        assert.equal(handoff.type,"tool_result");
        assert.ok(handoff.text.includes(childResultSentinel(child.childSessionId)));
        const resumedInput = f.provider.inputs.filter((input) => input.session.id === f.session.id).at(-1)!;
        assert.ok(resumedInput.context.messages.some((message) => message.content.includes(childResultSentinel(child.childSessionId))),"restarted provider lost original child result after first delta");
      }
      assert.equal(restarted.getRun(child.childRunId).status,"interrupted","startup reran a child");
    } finally { await restarted.shutdown(100); }
  });
}

async function authorityAndLimitsScenario() {
  await fixture(async (f) => {
    const started = await f.kernel.startRun(f.session.id,"profile edit while awaiting approval");
    await until(() => f.kernel.getRun(started.run.id).status === "waiting_permission");
    f.kernel.updateAgentDefinition({ id: f.childAgent.id, expectedRevision: f.childAgent.revision, systemPrompt: "changed after approval request", updatedAt: new Date().toISOString() });
    await approveNext(f,started.run.id);
    await until(() => f.kernel.getRun(started.run.id).status === "completed");
    assert.equal(f.kernel.listSubsessions(f.session.id).length,0,"changed target gained authority without renewed approval");
  });
  await fixture(async (f) => {
    f.provider.childCount = 5;
    f.provider.blockChildren = true;
    const started = await f.kernel.startRun(f.session.id,"limit children");
    for (let i=0;i<5;i++) await approveNext(f,started.run.id);
    await until(() => f.kernel.getRun(started.run.id).status === "waiting_children");
    assert.equal(f.kernel.listSubsessions(f.session.id).length,4);
    assert.ok(f.store.listMessages(f.session.id).flatMap((m) => m.parts).some((part) => part.type === "tool_result" && part.text.includes("subsession_capacity_exhausted")));
    const first = f.kernel.listSubsessions(f.session.id)[0];
    assert.equal(f.store.subsessions.admit({ parentRunId: started.run.id, invocationId: first.invocationId, agentId: f.childAgent.id,
      agentRevision: f.childAgent.revision, title: "duplicate", cwd: f.directory }).id,first.id);
    f.provider.blockChildren = false;
    for (const release of f.provider.releaseChildren) release();
    await until(() => f.kernel.getRun(started.run.id).status === "completed");
    await assert.rejects(f.kernel.startRun(first.childSessionId,"reuse"),/owned|admitted/);
  });
}

async function childFailureScenario(cancel: boolean) {
  await fixture(async (f) => {
    f.provider.blockChildren = cancel;
    f.provider.failChildren = !cancel;
    const started = await f.kernel.startRun(f.session.id,"child terminal outcome");
    await approveNext(f,started.run.id);
    if (cancel) {
      await until(() => f.kernel.getRun(started.run.id).status === "waiting_children");
      f.kernel.cancelRun(f.kernel.listSubsessions(f.session.id)[0].childRunId);
    }
    await until(() => f.kernel.getRun(started.run.id).status === "completed");
    const child = f.kernel.listSubsessions(f.session.id)[0];
    assert.equal(child.status,cancel ? "cancelled" : "failed");
    assert.equal(child.acknowledged,true);
  });
}

async function spawnCancelRaceScenario() {
  await fixture(async (f) => {
    const started = await f.kernel.startRun(f.session.id,"cancel during admission");
    await until(() => f.kernel.getRun(started.run.id).status === "waiting_permission");
    let release!: () => void;
    f.providers.resolveModelContextCapability = async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { windowTokens: 32768, source: "adapter" };
    };
    await approveNext(f,started.run.id);
    await until(() => Boolean(release));
    const child = f.kernel.listSubsessions(f.session.id)[0];
    f.kernel.cancelRun(started.run.id);
    release();
    await until(() => f.kernel.listSubsessions(f.session.id)[0].result !== null);
    await new Promise((resolve) => setTimeout(resolve,20));
    assert.equal(f.store.getRun(child.childRunId)?.status,"cancelled","cancelled admission ran late");
    assert.equal(f.kernel.getRun(started.run.id).status,"cancelled");
  });
}

async function admissionFailureScenario() {
  await fixture(async (f) => {
    const started = await f.kernel.startRun(f.session.id,"admission without child run");
    await until(() => f.kernel.getRun(started.run.id).status === "waiting_permission");
    f.providers.resolveModelContextCapability = async () => { throw new Error("fixture child planning unavailable"); };
    await approveNext(f,started.run.id);
    await until(() => f.kernel.getRun(started.run.id).status === "completed");
    const child = f.kernel.listSubsessions(f.session.id)[0];
    assert.equal(child.status,"failed");
    assert.equal(f.store.getRun(child.childRunId)?.status,"failed");
    assert.equal(child.acknowledged,true);
  });
}

async function childApprovalRestartScenario(cancelAtApproval = false) {
  await fixture(async (f) => {
    f.provider.childShell = true;
    f.store.setSetting("toolSettings", { defaultAction: "ask", denyPatternsText: "", askPatternsText: "", allowPatternsText: "", shell: { defaultTimeoutMs: 60000, maxTimeoutMs: 300000, maxOutputChars: 64000 } },new Date().toISOString());
    f.kernel.updateAgentDefinition({ id: f.childAgent.id, expectedRevision: f.childAgent.revision, toolIds: ["shell.exec"], updatedAt: new Date().toISOString() });
    const started = await f.kernel.startRun(f.session.id,"child requires its own approval");
    await approveNext(f,started.run.id);
    await until(() => f.kernel.listSubsessions(f.session.id).length === 1);
    const child = f.kernel.listSubsessions(f.session.id)[0];
    await until(() => f.store.getRun(child.childRunId)?.status === "waiting_permission");
    await until(() => f.kernel.getRun(started.run.id).status === "waiting_children");
    assert.equal(f.kernel.listPermissionRequests("pending").find((p) => p.runId === child.childRunId)?.toolId,"shell.exec");
    if (cancelAtApproval) {
      const permission = f.kernel.listPermissionRequests("pending").find((p) => p.runId === child.childRunId)!;
      f.kernel.cancelRun(started.run.id);
      await until(() => f.kernel.getRun(child.childRunId).status === "cancelled");
      assert.equal(f.store.getPermissionRequest(permission.id)?.status,"expired");
      return;
    }
    await f.kernel.shutdown(1000);
    const restarted = new Kernel({ store: f.store, eventBus: new RunEventBus(), providers: f.providers, tools: f.tools, toolExecutionCwd: f.directory });
    try {
      restarted.reconcileStartupState();
      assert.equal(restarted.getRun(child.childRunId).status,"waiting_permission");
      assert.equal(restarted.getRun(started.run.id).status,"waiting_children");
      const childPermission = restarted.listPermissionRequests("pending").find((p) => p.runId === child.childRunId)!;
      await restarted.approvePermissionRequest(childPermission.id);
      await until(() => restarted.getRun(started.run.id).status === "completed");
      assert.equal(f.provider.childCalls,2,"child side-effect invocation replayed after restart");
    } finally { await restarted.shutdown(1000); }
  });
}

async function unknownAndDisabledScenario() {
  for (const unknown of [false,true]) await fixture(async (f) => {
    if (unknown) f.provider.targetAgentId = "does-not-exist";
    else f.kernel.updateAgentDefinition({ id: f.parentAgent.id, expectedRevision: f.parentAgent.revision, toolIds: [], updatedAt: new Date().toISOString() });
    const started = await f.kernel.startRun(f.session.id,"forbidden target");
    await until(() => f.kernel.getRun(started.run.id).status === "completed");
    assert.equal(f.kernel.listSubsessions(f.session.id).length,0);
    assert.equal(f.kernel.listPermissionRequests("pending").length,0);
  });
}

async function batchScenario() {
  await fixture(async (f) => {
    f.provider.batch = true;
    f.provider.childCount = 3;
    f.provider.blockChildren = true;
    const started = await f.kernel.startRun(f.session.id,"batch delegate");
    for (let i=0;i<3;i++) await approveNext(f,started.run.id);
    await until(() => f.kernel.getRun(started.run.id).status === "waiting_children");
    await until(() => f.provider.releaseChildren.length === 3);
    f.provider.releaseChildren.forEach((release) => release());
    await until(() => f.kernel.getRun(started.run.id).status === "completed");
    assert.equal(f.kernel.listSubsessions(f.session.id).length,3);
    assert.equal(f.provider.maximumParentInFlight,1);
  });
}

function migrationScenario() {
  const directory = mkdtempSync(join(tmpdir(),"subsessions-migration-"));
  const dbPath = join(directory,"legacy.db");
  try {
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY,title TEXT NOT NULL,working_directory TEXT,agent_id TEXT NOT NULL DEFAULT 'main',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,metadata_json TEXT NOT NULL DEFAULT '{}');`);
    legacy.prepare("INSERT INTO sessions(id,title,working_directory,created_at,updated_at) VALUES ('legacy-root','Root',?,?,?)").run(directory,new Date().toISOString(),new Date().toISOString());
    legacy.close();
    const store = new SQLiteStore({dbPath,defaultWorkingDirectory: directory});
    assert.equal(store.getSession("legacy-root")?.parentSessionId,null);
    assert.equal(store.subsessions.list().length,0);
    (store as unknown as {db: Database.Database}).db.close();
    const reopened = new SQLiteStore({dbPath,defaultWorkingDirectory: directory});
    assert.equal(reopened.getSession("legacy-root")?.parentSessionId,null);
    assert.ok((reopened as unknown as {db: Database.Database}).db.prepare("SELECT 1 FROM schema_migrations WHERE name='subsessions-v1'").get());
    (reopened as unknown as {db: Database.Database}).db.close();
  } finally { rmSync(directory,{recursive:true,force:true}); }
}

async function apiScenario() {
  await fixture(async (f) => {
    f.provider.blockChildren = true;
    f.provider.childCount = 5;
    const api = await startFixtureApi(f);
    const { origin } = api;
    try {
      const started = await f.kernel.startRun(f.session.id,"API children");
      for (let i=0;i<5;i++) await approveNext(f,started.run.id);
      await until(() => f.kernel.getRun(started.run.id).status === "waiting_children");
      const response = await fetch(`${origin}/api/sessions/${f.session.id}/subsessions`);
      assert.equal(response.headers.get("cache-control"),"no-store");
      const text = await response.text();
      assert.ok(!text.includes("PRIVATE_PROFILE")); assert.ok(!text.includes("credential"));
      assert.equal(f.kernel.listSubsessions(f.session.id).length,4,"capacity rejection created a queued child");
      const activeChild = f.kernel.listSubsessions(f.session.id)[0];
      const childResponse = await fetch(`${origin}/api/sessions/${activeChild.childSessionId}/runs/active`);
      assert.equal(childResponse.headers.get("cache-control"),"no-store");
      assert.equal((await childResponse.json() as Array<{status:string}>)[0].status,"running");
      const childMarkup = renderToStaticMarkup(createElement(SubsessionLinks,{parentSessionId:null,children:f.kernel.listSubsessions(f.session.id),onOpen:() => undefined,initiallyExpanded:true}));
      assert.match(childMarkup,/미완료 4\/4/);
      assert.match(childMarkup,/실행 대기열은 없고/);
      const active = await fetch(`${origin}/api/sessions/${f.session.id}/runs/active`);
      assert.equal((await active.json() as Array<{status:string}>)[0].status,"waiting_children");
      const controller = new AbortController();
      const sse = await fetch(`${origin}/api/runs/${started.run.id}/events`,{signal:controller.signal});
      const reader = sse.body!.getReader(); await reader.read(); controller.abort(); await reader.cancel().catch(() => undefined);
      assert.equal(f.kernel.getRun(started.run.id).status,"waiting_children","browser disconnect cancelled parent");
      const reconnect = await fetch(`${origin}/api/runs/${started.run.id}`);
      assert.equal((await reconnect.json() as {status:string}).status,"waiting_children");
      f.kernel.cancelRun(started.run.id);
      await until(() => f.kernel.getRun(f.kernel.listSubsessions(f.session.id)[0].childRunId).status === "cancelled");
    } finally { await api.close(); }
  });
}

async function startFixtureApi(f: ReturnType<typeof createFixture>) {
  const app = express(); app.use(express.json());
  registerApiRoutes(app, { kernel: f.kernel, providers: f.providers, store: f.store, dbPath: join(f.directory,"test.db"), openAIChatGPTAuth: {} as never,
    getToolSettings: () => defaultToolSettings,
    getDaemonStatus: () => ({ status: "ok", version: "fixture", pid: process.pid, startedAt: new Date().toISOString(), uptimeSeconds: 0, mode: "test", port: 0, dbPath: "fixture" }) });
  const server = app.listen(0,"127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening",resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve,reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function nonShellCancellationScenario(rejectAfterAbort: boolean, terminalBeforeReturn: boolean) {
  await fixture(async (f) => {
    let release: (() => void) | undefined;
    let observedAbort = false;
    let executions = 0;
    const toolId = "fixture.generic.cancel";
    f.tools.register({
      definition: { id: toolId, name: "Generic cancellation fixture", description: "Non-shell abort fixture", source: "custom", inputSchema: {}, outputSchema: {}, metadata: {} },
      executor: {
        execute: async (_input, context) => {
          executions++;
          context.signal.addEventListener("abort", () => { observedAbort = true; }, { once: true });
          await new Promise<void>((resolve) => { release = resolve; });
          if (rejectAfterAbort) throw new Error("fixture rejected after cancellation");
          return { text: "GENERIC_LATE_EXECUTOR_OUTPUT" };
        }
      }
    });
    const pending = await f.kernel.invokeTool(f.session.id,toolId,{});
    assert.equal(pending.state,"pending_permission");
    assert.equal(pending.commandOutputPartId,undefined);
    const api = await startFixtureApi(f);
    try {
      const approval = fetch(`${api.origin}/api/permissions/${pending.permissionRequest!.id}/approve`,{method:"POST"});
      await until(() => Boolean(release),"non-shell executor running through approve API");
      const cancel = await fetch(`${api.origin}/api/runs/${pending.run.id}/cancel`,{method:"POST"});
      assert.equal(cancel.status,200);
      assert.equal((await cancel.json() as { status: string }).status,"cancelling");
      assert.equal(observedAbort,true);
      let terminalMessage, terminalEvents;
      if (terminalBeforeReturn) {
        await f.kernel.shutdown(0);
        assert.equal(f.kernel.getRun(pending.run.id).status,"cancelled");
        terminalMessage = f.store.getMessage(pending.message.id);
        terminalEvents = f.kernel.listRunEvents(pending.run.id);
      }
      release!();
      const response = await approval;
      assert.equal(response.status,200,`generic approval HTTP rejected after abort (${rejectAfterAbort ? "reject" : "resolve"})`);
      const body = await response.json() as InvokeToolResponse;
      assert.equal(body.run.status,"cancelled");
      assert.equal(body.invocation.status,"cancelled");
      assert.equal(body.result?.status,"cancelled");
      assert.equal(executions,1);
      assert.equal(f.kernel.listRunEvents(pending.run.id).filter((event) => ["run_cancelled","run_completed","run_failed","run_interrupted"].includes(event.type)).length,1);
      const message = f.store.getMessage(pending.message.id)!;
      assert.equal(message.parts.find((part) => part.id === pending.toolCallPartId)?.content.status,"cancelled");
      assert.equal(message.parts.some((part) => part.type === "command_output"),false);
      if (terminalBeforeReturn) {
        assert.deepEqual(message,terminalMessage,"late executor wrote a part after terminal CAS");
        assert.deepEqual(f.kernel.listRunEvents(pending.run.id),terminalEvents,"late executor emitted an event after terminal CAS");
        assert.equal(body.toolResultPartId,undefined);
      } else {
        const resultPart = message.parts.find((part) => part.id === body.toolResultPartId);
        assert.equal(resultPart?.type,"tool_result");
        assert.equal(resultPart?.content.status,"cancelled","cancelling path lost canonical cancelled tool result");
      }
      f.kernel.cancelRun(pending.run.id);
      assert.deepEqual(f.store.getMessage(pending.message.id),message,"idempotent cancel caused late writes");
    } finally { release?.(); await api.close(); }
  });
}

async function childResultRedactionScenario() {
  await fixture(async (f) => {
    const secrets = {
      access_token: "FAKE_ACCESS_VALUE_ONLY_91cd",
      refresh_token: "FAKE_REFRESH_VALUE_ONLY_27ab",
      api_key: "FAKE_API_KEY_VALUE_ONLY_64ef",
      authorization: "Bearer FAKE_BEARER_VALUE_ONLY_8a10"
    };
    const secretValues = [secrets.access_token,secrets.refresh_token,secrets.api_key,"FAKE_BEARER_VALUE_ONLY_8a10"];
    f.provider.childOutput = JSON.stringify(secrets);
    const started = await f.kernel.startRun(f.session.id,"return a safe child result");
    await approveNext(f,started.run.id);
    await until(() => f.kernel.getRun(started.run.id).status === "completed");
    const child = f.kernel.listSubsessions(f.session.id)[0];
    const api = await startFixtureApi(f);
    try {
      const response = await fetch(`${api.origin}/api/sessions/${f.session.id}/subsessions`);
      assert.equal(response.headers.get("cache-control"),"no-store");
      const apiText = await response.text();
      const canonicalResultRow = (f.store as unknown as { db: Database.Database }).db.prepare("SELECT result FROM subsession_delegations WHERE id=?").get(child.id) as { result: string };
      const handoff = f.store.listMessages(f.session.id).flatMap((message) => message.parts).find((part) => part.id === child.deliveredPartId)!;
      const actualParentInputs = JSON.stringify(f.provider.inputs.filter((input) => input.session.id === f.session.id).map((input) => input.context));
      const nextContext = JSON.stringify((await f.kernel.previewContext(f.session.id,{text:"next"})).context);
      for (const secret of secretValues) {
        for (const projection of [canonicalResultRow.result, JSON.stringify(child), apiText, JSON.stringify(handoff), actualParentInputs, nextContext]) {
          assert.equal(projection.includes(secret),false,`child result leaked ${secret}`);
        }
      }
      assert.equal(canonicalResultRow.result,child.result);
      assert.equal(JSON.parse(String(handoff.content.outputSummary)).result,child.result);
      assert.match(canonicalResultRow.result,/\[REDACTED\]/);
      const originalChildTranscript = JSON.stringify(f.store.listMessages(child.childSessionId));
      assert.ok(originalChildTranscript.includes(secrets.access_token),"redaction rewrote the existing raw child transcript policy");
    } finally { await api.close(); }
  });
}

async function cancelledToolOnlyFactsScenario() {
  await fixture(async (f) => {
    f.provider.childShell=true; f.provider.blockChildren=true;
    f.kernel.updateAgentDefinition({id:f.childAgent.id,expectedRevision:f.childAgent.revision,toolIds:["shell.exec"],updatedAt:new Date().toISOString()});
    const started=await f.kernel.startRun(f.session.id,"interrupt child after its tool succeeded");
    await approveNext(f,started.run.id);
    await until(()=>f.provider.releaseChildren.length===1,"child follow-up provider after successful tool");
    const child=f.kernel.listSubsessions(f.session.id)[0];
    const childCalls=f.provider.inputs.filter((input)=>input.session.id===child.childSessionId).length;
    assert.equal(childCalls,2);
    f.kernel.cancelRun(child.childRunId);
    await until(()=>f.kernel.getRun(started.run.id).status==="completed");
    const terminal=f.kernel.listSubsessions(f.session.id)[0];
    assert.equal(terminal.status,"cancelled");
    assert.match(terminal.result!,/Assistant answer: none/);
    assert.match(terminal.result!,/completed=1/);
    assert.match(terminal.result!,/FAKE_COMPLETED_TOOL_PROGRESS_SENTINEL/);
    assert.match(terminal.result!,/not a successful completion/);
    assert.equal(f.provider.inputs.filter((input)=>input.session.id===child.childSessionId).length,childCalls,"cancel added a child summary/model call");
    assert.equal(f.provider.inputs.some((input)=>input.context.systemPrompt.includes("cumulative continuity summary")),false);
    assert.ok(f.provider.inputs.filter((input)=>input.session.id===f.session.id).at(-1)!.context.messages.some((message)=>message.content.includes("completed=1")&&message.content.includes("FAKE_COMPLETED_TOOL_PROGRESS_SENTINEL")));
  });
}

async function parentScopedChildHttpScenario(action:"approve"|"deny") {
  await fixture(async (f) => {
    f.provider.childShell=true; f.provider.blockChildren=true;
    f.kernel.updateAgentDefinition({id:f.childAgent.id,expectedRevision:f.childAgent.revision,toolIds:["shell.exec"],updatedAt:new Date().toISOString()});
    f.store.setSetting("toolSettings",{...defaultToolSettings,defaultAction:"ask"} as never,new Date().toISOString());
    const started=await f.kernel.startRun(f.session.id,"child approval from parent view");
    await approveNext(f,started.run.id);
    await until(()=>f.kernel.listSubsessions(f.session.id).some((child)=>child.status==="waiting_permission")&&f.kernel.getRun(started.run.id).status==="waiting_children");
    const child=f.kernel.listSubsessions(f.session.id)[0];
    const api=await startFixtureApi(f);
    const parentMessages=f.kernel.listMessages(f.session.id);
    const tracking={activeRunId:started.run.id,eventSourceRunId:started.run.id,selectedSessionId:f.session.id,model:"parent",provider:"parent",messages:parentMessages};
    const trackingBefore=JSON.stringify(tracking);
    const controller=new ChildActionsController(f.session.id,started.run.id,()=>true,()=>undefined,
      ((url:string,init?:RequestInit)=>requestJson(`${api.origin}${url}`,init)) as typeof requestJson);
    try {
      await controller.refresh();
      assert.equal(controller.view.permissions.length,1);
      const permission=controller.view.permissions[0];
      assert.equal(permission.runId,child.childRunId);
      await controller.permission(permission.id,action);
      await until(()=>f.provider.releaseChildren.length===1);
      assert.equal(controller.view.permissions.length,0);
      assert.equal(controller.view.children[0].status,"running","approval was mistaken for child completion");
      assert.equal(f.kernel.getRun(started.run.id).status,"waiting_children");
      assert.deepEqual(f.kernel.listMessages(f.session.id),parentMessages,"child response appeared in root messages");
      assert.equal(JSON.stringify(tracking),trackingBefore,"child action replaced parent tracking/model/provider state");
      await controller.cancel(child.childRunId);
      await until(()=>f.kernel.getRun(started.run.id).status==="completed");
      assert.equal(f.kernel.getRun(child.childRunId).status,"cancelled");
      assert.equal(JSON.stringify(tracking),trackingBefore);
    } finally {controller.dispose();await api.close();}
  });
}

async function snapshotAndCancellationScopeScenario() {
  await fixture(async (f) => {
    f.provider.blockChildren = true;
    const started = await f.kernel.startRun(f.session.id,"preserve profiles and cwd");
    await approveNext(f,started.run.id);
    await until(() => f.kernel.getRun(started.run.id).status === "waiting_children");
    await until(() => f.provider.releaseChildren.length === 1);
    const child = f.kernel.listSubsessions(f.session.id)[0];
    const editedParent = f.kernel.updateAgentDefinition({id:f.parentAgent.id,expectedRevision:f.parentAgent.revision,systemPrompt:"NEW_PARENT",toolIds:[],updatedAt:new Date().toISOString()});
    const editedChild = f.kernel.updateAgentDefinition({id:f.childAgent.id,expectedRevision:f.childAgent.revision,systemPrompt:"NEW_CHILD",toolIds:[],updatedAt:new Date().toISOString()});
    f.kernel.updateSession(f.session.id,{ agentId:"main", workingDirectory:tmpdir() });
    f.kernel.updateSession(child.childSessionId,{ agentId:"main", workingDirectory:tmpdir() });
    f.kernel.deleteAgentDefinition(editedParent.id,editedParent.revision);
    f.kernel.deleteAgentDefinition(editedChild.id,editedChild.revision);
    f.provider.releaseChildren[0]();
    await until(() => f.kernel.getRun(started.run.id).status === "completed");
    const lastParent = f.provider.inputs.filter((input) => input.session.id === f.session.id).at(-1)!;
    assert.match(lastParent.context.systemPrompt,/PARENT_PRIVATE_PROFILE/);
    assert.equal(lastParent.context.workingDirectory,f.directory);
    assert.ok(lastParent.context.availableTools.some((tool) => tool.id === "subsession.start"));
    assert.match(f.provider.inputs.find((input) => input.session.id === child.childSessionId)!.context.systemPrompt,/CHILD_PRIVATE_PROFILE/);
    // An unrelated future run in that session is not owned by the original parent.
    const later = f.store.createRun({id:"unrelated-later-run",sessionId:child.childSessionId,provider:"mock",status:"running",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    f.kernel.cancelRun(started.run.id);
    assert.equal(f.store.getRun(later.id)?.status,"running");
    f.kernel.cancelRun(later.id);
  });
}

async function delayedNavigationScenario() {
  for (const targetId of ["child-target","parent-target"]) {
    for (const invalidation of ["session-switch","newer-request","profile-change","cwd-change","none"]) {
      let sessionId = "source", generation = 1, requestId = 1, agentMutation = 0, cwdMutation = 0;
      let model = "source-model", provider = "source-provider", profile = "source-profile";
      let appliedSnapshots = 0, errors = 0;
      let resolveLoad!: (sessions: Session[]) => void;
      const loading = new Promise<Session[]>((resolve) => { resolveLoad = resolve; });
      const navigate = navigateToRelatedSession({
        targetId,
        load: () => loading,
        isCurrent: () => sessionId === "source" && generation === 1 && requestId === 1 && agentMutation === 0 && cwdMutation === 0,
        apply: (_sessions,id) => { appliedSnapshots++; sessionId = id; model = "target-model"; provider = "target-provider"; profile = "target-profile"; },
        onError: () => { errors++; }
      });
      if (invalidation === "session-switch") {
        sessionId = "user-selected-other-session"; generation++;
        model = "other-model"; provider = "other-provider"; profile = "other-profile";
      } else if (invalidation === "newer-request") requestId++;
      else if (invalidation === "profile-change") { agentMutation++; profile = "edited-profile"; }
      else if (invalidation === "cwd-change") cwdMutation++;
      const before = { sessionId,model,provider,profile };
      resolveLoad([{ id: targetId } as Session]);
      await navigate;
      assert.equal(errors,0);
      if (invalidation === "none") { assert.equal(sessionId,targetId); assert.equal(appliedSnapshots,1); }
      else {
        assert.equal(appliedSnapshots,0,`${targetId} applied stale session snapshot after ${invalidation}`);
        assert.deepEqual({sessionId,model,provider,profile},before,`${targetId} stale callback navigated back or changed bindings`);
      }
    }
    let current = true, errors = 0;
    let rejectLoad!: (error: Error) => void;
    const failedLoad = new Promise<Session[]>((_resolve,reject) => { rejectLoad = reject; });
    const pending = navigateToRelatedSession({ targetId, load: () => failedLoad, isCurrent: () => current,
      apply: () => assert.fail("failed navigation applied a snapshot"), onError: () => { errors++; } });
    current = false;
    rejectLoad(new Error("delayed stale load failure"));
    await pending;
    assert.equal(errors,0,"stale navigation failure overwrote current-session UI error");
  }
}

await successScenario(false,1);
await successScenario(true,2);
await cancelScenario();
await permissionBoundaryScenario();
await restartScenario(false);
await restartScenario(true);
await restartScenario(false,true);
await authorityAndLimitsScenario();
await childFailureScenario(false);
await childFailureScenario(true);
await spawnCancelRaceScenario();
await admissionFailureScenario();
await childApprovalRestartScenario();
await childApprovalRestartScenario(true);
await unknownAndDisabledScenario();
migrationScenario();
await batchScenario();
await apiScenario();
await snapshotAndCancellationScopeScenario();
for (const rejects of [false,true]) for (const alreadyTerminal of [false,true]) await nonShellCancellationScenario(rejects,alreadyTerminal);
await childResultRedactionScenario();
await cancelledToolOnlyFactsScenario();
await parentScopedChildHttpScenario("approve");
await parentScopedChildHttpScenario("deny");
await delayedNavigationScenario();
await admissionScenarios();
await childActionScenarios();
console.log("Subsessions smoke passed: handoff identity/content through deltas/restart/history/compaction; real non-shell approve/cancel HTTP; canonical result redaction; stale child/parent navigation guards; admission/wake/permission regressions.");
