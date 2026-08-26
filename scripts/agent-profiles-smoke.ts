import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunInspector, type RunInspectorProps } from "../src/client/RunInspector";
import {
  agentToolIds,
  isAgentProfileDraftDirty,
  isCurrentAgentProfileMutation,
  SettingsPanel,
  type AgentProfileDraft
} from "../src/client/SettingsPanel";
import {
  advertisedReasoningEfforts,
  catalogSelectionWarnings,
  profileDefaultsApplyToProvider,
  reconcileModelOverride,
  reconcileReasoningEffort
} from "../src/client/model-catalog";
import { mergeSessionMutation } from "../src/client/session-mutations";
import { RunEventBus } from "../src/kernel/event-bus";
import { Kernel, KernelError } from "../src/kernel/kernel";
import type { ProviderRegistry } from "../src/providers/registry";
import type { ProviderAdapter, ProviderCredential, ProviderRunContext, ProviderRunInput } from "../src/providers/types";
import { registerApiRoutes } from "../src/server/routes";
import { defaultToolSettings, toolSettingsSettingKey } from "../src/shared/tool-settings";
import type {
  AgentDefinition,
  ContextPreviewResponse,
  JsonObject,
  ProviderListResponse,
  ProviderModelCatalog,
  ProviderProfile,
  ProviderResolution,
  ProviderTestResponse,
  Session,
  ToolSettings
} from "../src/shared/types";
import { SQLiteStore } from "../src/store/sqlite";
import { ToolRegistry } from "../src/tools/registry";

const fixtureTime = "2026-08-04T00:00:00.000Z";
const oldPromptSentinel = "INTERNAL_AGENT_SNAPSHOT_SENTINEL_8c41d7";

async function migrationScenario(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "agent-platform-agent-migration-"));
  const dbPath = join(directory, "legacy.db");
  try {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE agent_definitions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        system_prompt TEXT NOT NULL,
        model_profile_id TEXT,
        default_run_options_json TEXT NOT NULL DEFAULT '{}',
        skill_ids_json TEXT NOT NULL DEFAULT '[]',
        tool_ids_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO sessions (id, title, created_at, updated_at, metadata_json)
      VALUES ('legacy-session', 'Legacy session', '${fixtureTime}', '${fixtureTime}', '{}');
      INSERT INTO agent_definitions (
        id, name, description, system_prompt, model_profile_id, default_run_options_json,
        skill_ids_json, tool_ids_json, metadata_json, created_at, updated_at
      ) VALUES (
        'main', 'Legacy Mango', NULL, 'Legacy prompt', NULL, '{}', '[]', '[]',
        '{"legacyLabel":"preserve"}', '${fixtureTime}', '${fixtureTime}'
      );
    `);
    legacy.close();

    const migrated = new SQLiteStore({ dbPath, defaultWorkingDirectory: directory });
    assert.equal(migrated.getSession("legacy-session")?.agentId, "main", "legacy sessions were not bound to main");
    assert.equal(migrated.getSession("legacy-session")?.workingDirectory, directory);
    const migratedMain = migrated.getAgentDefinition("main");
    assert.equal(migratedMain?.revision, 1);
    assert.deepEqual(migratedMain?.toolIds, ["shell.exec"], "legacy main did not receive its one-time explicit allowlist");
    assert.equal(migratedMain?.metadata.explicitToolAllowlistVersion, undefined);
    assert.equal(migratedMain?.metadata.legacyLabel, "preserve");
    const emptiedMainResult = migrated.updateAgentDefinition({
      id: "main",
      expectedRevision: migratedMain!.revision,
      toolIds: [],
      metadata: { userLabel: "metadata replacement must not reset migration" },
      updatedAt: new Date().toISOString()
    });
    assert.equal(emptiedMainResult.status, "updated");
    assert.deepEqual(emptiedMainResult.status === "updated" ? emptiedMainResult.agent.toolIds : null, []);
    assert.equal(emptiedMainResult.status === "updated" ? emptiedMainResult.agent.revision : null, 2);
    closeStore(migrated);

    const migrationDatabase = new Database(dbPath);
    const migrationRows = migrationDatabase
      .prepare("SELECT name FROM schema_migrations WHERE name = ?")
      .all("agent_main_explicit_tool_allowlist_v1");
    assert.equal(migrationRows.length, 1, "the one-time migration was not recorded in Store-owned schema state");
    migrationDatabase.close();

    const restarted = new SQLiteStore({ dbPath, defaultWorkingDirectory: directory });
    assert.deepEqual(restarted.getAgentDefinition("main")?.toolIds, [], "an explicit empty allowlist was overwritten on restart");
    assert.equal(restarted.getAgentDefinition("main")?.revision, 2);
    assert.deepEqual(restarted.getAgentDefinition("main")?.metadata, {
      userLabel: "metadata replacement must not reset migration"
    });
    closeStore(restarted);

    const previousMarkerDbPath = join(directory, "previous-marker.db");
    const previousMarkerDatabase = new Database(previousMarkerDbPath);
    previousMarkerDatabase.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        working_directory TEXT,
        agent_id TEXT NOT NULL DEFAULT 'main',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE agent_definitions (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 1,
        name TEXT NOT NULL,
        description TEXT,
        system_prompt TEXT NOT NULL,
        model_profile_id TEXT,
        default_run_options_json TEXT NOT NULL DEFAULT '{}',
        skill_ids_json TEXT NOT NULL DEFAULT '[]',
        tool_ids_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO agent_definitions (
        id, revision, name, description, system_prompt, model_profile_id, default_run_options_json,
        skill_ids_json, tool_ids_json, metadata_json, created_at, updated_at
      ) VALUES (
        'main', 4, 'Mango', NULL, 'Prompt', NULL, '{}', '[]', '[]',
        '{"explicitToolAllowlistVersion":1,"userLabel":"already migrated"}', '${fixtureTime}', '${fixtureTime}'
      );
    `);
    previousMarkerDatabase.close();
    const previousMarkerStore = new SQLiteStore({ dbPath: previousMarkerDbPath, defaultWorkingDirectory: directory });
    assert.deepEqual(
      previousMarkerStore.getAgentDefinition("main")?.toolIds,
      [],
      "the Store-owned migration did not honor the previous one-time marker for an explicit empty allowlist"
    );
    assert.deepEqual(previousMarkerStore.getAgentDefinition("main")?.metadata, { userLabel: "already migrated" });
    assert.equal(previousMarkerStore.getAgentDefinition("main")?.revision, 4);
    closeStore(previousMarkerStore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function profileRuntimeAndApiScenario(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "agent-platform-agent-profiles-"));
  const dbPath = join(directory, "profiles.db");
  try {
    const provider = new RecordingProvider();
    const providerFixture = createFixtureProviderRegistry(provider);
    const providers = providerFixture.registry;
    const executions: Array<{ command: string; cwd: string }> = [];
    const tools = createFixtureToolRegistry(executions);
    let store = new SQLiteStore({ dbPath, defaultWorkingDirectory: directory });
    let kernel = createKernel(store, providers, tools, directory);
    assert.deepEqual(kernel.getAgentDefinition("main").toolIds, ["shell.exec"]);
    assert.equal(kernel.getAgentDefinition("main").metadata.explicitToolAllowlistVersion, undefined);

    const api = await startFixtureApi(kernel, providers, store, dbPath);
    let profile: AgentDefinition;
    let session: Session;
    try {
      const created = await api.request<AgentDefinition>("/api/agents", {
        method: "POST",
        body: {
          name: "Snapshot Agent",
          description: "Fixture profile",
          systemPrompt: oldPromptSentinel,
          modelProfileId: "fixture-a",
          defaultRunOptions: { reasoningEffort: "fixture-reasoning", temperature: 0.3 },
          toolIds: ["shell.exec"],
          skillIds: ["future-skill"],
          metadata: { userLabel: "created metadata" }
        }
      });
      assert.equal(created.status, 201);
      assert.equal(created.cacheControl, "no-store");
      profile = created.body;
      assert.equal(profile.revision, 1);
      assert.deepEqual(profile.metadata, { userLabel: "created metadata" });

      const listed = await api.request<{ agents: AgentDefinition[]; defaultAgentId: string }>("/api/agents");
      assert.equal(listed.status, 200);
      assert.equal(listed.cacheControl, "no-store");
      assert.equal(listed.body.defaultAgentId, "main");
      assert.ok(listed.body.agents.some((agent) => agent.id === profile.id));
      const fetched = await api.request<AgentDefinition>(`/api/agents/${profile.id}`);
      assert.equal(fetched.body.id, profile.id);
      assert.equal(fetched.body.systemPrompt, oldPromptSentinel);

      const patched = await api.request<AgentDefinition>(`/api/agents/${profile.id}`, {
        method: "PATCH",
        body: { expectedRevision: profile.revision, description: "Updated fixture description" }
      });
      assert.equal(patched.status, 200);
      assert.equal(patched.body.revision, 2);
      assert.equal(patched.body.description, "Updated fixture description");
      profile = patched.body;

      const noOp = await api.request<AgentDefinition>(`/api/agents/${profile.id}`, {
        method: "PATCH",
        body: { expectedRevision: profile.revision }
      });
      assert.equal(noOp.status, 200);
      assert.equal(noOp.body.revision, profile.revision, "an empty PATCH advanced the revision");
      const missingRevision = await api.request<{ error: string }>(`/api/agents/${profile.id}`, {
        method: "PATCH",
        body: { description: "must be rejected" }
      });
      assert.equal(missingRevision.status, 400);

      const stalePatch = await api.request<{ error: string; latest: { id: string; revision: number } }>(`/api/agents/${profile.id}`, {
        method: "PATCH",
        body: { expectedRevision: 1, name: "Stale tab overwrite" }
      });
      assert.equal(stalePatch.status, 409);
      assert.equal(stalePatch.body.error, "agent_revision_conflict");
      assert.deepEqual(stalePatch.body.latest, {
        id: profile.id,
        name: profile.name,
        revision: profile.revision,
        updatedAt: profile.updatedAt
      });
      assert.equal((await api.request<AgentDefinition>(`/api/agents/${profile.id}`)).body.name, profile.name);

      const rejectedCredentialMetadata = await api.request<{ error: string; message: string }>(`/api/agents/${profile.id}`, {
        method: "PATCH",
        body: { expectedRevision: profile.revision, metadata: { credential: "FAKE_SECRET_SENTINEL_MUST_NOT_BE_STORED" } }
      });
      assert.equal(rejectedCredentialMetadata.status, 400);
      assert.equal(JSON.stringify(rejectedCredentialMetadata.body).includes("FAKE_SECRET_SENTINEL_MUST_NOT_BE_STORED"), false);
      const rejectedReservedMetadata = await api.request<{ error: string }>(`/api/agents/${profile.id}`, {
        method: "PATCH",
        body: { expectedRevision: profile.revision, metadata: { explicitToolAllowlistVersion: 99 } }
      });
      assert.equal(rejectedReservedMetadata.status, 400);
      const rejectedCreateReservedMetadata = await api.request<{ error: string }>("/api/agents", {
        method: "POST",
        body: { name: "Reserved Metadata Agent", systemPrompt: "fixture", metadata: { _internal: true } }
      });
      assert.equal(rejectedCreateReservedMetadata.status, 400);

      const duplicate = await api.request<{ error: string }>("/api/agents", {
        method: "POST",
        body: { name: " snapshot agent ", systemPrompt: "duplicate" }
      });
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.body.error, "duplicate_agent_name");

      const invalid = await api.request<{ error: string }>("/api/agents", {
        method: "POST",
        body: { name: "bad\u0000name", systemPrompt: "fixture" }
      });
      assert.equal(invalid.status, 400);

      const unknownProvider = await api.request<{ error: string }>("/api/agents", {
        method: "POST",
        body: { name: "Unknown Provider Agent", systemPrompt: "fixture", modelProfileId: "missing-provider" }
      });
      assert.equal(unknownProvider.status, 400);
      assert.equal(unknownProvider.body.error, "unknown_provider_profile");

      const unknownTool = await api.request<{ error: string }>("/api/agents", {
        method: "POST",
        body: { name: "Unknown Tool Agent", systemPrompt: "fixture", toolIds: ["missing.tool"] }
      });
      assert.equal(unknownTool.status, 400);
      assert.equal(unknownTool.body.error, "unknown_tool");

      const createdSession = await api.request<Session>("/api/sessions", {
        method: "POST",
        body: { title: "Profile-bound session", workingDirectory: directory, agentId: profile.id }
      });
      assert.equal(createdSession.status, 201);
      assert.equal(createdSession.cacheControl, "no-store");
      session = createdSession.body;
      assert.equal(session.agentId, profile.id);

      const reboundMain = await api.request<Session>(`/api/sessions/${session.id}`, {
        method: "PATCH",
        body: { agentId: "main" }
      });
      assert.equal(reboundMain.body.agentId, "main");
      const reboundProfile = await api.request<Session>(`/api/sessions/${session.id}`, {
        method: "PATCH",
        body: { agentId: profile.id }
      });
      assert.equal(reboundProfile.body.agentId, profile.id);

      const fetchedSession = await api.request<Session>(`/api/sessions/${session.id}`);
      assert.equal(fetchedSession.body.agentId, profile.id);
      assert.equal(fetchedSession.cacheControl, "no-store");
      const preview = await api.request<ContextPreviewResponse>(`/api/sessions/${session.id}/context/preview`, {
        method: "POST",
        body: {}
      });
      assert.equal(preview.status, 200);
      assert.equal(preview.cacheControl, "no-store");
      assert.equal(preview.body.context.agent.id, profile.id);

      const badBinding = await api.request<{ error: string }>(`/api/sessions/${session.id}`, {
        method: "PATCH",
        body: { agentId: "missing-agent" }
      });
      assert.equal(badBinding.status, 404);

      const staleClone = await api.request<{ error: string }>(`/api/agents/${profile.id}/clone`, {
        method: "POST",
        body: { expectedRevision: 1 }
      });
      assert.equal(staleClone.status, 409);
      assert.equal(staleClone.body.error, "agent_revision_conflict");

      const clone = await api.request<AgentDefinition>(`/api/agents/${profile.id}/clone`, {
        method: "POST",
        body: { expectedRevision: profile.revision }
      });
      assert.equal(clone.status, 201);
      assert.notEqual(clone.body.id, profile.id);
      assert.match(clone.body.name, /^Snapshot Agent Copy/);
      assert.deepEqual(clone.body.toolIds, ["shell.exec"]);
      assert.deepEqual(clone.body.metadata, profile.metadata);
      const deletedClone = await api.request<void>(`/api/agents/${clone.body.id}`, {
        method: "DELETE",
        body: { expectedRevision: clone.body.revision }
      });
      assert.equal(deletedClone.status, 204);
      assert.equal(deletedClone.cacheControl, "no-store");

      const longNameProfile = await api.request<AgentDefinition>("/api/agents", {
        method: "POST",
        body: { name: "L".repeat(120), systemPrompt: "long-name clone fixture" }
      });
      assert.equal(longNameProfile.status, 201);
      const longNameClone = await api.request<AgentDefinition>(`/api/agents/${longNameProfile.body.id}/clone`, {
        method: "POST",
        body: { expectedRevision: longNameProfile.body.revision }
      });
      assert.equal(longNameClone.status, 201);
      assert.ok(longNameClone.body.name.length <= 120);
      assert.match(longNameClone.body.name, / Copy$/);
      await api.request<void>(`/api/agents/${longNameClone.body.id}`, {
        method: "DELETE",
        body: { expectedRevision: longNameClone.body.revision }
      });
      const longNameUpdated = await api.request<AgentDefinition>(`/api/agents/${longNameProfile.body.id}`, {
        method: "PATCH",
        body: { expectedRevision: longNameProfile.body.revision, description: "revision changed before stale delete" }
      });
      const staleDelete = await api.request<{ error: string; latest: { revision: number } }>(
        `/api/agents/${longNameProfile.body.id}`,
        { method: "DELETE", body: { expectedRevision: longNameProfile.body.revision } }
      );
      assert.equal(staleDelete.status, 409);
      assert.equal(staleDelete.body.error, "agent_revision_conflict");
      assert.equal(staleDelete.body.latest.revision, longNameUpdated.body.revision);
      await api.request<void>(`/api/agents/${longNameProfile.body.id}`, {
        method: "DELETE",
        body: { expectedRevision: longNameUpdated.body.revision }
      });
      assert.throws(
        () =>
          store.createSession({
            id: "orphan-session-fixture",
            title: "must not be inserted",
            workingDirectory: directory,
            agentId: longNameProfile.body.id,
            createdAt: fixtureTime,
            updatedAt: fixtureTime
          }),
        /session_agent_not_found/
      );

      const mainProfile = (await api.request<AgentDefinition>("/api/agents/main")).body;
      const protectedMain = await api.request<{ error: string }>("/api/agents/main", {
        method: "DELETE",
        body: { expectedRevision: mainProfile.revision }
      });
      assert.equal(protectedMain.status, 409);
      assert.equal(protectedMain.body.error, "main_agent_protected");

      const inUse = await api.request<{ error: string; usage: { sessionCount: number; sessions: Array<{ id: string }> } }>(
        `/api/agents/${profile.id}`,
        { method: "DELETE", body: { expectedRevision: profile.revision } }
      );
      assert.equal(inUse.status, 409);
      assert.equal(inUse.body.error, "agent_in_use");
      assert.equal(inUse.body.usage.sessionCount, 1);
      assert.deepEqual(inUse.body.usage.sessions.map((item) => item.id), [session.id]);
    } finally {
      await api.close();
    }

    closeStore(store);
    store = new SQLiteStore({ dbPath, defaultWorkingDirectory: directory });
    kernel = createKernel(store, providers, tools, directory);
    const restoredSession = kernel.getSession(session!.id);
    assert.equal(restoredSession.agentId, profile!.id, "session profile binding did not survive SQLite reload");
    profile = kernel.getAgentDefinition(profile!.id);

    const raceSession = kernel.createSession({ title: "Session field race", workingDirectory: directory, agentId: "main" });
    const firstAgentPatch = store.updateSession(raceSession.id, {
      agentId: profile.id,
      updatedAt: "2026-08-04T00:00:01.000Z"
    });
    assert.equal(firstAgentPatch?.agentId, profile.id);
    const laterCwdPatch = store.updateSession(raceSession.id, {
      workingDirectory: "/reverse-completion-cwd",
      updatedAt: "2026-08-04T00:00:02.000Z"
    });
    assert.equal(laterCwdPatch?.agentId, profile.id);
    assert.equal(laterCwdPatch?.workingDirectory, "/reverse-completion-cwd");
    store.updateSession(raceSession.id, { agentId: "main", workingDirectory: directory, updatedAt: new Date().toISOString() });
    const firstCwdPatch = store.updateSession(raceSession.id, {
      workingDirectory: "/opposite-order-cwd",
      updatedAt: "2026-08-04T00:00:03.000Z"
    });
    assert.equal(firstCwdPatch?.workingDirectory, "/opposite-order-cwd");
    const laterAgentPatch = store.updateSession(raceSession.id, {
      agentId: profile.id,
      updatedAt: "2026-08-04T00:00:04.000Z"
    });
    assert.equal(laterAgentPatch?.agentId, profile.id);
    assert.equal(laterAgentPatch?.workingDirectory, "/opposite-order-cwd");
    store.updateSession(raceSession.id, { agentId: "main", workingDirectory: directory, updatedAt: new Date().toISOString() });

    const defaultPreview = kernel.previewContext(restoredSession.id);
    assert.equal(defaultPreview.context.agent.id, profile.id);
    assert.ok(defaultPreview.context.systemPrompt.startsWith(oldPromptSentinel));
    assert.equal(defaultPreview.providerResolution.providerProfileId, "fixture-a");
    assert.deepEqual(defaultPreview.context.availableTools.map((tool) => tool.id), ["shell.exec"]);
    assert.deepEqual(defaultPreview.context.runOptions, { model: "provider-a-model", temperature: 0.3 });
    assert.deepEqual(defaultPreview.requestedRunOptions, {
      reasoningEffort: "fixture-reasoning",
      temperature: 0.3
    });

    const crossProviderPreview = kernel.previewContext(restoredSession.id, { providerProfileId: "fixture-b" });
    assert.equal(crossProviderPreview.context.agent.id, profile.id);
    assert.deepEqual(crossProviderPreview.requestedRunOptions, {});
    assert.deepEqual(crossProviderPreview.context.runOptions, { model: "provider-b-model" });
    assert.ok(crossProviderPreview.warnings.some((warning) => warning.includes("different provider profile")));

    const explicitPreview = kernel.previewContext(restoredSession.id, {
      providerProfileId: "fixture-b",
      runOptions: { model: "per-run-model", temperature: 0.8 }
    });
    assert.equal(explicitPreview.context.agent.id, profile.id);
    assert.equal(explicitPreview.providerResolution.providerProfileId, "fixture-b");
    assert.deepEqual(explicitPreview.context.availableTools.map((tool) => tool.id), ["shell.exec"]);
    assert.deepEqual(explicitPreview.context.runOptions, { model: "per-run-model", temperature: 0.8 });
    const explicitAgentPreview = kernel.previewContext(restoredSession.id, { agentId: "main" });
    assert.equal(explicitAgentPreview.context.agent.id, "main", "explicit run agent did not override the session binding");

    const crossProviderRun = kernel.startRun(restoredSession.id, "[complete] cross-provider defaults", {
      providerProfileId: "fixture-b"
    });
    await waitForRunStatus(kernel, crossProviderRun.run.id, "completed");
    const [crossProviderInput] = provider.inputsForRun(crossProviderRun.run.id);
    assert.equal(crossProviderInput.providerProfileId, "fixture-b");
    assert.deepEqual(crossProviderInput.requestedRunOptions, {});
    assert.deepEqual(crossProviderInput.runOptions, { model: "provider-b-model" });

    store.setSetting(toolSettingsSettingKey, fixtureToolSettings("ask"), new Date().toISOString());
    const started = kernel.startRun(restoredSession.id, "[request-tool] preserve the profile snapshot");
    assert.equal(started.agentId, profile.id);
    await waitForRunStatus(kernel, started.run.id, "waiting_permission");
    const internalBeforeMutation = store.getRun(started.run.id);
    assert.ok(internalBeforeMutation);
    assert.equal((internalBeforeMutation.metadata.agentSnapshot as JsonObject).systemPrompt, oldPromptSentinel);
    assert.equal((internalBeforeMutation.metadata.agentSnapshot as JsonObject).revision, profile.revision);
    assert.deepEqual((internalBeforeMutation.metadata.agentSnapshot as JsonObject).skillIds, ["future-skill"]);
    assert.deepEqual((internalBeforeMutation.metadata.executionSnapshot as JsonObject).runOptions, {
      model: "provider-a-model",
      temperature: 0.3
    });

    const updated = kernel.updateAgentDefinition({
      id: profile.id,
      expectedRevision: profile.revision,
      name: "Snapshot Agent Updated",
      systemPrompt: "NEW_PROFILE_PROMPT",
      modelProfileId: "fixture-b",
      defaultRunOptions: { model: "profile-new-model", temperature: 0.6 },
      toolIds: [],
      updatedAt: new Date().toISOString()
    });
    assert.equal(updated.revision, profile.revision + 1);
    assert.deepEqual(updated.toolIds, []);

    providerFixture.setModel("fixture-a", "provider-a-model-after-restart");

    await kernel.shutdown(100);
    closeStore(store);
    store = new SQLiteStore({ dbPath, defaultWorkingDirectory: directory });
    kernel = createKernel(store, providers, tools, directory);
    assert.equal(kernel.getRun(started.run.id).status, "waiting_permission");
    const persistedSnapshot = store.getRun(started.run.id)?.metadata.agentSnapshot as JsonObject;
    assert.equal(persistedSnapshot.systemPrompt, oldPromptSentinel);
    assert.equal(persistedSnapshot.revision, profile.revision);

    const [permission] = kernel.listPermissionRequests("pending");
    assert.ok(permission);
    const approved = await kernel.approvePermissionRequest(permission.id);
    assert.equal(approved.state, "executed");
    await waitForRunStatus(kernel, started.run.id, "completed");
    assert.equal(executions.length, 1, "the snapshotted allowed tool did not execute after profile mutation");

    const snapshottedInputs = provider.inputsForRun(started.run.id);
    assert.equal(snapshottedInputs.length, 2);
    assert.equal(snapshottedInputs[0].providerDefaultModel, "provider-a-model");
    assert.equal(snapshottedInputs[1].providerDefaultModel, "provider-a-model-after-restart");
    for (const input of snapshottedInputs) {
      assert.ok(input.systemPrompt.startsWith(oldPromptSentinel), "resume used the mutable current system prompt");
      assert.equal(input.agentRevision, profile.revision, "resume used the mutable current profile revision");
      assert.deepEqual(input.toolIds, ["shell.exec"], "resume used the mutable current tool allowlist");
      assert.deepEqual(input.runOptions, { model: "provider-a-model", temperature: 0.3 });
      assert.deepEqual(input.requestedRunOptions, {
        reasoningEffort: "fixture-reasoning",
        temperature: 0.3
      });
      assert.equal(input.providerProfileId, "fixture-a");
    }

    const publicSurface = JSON.stringify({
      run: kernel.getPublicRun(started.run.id),
      events: kernel.listRunEvents(started.run.id),
      messages: kernel.listMessages(restoredSession.id)
    });
    assert.equal(publicSurface.includes(oldPromptSentinel), false, "the internal profile snapshot leaked through a public run surface");
    assert.equal(publicSurface.includes("agentSnapshot"), false, "internal agent snapshot metadata leaked through a public run surface");
    assert.equal(publicSurface.includes("executionSnapshot"), false, "internal execution snapshot metadata leaked through a public run surface");

    const futurePreview = kernel.previewContext(restoredSession.id);
    assert.ok(futurePreview.context.systemPrompt.startsWith("NEW_PROFILE_PROMPT"));
    assert.equal(futurePreview.providerResolution.providerProfileId, "fixture-b");
    assert.deepEqual(futurePreview.context.availableTools, []);
    assert.deepEqual(futurePreview.context.runOptions, { model: "profile-new-model", temperature: 0.6 });

    store.setSetting(toolSettingsSettingKey, fixtureToolSettings("allow"), new Date().toISOString());
    const future = kernel.startRun(restoredSession.id, "[complete] use current profile defaults");
    await waitForRunStatus(kernel, future.run.id, "completed");
    const [futureInput] = provider.inputsForRun(future.run.id);
    assert.ok(futureInput.systemPrompt.startsWith("NEW_PROFILE_PROMPT"));
    assert.equal(futureInput.agentRevision, updated.revision);
    assert.deepEqual(futureInput.toolIds, []);
    assert.equal(futureInput.providerProfileId, "fixture-b");
    assert.deepEqual(futureInput.runOptions, { model: "profile-new-model", temperature: 0.6 });
    verifyCatalogReconciliation(updated, fixtureProfiles()[1]);
    verifyClientMutationLogic(updated, restoredSession);

    const disposable = kernel.createAgentDefinition({
      name: "Disposable Running Agent",
      systemPrompt: "DISPOSABLE_SNAPSHOT_PROMPT",
      modelProfileId: "fixture-a",
      toolIds: ["shell.exec"]
    });
    const disposableSession = kernel.createSession({
      title: "Disposable running profile",
      workingDirectory: directory,
      agentId: disposable.id
    });
    store.setSetting(toolSettingsSettingKey, fixtureToolSettings("ask"), new Date().toISOString());
    const disposableRun = kernel.startRun(disposableSession.id, "[request-tool] survive profile deletion");
    await waitForRunStatus(kernel, disposableRun.run.id, "waiting_permission");
    kernel.updateSession(disposableSession.id, { agentId: "main" });
    kernel.deleteAgentDefinition(disposable.id, disposable.revision);
    const disposablePermission = kernel
      .listPermissionRequests("pending")
      .find((request) => request.runId === disposableRun.run.id);
    assert.ok(disposablePermission);
    await kernel.approvePermissionRequest(disposablePermission.id);
    await waitForRunStatus(kernel, disposableRun.run.id, "completed");
    assert.equal(executions.length, 2);
    for (const input of provider.inputsForRun(disposableRun.run.id)) {
      assert.ok(input.systemPrompt.startsWith("DISPOSABLE_SNAPSHOT_PROMPT"));
      assert.deepEqual(input.toolIds, ["shell.exec"]);
    }

    const unavailableProviderAgent = kernel.createAgentDefinition({
      name: "Unavailable Resume Provider Agent",
      systemPrompt: "Do not switch providers while resuming.",
      modelProfileId: "fixture-a",
      toolIds: ["shell.exec"]
    });
    const unavailableProviderSession = kernel.createSession({
      title: "Unavailable resume provider",
      workingDirectory: directory,
      agentId: unavailableProviderAgent.id
    });
    const unavailableRun = kernel.startRun(unavailableProviderSession.id, "[request-tool] fail exact provider resume");
    await waitForRunStatus(kernel, unavailableRun.run.id, "waiting_permission");
    providerFixture.setUnavailable("fixture-a", true);
    const unavailablePermission = kernel
      .listPermissionRequests("pending")
      .find((request) => request.runId === unavailableRun.run.id);
    assert.ok(unavailablePermission);
    await kernel.approvePermissionRequest(unavailablePermission.id);
    await waitForRunStatus(kernel, unavailableRun.run.id, "failed");
    assert.equal(provider.inputsForRun(unavailableRun.run.id).length, 1, "resume silently switched to a fallback provider");
    assert.equal(kernel.getRun(unavailableRun.run.id).error?.includes("not switched to a fallback provider"), true);
    providerFixture.setUnavailable("fixture-a", false);
    kernel.updateSession(unavailableProviderSession.id, { agentId: "main" });
    kernel.deleteAgentDefinition(unavailableProviderAgent.id, unavailableProviderAgent.revision);
    assert.equal(executions.length, 3);
    store.setSetting(toolSettingsSettingKey, fixtureToolSettings("allow"), new Date().toISOString());

    const noTools = kernel.createAgentDefinition({
      name: "No Tools Agent",
      systemPrompt: "No model tools.",
      modelProfileId: "fixture-a",
      toolIds: []
    });
    const noToolsSession = kernel.createSession({ title: "No tools", workingDirectory: directory, agentId: noTools.id });
    const denied = kernel.startRun(noToolsSession.id, "[request-tool] provider emitted an unadvertised tool call");
    await waitForRunStatus(kernel, denied.run.id, "completed");
    assert.equal(executions.length, 3, "a model tool bypassed the profile hard allowlist");
    const deniedParts = kernel.listMessages(noToolsSession.id).flatMap((message) => message.parts);
    assert.ok(
      deniedParts.some(
        (part) => part.type === "tool_result" && part.content.status === "failed" && String(part.content.error).includes("does not allow tool")
      ),
      "profile hard-allowlist denial was not persisted as a safe failed tool result"
    );

    const manual = await kernel.invokeTool(noToolsSession.id, "shell.exec", { command: "manual-fixture" }, { caller: "manual" });
    assert.equal(manual.state, "executed");
    assert.equal(manual.result?.status, "completed");
    assert.equal(executions.length, 4, "the profile model-tool allowlist incorrectly blocked an operator/manual tool call");

    verifyInspectorMarkup(updated, restoredSession, fixtureProfiles()[1]);
    assert.deepEqual(agentToolIds({ id: "main", toolIds: [] }), [], "the UI reintroduced an implicit main tool fallback");

    kernel.updateSession(restoredSession.id, { agentId: "main" });
    kernel.deleteAgentDefinition(updated.id, updated.revision);
    assert.throws(() => kernel.getAgentDefinition(updated.id), (error: unknown) => error instanceof KernelError && error.statusCode === 404);
    kernel.updateSession(noToolsSession.id, { agentId: "main" });
    kernel.deleteAgentDefinition(noTools.id, noTools.revision);
    await kernel.shutdown(100);
    closeStore(store);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

class RecordingProvider implements ProviderAdapter {
  readonly id = "openai-compatible";
  readonly label = "Agent profile fixture provider";
  private readonly inputs = new Map<string, RecordedProviderInput[]>();
  private readonly turns = new Map<string, number>();

  async test(profile: ProviderProfile, _credential: ProviderCredential): Promise<ProviderTestResponse> {
    return {
      ok: true,
      profile,
      status: profile.status,
      message: "fixture",
      checkedAt: fixtureTime
    };
  }

  async run(input: ProviderRunInput, context: ProviderRunContext) {
    const runId = String(input.context.metadata.runId ?? "");
    assert.ok(runId, "fixture provider input did not include a run id");
    const records = this.inputs.get(runId) ?? [];
    records.push({
      systemPrompt: input.context.systemPrompt,
      agentRevision: input.context.agent.revision,
      toolIds: input.context.availableTools.map((tool) => tool.id),
      providerProfileId: input.profile.id,
      providerDefaultModel: input.profile.model ?? null,
      runOptions: { ...input.runOptions },
      requestedRunOptions: { ...input.requestedRunOptions }
    });
    this.inputs.set(runId, records);

    const turn = (this.turns.get(runId) ?? 0) + 1;
    this.turns.set(runId, turn);
    const latestUserText = [...input.context.messages]
      .reverse()
      .find((message) => message.role === "user")?.content ?? "";
    if (turn === 1 && latestUserText.includes("[request-tool]")) {
      return {
        toolCalls: [{ id: `call-${runId}`, name: "shell_exec", arguments: { command: `fixture-${runId}` } }]
      };
    }
    await context.writer.writeDelta(`fixture-complete:${runId}`);
    return { toolCalls: [] };
  }

  inputsForRun(runId: string): RecordedProviderInput[] {
    return this.inputs.get(runId) ?? [];
  }
}

interface RecordedProviderInput {
  systemPrompt: string;
  agentRevision: number;
  toolIds: string[];
  providerProfileId: string;
  providerDefaultModel: string | null;
  runOptions: JsonObject;
  requestedRunOptions: JsonObject;
}

function fixtureProfiles(): ProviderProfile[] {
  return [
    fixtureProfile("fixture-a", "Fixture A", "provider-a-model"),
    fixtureProfile("fixture-b", "Fixture B", "provider-b-model")
  ];
}

function fixtureProfile(id: string, name: string, model: string): ProviderProfile {
  return {
    id,
    name,
    type: "openai-compatible",
    vendor: "fixture",
    runtime: "openai-compatible",
    authMode: "none",
    billingSource: "local",
    source: "builtin",
    enabled: true,
    model,
    status: { state: "available", message: "fixture only", credentialStatus: "not_required" },
    runOptionSupport: { model: "supported", reasoningEffort: "metadata-only", temperature: "supported" }
  };
}

function createFixtureProviderRegistry(adapter: ProviderAdapter): {
  registry: ProviderRegistry;
  setModel: (id: string, model: string) => void;
  setUnavailable: (id: string, unavailable: boolean) => void;
} {
  const profiles = fixtureProfiles();
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const unavailable = new Set<string>();
  const registry = {
    list(): ProviderListResponse {
      return { providers: profiles.map((profile) => ({ ...profile })), defaultProviderProfileId: "fixture-a" };
    },
    resolveRun(selection: { provider?: string; providerProfileId?: string }) {
      const requestedProvider = selection.provider?.trim() || null;
      const requestedProviderProfileId = selection.providerProfileId?.trim() || null;
      const id = requestedProviderProfileId ?? requestedProvider ?? "fixture-a";
      let profile = byId.get(id);
      if (!profile) {
        throw new KernelError(`Provider profile '${id}' was not found.`, 400, "unknown_provider_profile");
      }
      let fallback: ProviderResolution["fallback"] = null;
      if (unavailable.has(profile.id)) {
        const fallbackProfile = byId.get("fixture-b")!;
        fallback = {
          fromProviderProfileId: profile.id,
          toProviderProfileId: fallbackProfile.id,
          reason: "unavailable",
          message: "fixture fallback"
        };
        profile = fallbackProfile;
      }
      const providerResolution: ProviderResolution = {
        requestedProvider,
        requestedProviderProfileId,
        providerProfileId: profile.id,
        providerProfileName: profile.name,
        providerType: profile.type,
        model: profile.model,
        fallback
      };
      return { adapter, profile: { ...profile }, credential: {}, providerResolution };
    },
    resolveRunExact(providerProfileId: string) {
      const profile = byId.get(providerProfileId);
      if (!profile || unavailable.has(providerProfileId)) {
        throw new Error(
          `Saved provider profile '${providerProfileId}' is unavailable; this run was not switched to a fallback provider.`
        );
      }
      const providerResolution: ProviderResolution = {
        requestedProvider: null,
        requestedProviderProfileId: providerProfileId,
        providerProfileId: profile.id,
        providerProfileName: profile.name,
        providerType: profile.type,
        model: profile.model,
        fallback: null
      };
      return { adapter, profile: { ...profile }, credential: {}, providerResolution };
    },
    async getModelCatalog(id: string): Promise<ProviderModelCatalog | null> {
      const profile = byId.get(id);
      return profile
        ? {
            providerProfileId: profile.id,
            status: "available",
            source: "provider",
            stale: false,
            fetchedAt: fixtureTime,
            customModelAllowed: true,
            models: [{ id: profile.model!, reasoning: { support: "unknown", efforts: [] } }]
          }
        : null;
    },
    async testProfile(id: string) {
      const profile = byId.get(id);
      return profile ? adapter.test(profile, {}) : null;
    },
    invalidateModelCatalog() {}
  } as unknown as ProviderRegistry;
  return {
    registry,
    setModel(id, model) {
      const profile = byId.get(id);
      assert.ok(profile);
      profile.model = model;
    },
    setUnavailable(id, value) {
      if (value) {
        unavailable.add(id);
      } else {
        unavailable.delete(id);
      }
    }
  };
}

function createFixtureToolRegistry(executions: Array<{ command: string; cwd: string }>): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    definition: {
      id: "shell.exec",
      name: "Fixture Shell",
      description: "In-memory shell fixture; it does not spawn a process.",
      source: "builtin",
      inputSchema: {},
      outputSchema: {},
      metadata: {}
    },
    executor: {
      validateInput(input, context) {
        const command = typeof input.command === "string" ? input.command.trim() : "";
        if (!command) {
          throw new Error("command is required");
        }
        const candidate = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : context.cwd;
        const cwd = isAbsolute(candidate) ? resolve(candidate) : resolve(context.cwd, candidate);
        return { command, cwd };
      },
      toPublicInput(input) {
        return { command: String(input.command), cwd: String(input.cwd) };
      },
      async execute(input) {
        const command = String(input.command);
        const cwd = String(input.cwd);
        executions.push({ command, cwd });
        return {
          exitCode: 0,
          stdout: `fixture:${command}`,
          stderr: "",
          durationMs: 1,
          timedOut: false,
          cwd,
          stdoutTruncated: false,
          stderrTruncated: false
        };
      }
    }
  });
  return registry;
}

function createKernel(store: SQLiteStore, providers: ProviderRegistry, tools: ToolRegistry, directory: string): Kernel {
  return new Kernel({ store, eventBus: new RunEventBus(), providers, tools, toolExecutionCwd: directory });
}

function fixtureToolSettings(defaultAction: "allow" | "ask"): ToolSettings & JsonObject {
  return {
    defaultAction,
    denyPatternsText: "",
    askPatternsText: "",
    allowPatternsText: "",
    shell: { ...defaultToolSettings.shell }
  };
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
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof KernelError) {
      res.status(error.statusCode).json({ error: error.code ?? error.message, message: error.message, ...(error.details ?? {}) });
      return;
    }
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown fixture error" });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    async request<T>(path: string, options: { method?: string; body?: unknown } = {}) {
      const response = await fetch(`${origin}${path}`, {
        method: options.method,
        headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
      const body = response.status === 204 ? undefined : await response.json();
      return {
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        body: body as T
      };
    },
    async close() {
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise()))
      );
    }
  };
}

function verifyCatalogReconciliation(agent: AgentDefinition, provider: ProviderProfile): void {
  const fixedCatalog: ProviderModelCatalog = {
    providerProfileId: provider.id,
    status: "available",
    source: "provider",
    stale: false,
    fetchedAt: fixtureTime,
    customModelAllowed: false,
    models: [
      {
        id: "profile-new-model",
        reasoning: {
          support: "supported",
          efforts: [{ value: "high" }, { value: "future-tier" }],
          defaultEffort: "high"
        }
      }
    ]
  };
  assert.deepEqual(
    advertisedReasoningEfforts(fixedCatalog, provider, agent, "").map((effort) => effort.value),
    ["high", "future-tier"]
  );
  assert.equal(reconcileReasoningEffort(fixedCatalog, provider, agent, "", "future-tier"), "future-tier");
  assert.equal(reconcileReasoningEffort(fixedCatalog, provider, agent, "", "removed-tier"), "");
  assert.equal(reconcileModelOverride(fixedCatalog, "removed-model"), "");
  assert.equal(reconcileModelOverride({ ...fixedCatalog, stale: true, customModelAllowed: true }, "exact-custom-model"), "exact-custom-model");
  assert.deepEqual(catalogSelectionWarnings(fixedCatalog, "removed-model", "removed-model", "removed-effort"), [
    "Saved model 'removed-model' is not currently advertised by this provider.",
    "Saved reasoning effort 'removed-effort' is not currently advertised for model 'removed-model'."
  ]);
  const providerDefaultAgent = { ...agent, defaultRunOptions: { reasoningEffort: "future-tier" } };
  const providerWithMatchingDefault = { ...provider, model: "profile-new-model" };
  assert.deepEqual(
    advertisedReasoningEfforts(fixedCatalog, providerWithMatchingDefault, providerDefaultAgent, "").map((effort) => effort.value),
    ["high", "future-tier"]
  );
  assert.equal(profileDefaultsApplyToProvider(agent, "fixture-b", "fixture-a", true), true);
  assert.equal(profileDefaultsApplyToProvider({ ...agent, modelProfileId: "fixture-a" }, "fixture-b", "fixture-a", true), false);
}

function verifyClientMutationLogic(agent: AgentDefinition, session: Session): void {
  const settingsMarkup = renderToStaticMarkup(createElement(SettingsPanel, {}));
  assert.match(settingsMarkup, /Agent Profiles/);
  const cleanDraft: AgentProfileDraft = {
    name: agent.name,
    description: agent.description ?? "",
    systemPrompt: agent.systemPrompt,
    modelProfileId: agent.modelProfileId ?? "",
    model: agent.defaultRunOptions?.model ?? "",
    reasoningEffort: agent.defaultRunOptions?.reasoningEffort ?? "",
    temperature: agent.defaultRunOptions?.temperature === undefined ? "" : String(agent.defaultRunOptions.temperature),
    toolIds: [...agent.toolIds]
  };
  assert.equal(isAgentProfileDraftDirty(agent, cleanDraft), false);
  assert.equal(isAgentProfileDraftDirty(agent, { ...cleanDraft, systemPrompt: `${cleanDraft.systemPrompt} changed` }), true);
  assert.equal(isCurrentAgentProfileMutation(4, 4), true);
  assert.equal(isCurrentAgentProfileMutation(3, 4), false, "a late profile mutation response was treated as current");

  const agentResponse: Session = { ...session, agentId: "main", workingDirectory: "/stale/cwd", updatedAt: "2026-08-04T00:00:01.000Z" };
  const cwdResponse: Session = { ...session, agentId: session.agentId, workingDirectory: "/new/cwd", updatedAt: "2026-08-04T00:00:02.000Z" };
  const afterAgent = mergeSessionMutation(session, agentResponse, ["agentId"]);
  const afterReverseCwd = mergeSessionMutation(afterAgent, cwdResponse, ["workingDirectory"]);
  assert.equal(afterReverseCwd.agentId, "main");
  assert.equal(afterReverseCwd.workingDirectory, "/new/cwd");
  const afterCwd = mergeSessionMutation(session, cwdResponse, ["workingDirectory"]);
  const afterReverseAgent = mergeSessionMutation(afterCwd, agentResponse, ["agentId"]);
  assert.equal(afterReverseAgent.agentId, "main");
  assert.equal(afterReverseAgent.workingDirectory, "/new/cwd");
}

function verifyInspectorMarkup(agent: AgentDefinition, session: Session, provider: ProviderProfile): void {
  const noop = () => undefined;
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
      modelCatalog: null,
      modelCatalogState: "idle",
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
      contextPreview: null,
      contextPreviewState: "idle",
      onPreviewContext: noop,
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
  assert.match(markup, /Session agent/);
  assert.match(markup, /Bound to this session\. Changes affect future runs only\./);
  assert.match(markup, /Tools: none/);
  assert.match(markup, /profile\/provider default/);
  const crossProviderMarkup = renderToStaticMarkup(
    createElement(RunInspector, {
      ...props,
      setup: {
        ...props.setup,
        providers: [provider, fixtureProfiles()[0]],
        providerProfileId: "fixture-a",
        effectiveProviderProfileId: "fixture-a",
        defaultProviderProfileId: provider.id
      }
    })
  );
  assert.match(crossProviderMarkup, /profile model, reasoning, and temperature defaults are not inherited/);
  const missingCatalogMarkup = renderToStaticMarkup(
    createElement(RunInspector, {
      ...props,
      setup: {
        ...props.setup,
        modelCatalog: {
          providerProfileId: provider.id,
          status: "available",
          source: "provider",
          stale: false,
          fetchedAt: fixtureTime,
          customModelAllowed: true,
          models: []
        },
        modelCatalogState: "loaded"
      }
    })
  );
  assert.match(missingCatalogMarkup, /not currently advertised by this provider/);
}

async function waitForRunStatus(kernel: Kernel, runId: string, expected: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = kernel.getRun(runId).status;
    if (status === expected) {
      return;
    }
    if (["completed", "failed", "cancelled", "interrupted"].includes(status)) {
      assert.fail(`run ${runId} reached terminal status ${status} while waiting for ${expected}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  assert.fail(`run ${runId} did not reach ${expected} within ${timeoutMs}ms`);
}

function closeStore(store: SQLiteStore): void {
  (store as unknown as { db: Database.Database }).db.close();
}

async function main(): Promise<void> {
  await migrationScenario();
  await profileRuntimeAndApiScenario();
  console.log("agent profiles smoke test passed");
}

await main();
