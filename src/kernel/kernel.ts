import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  buildContext,
  defaultAgentId,
  projectStoredMessagesForContext,
  type ContextBuildInput,
} from "./context-builder";
import {
  boundHistoricalContextText,
  contextBudgetFromMetadata,
  ContextBudgetExceededError,
  ContextSummaryExceedsBudgetError,
  contextEstimatorVersion,
  estimateTextTokens,
  InvalidContextPolicyError,
  resolveContextBudget,
} from "./context-budget";
import type { RunEventBus, RunEventListener } from "./event-bus";
import {
  booleanField,
  agentFromRunMetadata,
  buildContextRunMetadata,
  buildRunMetadata,
  buildRunOptionPlan,
  contextPlanRecordToJson,
  effectiveAgentToolIds,
  executionSnapshotFromRunMetadata,
  mergeRunOptions,
  numberField,
  partString,
  runOptionsFromJson,
  stringField,
  toProviderMessages,
  type RunOptionPlan,
} from "./kernel-metadata";
import { RunWriter } from "./run-writer";
import {
  currentRunToolTranscript,
  NativeTranscriptError,
} from "./tool-transcript";
import { SubsessionCoordinator } from "./subsession-coordinator";
import { SubsessionAdmissionError } from "../store/subsessions";
import {
  toPublicMessage,
  sanitizePublicText,
  toPublicProviderResolution,
  toPublicRunEvent,
  toPublicToolExecutionResult,
  toPublicToolInvocation,
} from "./public-projection";
import {
  appendLimitedText,
  buildPermissionBlockedResult,
  buildToolExecutionResult,
  buildToolMessageMetadata,
  buildToolRunMetadata,
  commandOutputMaxCharsForTool,
  commandOutputMetadataFromResult,
  normalizeToolCallId,
  permissionEvaluationFromRequest,
  permissionPolicySummary,
  summarizeToolInput,
  summarizeToolResult,
  toolProviderForPart,
  toPublicPermissionRequest,
} from "./tool-execution";
import type {
  ProviderAdapter,
  ProviderRunInput,
  ProviderRunWriter,
  ProviderToolCall,
} from "../providers/types";
import { ProviderContextLengthError } from "../providers/provider-errors";
import type {
  ProviderRegistry,
  ResolvedProviderRun,
} from "../providers/registry";
import type {
  CreateAgentDefinitionInput,
  CreateRunInput,
  StoreAdapter,
  StoredPermissionRequest,
  UpdateAgentDefinitionInput,
} from "../store/types";
import {
  ActiveRunExistsStoreError,
  ContextSegmentChangedStoreError,
} from "../store/types";
import {
  providerToolNameToToolId,
  toModelToolDefinition,
} from "../shared/model-tools";
import {
  hasControlCharacters,
  maxReasoningEffortLength,
  normalizeReasoningEffort,
} from "../shared/run-options";
import {
  normalizeToolSettings,
  toolSettingsSettingKey,
} from "../shared/tool-settings";
import {
  evaluateToolPermission,
  type ToolPermissionEvaluation,
} from "../tools/permission-policy";
import type { ToolRegistry } from "../tools/registry";
import {
  ToolExecutionAbortError,
  ToolInputError,
  type RegisteredTool,
} from "../tools/types";
import type {
  AgentDefinition,
  CompactContextResponse,
  ContextArtifact,
  ContextArtifactSourceCategory,
  ContextPreviewResponse,
  ContextSegment,
  ContextSegmentDetail,
  ContextPlan,
  ContextPlanRecord,
  CreateRunResponse,
  InvokeToolResponse,
  JsonObject,
  Message,
  MessagePart,
  PermissionRequest,
  PublicRunPhase,
  PublicRunSummary,
  ProviderResolution,
  Run,
  RunEvent,
  RunEventType,
  RunOptions,
  RunUsage,
  Session,
  ToolDefinition,
  ToolExecutionEvent,
  ToolExecutionResult,
  ToolInvocation,
  ToolInvocationCaller,
  ToolInvocationStatus,
  ToolSettings,
  ToolResultStatus,
} from "../shared/types";
import { RUN_CONSTANT } from "@/run/constant";
import { RunVO } from "@/run/vo";
import { MessageVO } from "@/message/vo";
import { PermissionRequestType } from "@/permission-request/type";
import { PermissionRequestVO } from "@/permission-request/vo";

export interface StartRunOptions {
  agentId?: string;
  provider?: string;
  providerProfileId?: string;
  runOptions?: RunOptions;
}

export interface PreviewContextOptions extends StartRunOptions {
  text?: string;
}

export interface InvokeToolOptions {
  caller?: ToolInvocationCaller;
}

export interface CreateSessionOptions {
  title?: string;
  workingDirectory?: string;
  agentId?: string;
}

export interface CreateAgentDefinitionOptions {
  name: string;
  description?: string | null;
  systemPrompt: string;
  modelProfileId?: string | null;
  defaultRunOptions?: RunOptions | null;
  contextPolicy?: AgentDefinition["contextPolicy"];
  skillIds?: string[];
  toolIds?: string[];
  metadata?: JsonObject;
}

export interface UpdateSessionOptions {
  workingDirectory?: string;
  agentId?: string;
}

interface PreparedToolInvocation {
  registeredTool: RegisteredTool;
  executionInput: JsonObject;
  publicInput: JsonObject;
  executionCwd: string;
  caller: ToolInvocationCaller;
  permission: ToolPermissionEvaluation;
  run: Run;
  assistantMessage: Message;
  invocation: ToolInvocation;
  writer: RunWriter;
  toolCallPart: MessagePart;
  commandOutputPart: MessagePart | null;
  createdAt: string;
  resumeAgentRun: boolean;
  toolLoopIteration?: number;
  providerToolCallName?: string;
  execution: RunExecution;
}

type RunExecutionPhase =
  | "idle"
  | "provider"
  | "tool"
  | "compacting_context"
  | "waiting_permission";
type RunTermination = "cancelled" | "interrupted";

interface RunExecution {
  runId: string;
  controller: AbortController;
  phase: RunExecutionPhase;
  providerId: string | null;
  toolId: string | null;
  termination: RunTermination | null;
  activePromise: Promise<unknown> | null;
}

export class KernelError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "KernelError";
  }
}

class RunTerminationError extends Error {
  constructor(readonly termination: RunTermination) {
    super(termination === "cancelled" ? "Run cancelled." : "Run interrupted.");
    this.name = "AbortError";
  }
}

export interface KernelOptions {
  store: StoreAdapter;
  providers: ProviderRegistry;
  eventBus: RunEventBus;
  tools: ToolRegistry;
  /** Default session/tool cwd for newly created sessions and legacy rows without one. */
  toolExecutionCwd?: string;
}

export class Kernel {
  private readonly subsessions: SubsessionCoordinator;
  private readonly unobserveChildren: () => void;
  private readonly store: StoreAdapter;
  private readonly providers: ProviderRegistry;
  private readonly eventBus: RunEventBus;
  private readonly tools: ToolRegistry;
  private readonly defaultWorkingDirectory: string;
  private readonly executions = new Map<string, RunExecution>();
  private readonly compactions = new Map<
    string,
    Promise<CompactContextResponse>
  >();
  private readonly compactionControllers = new Map<string, AbortController>();
  private shuttingDown = false;

  constructor(options: KernelOptions) {
    this.store = options.store;
    this.providers = options.providers;
    this.eventBus = options.eventBus;
    this.tools = options.tools;
    this.subsessions = new SubsessionCoordinator(this.store, {
      agent: (id) => {
        const agent = this.getAgentDefinition(id);
        const profiles = this.providers.list();
        const profileId =
          agent.modelProfileId ?? profiles.defaultProviderProfileId;
        const profile = profiles.providers.find(
          (item) => item.id === profileId,
        );
        return {
          ...agent,
          modelProfileId: profileId,
          defaultRunOptions: mergeRunOptions(
            profile?.defaultRunOptions ??
              (profile?.model ? { model: profile.model } : {}),
            agent.defaultRunOptions ?? {},
          ),
        };
      },
      execute: (runId) => this.executeAdmittedSubsession(runId),
      fail: (id, error) => {
        const execution = this.getOrCreateExecution(id);
        this.handleQueuedExecutionError(id, execution, error);
        this.releaseTerminalExecution(execution);
      },
      cancel: (id) => {
        this.cancelRun(id);
      },
      wake: (id) => this.wakeWaitingParent(id),
    });
    this.tools.register(this.subsessions.tool(), true);
    this.unobserveChildren = this.eventBus.observe((event) => {
      if (
        [
          "run_completed",
          "run_failed",
          "run_cancelled",
          "run_interrupted",
        ].includes(event.type)
      )
        this.subsessions.changed();
    });
    this.defaultWorkingDirectory = resolve(
      options.toolExecutionCwd ?? homedir(),
    );
    assertExistingDirectory(
      this.defaultWorkingDirectory,
      "Default session workingDirectory",
    );
  }

  listSessions(): Session[] {
    return this.store.listSessions();
  }

  createSession(options: CreateSessionOptions | string = {}): Session {
    const input = typeof options === "string" ? { title: options } : options;
    const agentId = input.agentId?.trim() || defaultAgentId;
    this.getAgentDefinition(agentId);
    const now = new Date().toISOString();
    return this.store.createSession({
      id: randomUUID(),
      activeSegmentId: randomUUID(),
      title: input.title?.trim() || "New session",
      workingDirectory: this.normalizeWorkingDirectory(input.workingDirectory, {
        allowDefault: true,
      }),
      agentId,
      createdAt: now,
      updatedAt: now,
    });
  }

  getSession(id: string): Session {
    const session = this.store.getSession(id);
    if (!session) {
      throw new KernelError("Session not found", 404);
    }
    return session;
  }

  updateSessionWorkingDirectory(id: string, workingDirectory: string): Session {
    return this.updateSession(id, { workingDirectory });
  }

  updateSession(id: string, patch: UpdateSessionOptions): Session {
    this.getSession(id);
    const workingDirectory =
      patch.workingDirectory === undefined
        ? undefined
        : this.normalizeWorkingDirectory(patch.workingDirectory, {
            allowDefault: false,
          });
    const agentId = patch.agentId?.trim();
    if (patch.agentId !== undefined) {
      if (!agentId) {
        throw new KernelError(
          "Session agentId must be a non-empty string.",
          400,
        );
      }
      this.getAgentDefinition(agentId);
    }
    const updated = this.store.updateSession(id, {
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(agentId ? { agentId } : {}),
      updatedAt: new Date().toISOString(),
    });
    if (!updated) {
      throw new KernelError("Session not found", 404);
    }
    return updated;
  }

  listMessages(sessionId: string): Message[] {
    this.getSession(sessionId);
    return this.store.listMessages(sessionId).map(toPublicMessage);
  }

  listActiveMessages(sessionId: string): Message[] {
    const session = this.getSession(sessionId);
    return this.store
      .listMessagesBySegment(session.activeSegmentId)
      .map(toPublicMessage);
  }

  listContextSegments(sessionId: string): ContextSegmentDetail[] {
    this.getSession(sessionId);
    const artifactList = this.store.listContextArtifacts(sessionId);
    const artifacts = new Map(
      artifactList.map((artifact) => [artifact.id, artifact]),
    );
    const artifactsBySource = new Map(
      artifactList
        .filter((artifact) => artifact.status === "completed")
        .map((artifact) => [artifact.sourceSegmentId, artifact]),
    );
    return this.store.listContextSegments(sessionId).map((segment) => ({
      ...segment,
      artifact:
        artifactsBySource.get(segment.id) ??
        (segment.inheritedArtifactId
          ? (artifacts.get(segment.inheritedArtifactId) ?? null)
          : null),
      recentFailure:
        [...artifactList]
          .reverse()
          .find(
            (artifact) =>
              artifact.status === "failed" &&
              (artifact.sourceSegmentId === segment.id ||
                artifact.targetSegmentId === segment.id),
          ) ?? null,
    }));
  }

  getContextSegment(
    sessionId: string,
    segmentId: string,
  ): ContextSegmentDetail {
    this.getSession(sessionId);
    const segment = this.store.getContextSegment(segmentId);
    if (!segment || segment.sessionId !== sessionId) {
      throw new KernelError("Context segment not found", 404);
    }
    return {
      ...segment,
      artifact:
        this.store
          .listContextArtifacts(sessionId)
          .find(
            (artifact) =>
              artifact.sourceSegmentId === segment.id &&
              artifact.status === "completed",
          ) ??
        (segment.inheritedArtifactId
          ? this.store.getContextArtifact(segment.inheritedArtifactId)
          : null),
      recentFailure:
        [...this.store.listContextArtifacts(sessionId)]
          .reverse()
          .find(
            (artifact) =>
              artifact.status === "failed" &&
              (artifact.sourceSegmentId === segment.id ||
                artifact.targetSegmentId === segment.id),
          ) ?? null,
    };
  }

  listContextSegmentMessages(sessionId: string, segmentId: string): Message[] {
    this.getContextSegment(sessionId, segmentId);
    return this.store.listMessagesBySegment(segmentId).map(toPublicMessage);
  }

  getContextArtifact(sessionId: string, artifactId: string): ContextArtifact {
    this.getSession(sessionId);
    const artifact = this.store.getContextArtifact(artifactId);
    if (!artifact || artifact.sessionId !== sessionId) {
      throw new KernelError("Context artifact not found", 404);
    }
    return artifact;
  }

  async compactSession(sessionId: string): Promise<CompactContextResponse> {
    this.assertAcceptingWork();
    const activeRuns = this.store.listRuns({
      sessionId,
      statuses: RUN_CONSTANT.ACTIVE_STATUS,
    });
    if (activeRuns.length > 0) {
      throw new KernelError(
        "Context cannot be compacted while the session has an active run or permission request.",
        409,
        "context_compaction_conflict",
      );
    }
    return this.coordinateCompaction(sessionId, null);
  }

  listTools(): ToolDefinition[] {
    return this.tools.list();
  }

  async invokeTool(
    sessionId: string,
    toolId: string,
    input: JsonObject,
    options: InvokeToolOptions = {},
  ): Promise<InvokeToolResponse> {
    this.assertAcceptingWork();
    const prepared = this.prepareToolInvocation(
      sessionId,
      toolId,
      input,
      options,
    );
    if (prepared.permission.decision === "allowed") {
      return this.trackExecution(prepared.execution, () =>
        this.executePreparedToolInvocation(prepared, { state: "executed" }),
      );
    }
    if (prepared.permission.decision === "requires_approval") {
      return this.createPendingPermissionResponse(prepared);
    }
    const response = this.denyPreparedToolInvocation(prepared, null);
    this.releaseTerminalExecution(prepared.execution);
    return response;
  }

  startToolInvocation(
    sessionId: string,
    toolId: string,
    input: JsonObject,
    options: InvokeToolOptions = {},
  ): InvokeToolResponse {
    this.assertAcceptingWork();
    const prepared = this.prepareToolInvocation(
      sessionId,
      toolId,
      input,
      options,
    );
    if (prepared.permission.decision === "requires_approval") {
      return this.createPendingPermissionResponse(prepared);
    }
    if (prepared.permission.decision === "denied") {
      const response = this.denyPreparedToolInvocation(prepared, null);
      this.releaseTerminalExecution(prepared.execution);
      return response;
    }

    queueMicrotask(() => {
      void this.trackExecution(prepared.execution, () =>
        this.executePreparedToolInvocation(prepared, { state: "executed" }),
      ).catch((error) =>
        this.handleQueuedExecutionError(
          prepared.run.id,
          prepared.execution,
          error,
        ),
      );
    });
    return {
      state: "running",
      invocation: toPublicToolInvocation(prepared.invocation),
      run: this.toPublicRunSummary(
        this.store.getRun(prepared.run.id) ?? prepared.run,
      ),
      message: toPublicMessage(
        this.store.getMessage(prepared.assistantMessage.id) ??
          prepared.assistantMessage,
      ),
      toolCallPartId: prepared.toolCallPart.id,
      commandOutputPartId: prepared.commandOutputPart?.id,
    };
  }

  listAgentDefinitions(): AgentDefinition[] {
    return this.store.listAgentDefinitions();
  }

  getAgentDefinition(id = defaultAgentId): AgentDefinition {
    const agent = this.store.getAgentDefinition(id.trim() || defaultAgentId);
    if (!agent) {
      throw new KernelError("Agent definition not found", 404);
    }
    return agent;
  }

  updateAgentDefinition(input: UpdateAgentDefinitionInput): AgentDefinition {
    const current = this.getAgentDefinition(input.id);
    if (current.revision !== input.expectedRevision) {
      throw this.agentRevisionConflict(current);
    }
    const candidate = this.normalizeAgentDefinition(
      {
        name: input.name ?? current.name,
        description:
          input.description !== undefined
            ? input.description
            : current.description,
        systemPrompt: input.systemPrompt ?? current.systemPrompt,
        modelProfileId:
          input.modelProfileId !== undefined
            ? input.modelProfileId
            : current.modelProfileId,
        defaultRunOptions:
          input.defaultRunOptions !== undefined
            ? input.defaultRunOptions
            : current.defaultRunOptions,
        contextPolicy:
          input.contextPolicy !== undefined
            ? input.contextPolicy
            : current.contextPolicy,
        skillIds: input.skillIds ?? current.skillIds,
        toolIds: input.toolIds ?? current.toolIds,
      },
      current.id,
    );
    const result = this.store.updateAgentDefinition({ ...input, ...candidate });
    if (result.status === "not_found") {
      throw new KernelError("Agent definition not found", 404);
    }
    if (result.status === "revision_conflict") {
      throw this.agentRevisionConflict(result.agent);
    }
    return result.agent;
  }

  createAgentDefinition(input: CreateAgentDefinitionOptions): AgentDefinition {
    const candidate = this.normalizeAgentDefinition(input);
    const now = new Date().toISOString();
    const createInput: CreateAgentDefinitionInput = {
      id: randomUUID(),
      ...candidate,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    return this.store.createAgentDefinition(createInput);
  }

  cloneAgentDefinition(id: string, expectedRevision: number): AgentDefinition {
    const source = this.getAgentDefinition(id);
    if (source.revision !== expectedRevision) {
      throw this.agentRevisionConflict(source);
    }
    const candidate = this.normalizeAgentDefinition({
      name: this.nextAgentCopyName(source.name),
      description: source.description,
      systemPrompt: source.systemPrompt,
      modelProfileId: source.modelProfileId,
      defaultRunOptions: source.defaultRunOptions,
      contextPolicy: source.contextPolicy,
      skillIds: source.skillIds,
      toolIds: source.toolIds,
      metadata: source.id === defaultAgentId ? {} : source.metadata,
    });
    const now = new Date().toISOString();
    const result = this.store.cloneAgentDefinition({
      sourceId: source.id,
      expectedSourceRevision: expectedRevision,
      id: randomUUID(),
      ...candidate,
      metadata: source.id === defaultAgentId ? {} : source.metadata,
      createdAt: now,
      updatedAt: now,
    });
    if (result.status === "not_found") {
      throw new KernelError("Agent definition not found", 404);
    }
    if (result.status === "revision_conflict") {
      throw this.agentRevisionConflict(result.agent);
    }
    return result.agent;
  }

  deleteAgentDefinition(id: string, expectedRevision: number): void {
    const agent = this.getAgentDefinition(id);
    if (agent.id === defaultAgentId) {
      throw new KernelError(
        "The main agent profile cannot be deleted.",
        409,
        "main_agent_protected",
      );
    }
    if (agent.revision !== expectedRevision) {
      throw this.agentRevisionConflict(agent);
    }
    const result = this.store.deleteAgentDefinitionIfUnused(
      agent.id,
      expectedRevision,
    );
    if (result.status === "revision_conflict") {
      throw this.agentRevisionConflict(result.agent);
    }
    if (result.status === "in_use") {
      const sessions = result.sessions;
      throw new KernelError(
        `Agent profile '${result.agent.name}' is used by ${sessions.length} session${sessions.length === 1 ? "" : "s"}.`,
        409,
        "agent_in_use",
        {
          usage: {
            sessionCount: sessions.length,
            sessions: sessions
              .slice(0, 20)
              .map((session) => ({ id: session.id, title: session.title })),
          },
        },
      );
    }
    if (result.status === "not_found") {
      throw new KernelError("Agent definition not found", 404);
    }
  }

  private agentRevisionConflict(latest: AgentDefinition): KernelError {
    return new KernelError(
      `Agent profile '${latest.name}' changed since this draft was loaded.`,
      409,
      "agent_revision_conflict",
      {
        latest: {
          id: latest.id,
          name: latest.name,
          revision: latest.revision,
          updatedAt: latest.updatedAt,
        },
      },
    );
  }

  async previewContext(
    sessionId: string,
    options: PreviewContextOptions = {},
  ): Promise<ContextPreviewResponse> {
    const session = this.getSession(sessionId);
    const agent = this.resolveAgentForSession(session, options.agentId);
    const resolvedProvider = session.parentSessionId
      ? this.resolveSavedProvider(
          options.providerProfileId ??
            agent.modelProfileId ??
            this.providers.list().defaultProviderProfileId,
        )
      : this.providers.resolveRun({
          provider: options.provider,
          providerProfileId:
            options.providerProfileId ?? agent.modelProfileId ?? undefined,
        });
    const agentDefaults = this.agentDefaultsForProvider(
      agent,
      resolvedProvider.profile.id,
      options,
    );
    const optionPlan = buildRunOptionPlan(
      resolvedProvider.profile,
      mergeRunOptions(agentDefaults, options.runOptions),
    );
    const providerResolution: ProviderResolution = {
      ...resolvedProvider.providerResolution,
      model:
        optionPlan.runOptions.model ??
        resolvedProvider.providerResolution.model,
    };
    const contextHistory = this.contextHistoryForSession(session);
    const contextResult = this.buildContext({
      session,
      agent,
      messages: contextHistory.messages,
      activeSegmentId: session.activeSegmentId,
      compactionArtifact: contextHistory.artifact,
      currentMessage: options.text?.trim()
        ? { content: options.text }
        : undefined,
      providerProfileId: resolvedProvider.profile.id,
      runOptions: optionPlan.runOptions,
      availableTools: this.getAvailableToolsForAgent(agent, session),
      providerOverhead: resolvedProvider.adapter.contextPlanning,
      contextCapability: await this.getModelContextCapability(
        resolvedProvider.profile.id,
        optionPlan.runOptions.model ?? resolvedProvider.profile.model,
      ),
    });
    if (agent.defaultRunOptions && !agentDefaults) {
      contextResult.warnings.push(
        "Agent Profile model, reasoning, and temperature defaults were not inherited because the explicit provider override uses a different provider profile.",
      );
    }

    return {
      ...contextResult,
      providerResolution: toPublicProviderResolution(providerResolution),
      requestedRunOptions: optionPlan.requestedRunOptions,
      unsupportedRunOptions: optionPlan.unsupportedRunOptions,
    };
  }

  getRun(runId: string): Run {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new KernelError("Run not found", 404);
    }
    return run;
  }

  listRuns(sessionId?: string, activeOnly = false): Run[] {
    if (sessionId) {
      this.getSession(sessionId);
    }
    return this.store.listRuns({
      ...(sessionId ? { sessionId } : {}),
      ...(activeOnly ? { statuses: RUN_CONSTANT.ACTIVE_STATUS } : {}),
    });
  }

  getPublicRun(runId: string): PublicRunSummary {
    return this.toPublicRunSummary(this.getRun(runId));
  }

  listPublicRuns(sessionId?: string, activeOnly = false): PublicRunSummary[] {
    return this.listRuns(sessionId, activeOnly).map((run) =>
      this.toPublicRunSummary(run),
    );
  }

  /** Call only after the server owns the exclusive database lease and has bound its listening socket. */
  reconcileStartupState(): void {
    const reconciledAt = new Date().toISOString();
    this.store.subsessions.reconcile(true);
    for (const run of this.store.listRuns({ statuses: ["running"] })) {
      if (
        run.metadata.childWakePending === 1 ||
        this.store.subsessions
          .list(run.id)
          .some((item) => item.deliveredPartId && !item.acknowledged)
      ) {
        this.store.transitionRunStatus(
          run.id,
          ["running"],
          "waiting_children",
          null,
          reconciledAt,
        );
      }
    }
    this.store.expirePendingPermissionsForTerminalRuns(reconciledAt);
    const pendingPermissionRunIds = new Set(
      this.store
        .listPermissionRequests({ status: "pending" })
        .map((request) => request.runId),
    );
    for (const run of this.store.listRuns({ statuses: ["running"] })) {
      if (pendingPermissionRunIds.has(run.id)) {
        this.store.transitionRunStatus(
          run.id,
          ["running"],
          "waiting_permission",
          null,
          reconciledAt,
        );
      }
    }
    const staleRuns = this.store.listRuns({
      statuses: ["running", "cancelling"],
    });
    for (const run of staleRuns) {
      this.finalizeRunTermination(
        run,
        "interrupted",
        "The daemon restarted before the run reached a terminal state.",
      );
    }
    this.subsessions.changed();
  }

  async shutdown(timeoutMs = 5_000): Promise<void> {
    this.shuttingDown = true;
    this.subsessions.stop();
    this.unobserveChildren();
    for (const controller of this.compactionControllers.values()) {
      controller.abort(new RunTerminationError("interrupted"));
    }
    const activePromises: Promise<unknown>[] = [];
    activePromises.push(...this.subsessions.activePromises());
    activePromises.push(...this.compactions.values());
    for (const execution of this.executions.values()) {
      const run = this.store.getRun(execution.runId);
      if (!run || (run.status !== "running" && run.status !== "cancelling")) {
        continue;
      }
      execution.termination ??=
        run.status === "cancelling" ? "cancelled" : "interrupted";
      execution.controller.abort(
        new RunTerminationError(execution.termination),
      );
      if (execution.activePromise) {
        activePromises.push(execution.activePromise);
      }
    }

    await settleWithin(activePromises, timeoutMs);
    for (const run of this.store.listRuns({
      statuses: ["running", "cancelling"],
    })) {
      if (run.status === "cancelling") {
        this.finalizeRunTermination(run, "cancelled");
      } else {
        this.finalizeRunTermination(
          run,
          "interrupted",
          "The daemon stopped before the run reached a terminal state.",
        );
      }
    }
    for (const execution of this.executions.values()) {
      this.releaseTerminalExecution(execution);
    }
  }

  async startRun(
    sessionId: string,
    text: string,
    options: StartRunOptions = {},
  ): Promise<CreateRunResponse> {
    return this.startRunAttempt(sessionId, text, options, true);
  }

  private async startRunAttempt(
    sessionId: string,
    text: string,
    options: StartRunOptions,
    allowSegmentRetry: boolean,
    ownedChildRunId?: string,
  ): Promise<CreateRunResponse> {
    this.assertAcceptingWork();
    const currentSession = this.getSession(sessionId);
    const admittedRun = ownedChildRunId
      ? this.store.getRun(ownedChildRunId)
      : null;
    // Match resume: keep admission cwd; legacy Runs without it fall back to current Session cwd.
    // Only the execution view is changed, never the editable Session row.
    const session = admittedRun
      ? {
          ...currentSession,
          workingDirectory:
            stringField(admittedRun.metadata, "workingDirectory") ||
            currentSession.workingDirectory,
        }
      : currentSession;
    if (session.parentSessionId && !ownedChildRunId) {
      throw new KernelError(
        "Child sessions only accept their admitted task; steering and session reuse are not enabled.",
        409,
        "child_session_owned",
      );
    }
    const prompt = text.trim();
    if (!prompt) {
      throw new KernelError("Run text is required", 400);
    }

    const agent = admittedRun
      ? this.getAgentForRun(admittedRun)
      : this.resolveAgentForSession(session, options.agentId);
    const resolvedProvider = session.parentSessionId
      ? this.resolveSavedProvider(
          options.providerProfileId ??
            agent.modelProfileId ??
            this.providers.list().defaultProviderProfileId,
        )
      : this.providers.resolveRun({
          provider: options.provider,
          providerProfileId:
            options.providerProfileId ?? agent.modelProfileId ?? undefined,
        });
    const agentDefaults = this.agentDefaultsForProvider(
      agent,
      resolvedProvider.profile.id,
      options,
    );
    const requestedRunOptions = mergeRunOptions(
      agentDefaults,
      options.runOptions,
    );
    const optionPlan = buildRunOptionPlan(
      resolvedProvider.profile,
      requestedRunOptions,
    );
    const providerResolution: ProviderResolution = {
      ...resolvedProvider.providerResolution,
      model:
        optionPlan.runOptions.model ??
        resolvedProvider.providerResolution.model,
    };
    const now = new Date().toISOString();
    const admittedChild = ownedChildRunId
      ? this.store.subsessions.forRun(ownedChildRunId)
      : null;
    if (
      session.parentSessionId &&
      admittedChild?.childRunId !== ownedChildRunId
    ) {
      throw new KernelError(
        "Child task admission is missing or already started.",
        409,
        "child_session_owned",
      );
    }
    const runId = admittedChild?.childRunId ?? randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const contextHistory = this.contextHistoryForSession(session);
    const contextResult = this.buildContext({
      session,
      agent,
      messages: contextHistory.messages,
      activeSegmentId: session.activeSegmentId,
      compactionArtifact: contextHistory.artifact,
      currentMessage: {
        content: prompt,
        messageId: userMessageId,
        metadata: { runId },
      },
      currentMessageId: userMessageId,
      providerProfileId: resolvedProvider.profile.id,
      runOptions: optionPlan.runOptions,
      availableTools: this.getAvailableToolsForAgent(agent, session),
      providerOverhead: resolvedProvider.adapter.contextPlanning,
      metadata: { runId },
      contextCapability: await this.getModelContextCapability(
        resolvedProvider.profile.id,
        optionPlan.runOptions.model ?? resolvedProvider.profile.model,
      ),
    });
    if (agent.defaultRunOptions && !agentDefaults) {
      contextResult.warnings.push(
        "Agent Profile model, reasoning, and temperature defaults were not inherited because the explicit provider override uses a different provider profile.",
      );
    }
    const runMetadata = buildRunMetadata(
      providerResolution,
      optionPlan,
      agent,
      options.runOptions ?? {},
      now,
    );
    this.assertAcceptingWork();
    runMetadata.workingDirectory = session.workingDirectory;
    let run: Run;
    try {
      run = this.createRun({
        id: runId,
        sessionId,
        provider: resolvedProvider.profile.id,
        status: "running",
        segmentId: session.activeSegmentId,
        expectedActiveSegmentId: session.activeSegmentId,
        createdAt: now,
        updatedAt: now,
        metadata: runMetadata,
      });
    } catch (error) {
      if (error instanceof ContextSegmentChangedStoreError) {
        if (allowSegmentRetry) {
          return this.startRunAttempt(
            sessionId,
            text,
            options,
            false,
            ownedChildRunId,
          );
        }
        throw new KernelError(
          "The active context segment changed while this run was being planned. Retry the request.",
          409,
          error.code,
          {
            expectedSegmentId: error.expectedSegmentId,
            activeSegmentId: error.activeSegmentId,
          },
        );
      }
      throw error;
    }
    this.store.touchSession(sessionId, now);

    const userMessage = this.store.createMessage({
      id: userMessageId,
      sessionId,
      runId: run.id,
      segmentId: session.activeSegmentId,
      role: "user",
      status: "completed",
      createdAt: now,
      updatedAt: now,
    });
    this.store.addMessagePart({
      id: randomUUID(),
      messageId: userMessage.id,
      seq: 0,
      text: prompt,
      createdAt: now,
      updatedAt: now,
    });

    const assistantCreatedAt = new Date(Date.parse(now) + 1).toISOString();
    const assistantMessage = this.store.createMessage({
      id: assistantMessageId,
      sessionId,
      runId: run.id,
      segmentId: session.activeSegmentId,
      role: "assistant",
      status: "streaming",
      createdAt: assistantCreatedAt,
      updatedAt: assistantCreatedAt,
      metadata: { runId: run.id, contextMetadataOwner: "run" },
    });

    const sourceMessages = this.store
      .listMessagesBySegment(session.activeSegmentId)
      .filter((message) => message.id !== assistantMessage.id);
    const initialPlanRecord = this.createContextPlanRecord(
      contextResult.plan,
      0,
      0,
      now,
    );
    const contextMetadata = buildContextRunMetadata(
      contextResult.context,
      contextResult.warnings,
      contextResult.skippedMessageIds,
      initialPlanRecord,
    );
    this.store.mergeRunMetadata(run.id, contextMetadata, now);

    const runWithMetadata = this.store.getRun(run.id)!;
    const userMessageWithParts = this.store.getMessage(userMessage.id)!;
    const assistantMessageWithParts = this.store.getMessage(
      assistantMessage.id,
    )!;

    this.emit(run, "run_started", {
      runId: run.id,
      sessionId,
      provider: resolvedProvider.adapter.id,
      providerProfileId: resolvedProvider.profile.id,
      requestedProvider: options.provider ?? null,
      requestedProviderProfileId: options.providerProfileId ?? null,
      providerResolution: toPublicProviderResolution(providerResolution),
      agentId: agent.id,
      agentName: agent.name,
      agentRevision: agent.revision,
      requestedRunOptions: optionPlan.requestedRunOptions,
      runOptions: optionPlan.runOptions,
      unsupportedRunOptions: optionPlan.unsupportedRunOptions,
      model: optionPlan.runOptions.model ?? null,
    });
    this.emit(run, "user_message_created", { message: userMessageWithParts });
    this.emit(run, "assistant_message_created", {
      message: assistantMessageWithParts,
    });

    const execution = this.getOrCreateExecution(run.id);
    const writer = new RunWriter({
      store: this.store,
      eventBus: this.eventBus,
      run: runWithMetadata,
      assistantMessageId: assistantMessage.id,
      signal: execution.controller.signal,
    });

    const providerInput: ProviderRunInput = {
      session,
      context: contextResult.context,
      sourceMessages,
      messages: toProviderMessages(contextResult.context),
      profile: resolvedProvider.profile,
      credential: resolvedProvider.credential,
      requestedRunOptions: optionPlan.requestedRunOptions,
      runOptions: optionPlan.runOptions,
      unsupportedRunOptions: optionPlan.unsupportedRunOptions,
    };

    if (ownedChildRunId) {
      await this.trackExecution(execution, () =>
        this.executeRun(
          runWithMetadata,
          resolvedProvider.adapter,
          providerInput,
          execution,
          writer,
        ),
      );
    } else
      setImmediate(() => {
        void this.trackExecution(execution, () =>
          this.executeRun(
            runWithMetadata,
            resolvedProvider.adapter,
            providerInput,
            execution,
            writer,
          ),
        ).catch((error) =>
          this.handleQueuedExecutionError(run.id, execution, error),
        );
      });

    return {
      run: this.toPublicRunSummary(runWithMetadata),
      agentId: agent.id,
      agentName: agent.name,
      provider: resolvedProvider.adapter.id,
      providerProfileId: resolvedProvider.profile.id,
      providerResolution: toPublicProviderResolution(providerResolution),
      model: optionPlan.runOptions.model ?? null,
      runOptions: optionPlan.runOptions,
      requestedRunOptions: optionPlan.requestedRunOptions,
      unsupportedRunOptions: optionPlan.unsupportedRunOptions,
      usage: null,
      assistantMessageId: assistantMessage.id,
    };
  }

  cancelRun(runId: string): Run {
    const run = this.getRun(runId);
    if (new RunVO.Status(run.status).isTerminal()) {
      return run;
    }

    const cancellation = this.store.requestRunCancellation({
      runId,
      updatedAt: new Date().toISOString(),
      event: {
        id: randomUUID(),
        type: "run_cancelling",
        payload: { runId, status: "cancelling" },
      },
    });
    const cancellingRun = cancellation?.run ?? this.getRun(runId);
    if (new RunVO.Status(cancellingRun.status).isTerminal()) {
      return cancellingRun;
    }
    if (cancellation?.event) {
      this.eventBus.publish(cancellation.event);
    }
    this.subsessions.cancelOwned(runId);

    const execution = this.executions.get(runId);
    if (execution) {
      execution.termination = "cancelled";
      execution.controller.abort(new RunTerminationError("cancelled"));
      if (!execution.activePromise) {
        this.finalizeRequestedTermination(execution);
        this.releaseTerminalExecution(execution);
      }
    } else {
      this.finalizeRunTermination(cancellingRun, "cancelled");
    }
    return this.getRun(runId);
  }

  resumeRun(runId: string): Run {
    this.assertAcceptingWork();
    const run = this.getRun(runId);
    if (run.status !== "waiting_permission") {
      throw new KernelError("Run is not waiting for permission.", 409);
    }
    const pendingForRun = this.store
      .listPermissionRequests({ status: "pending" })
      .some((request) => request.runId === run.id);
    if (pendingForRun) {
      throw new KernelError(
        "Run still has pending permissions. Approve or deny them before resuming.",
        409,
      );
    }
    const now = new Date().toISOString();
    const resumed = this.store.transitionRunStatus(
      run.id,
      ["waiting_permission"],
      "running",
      null,
      now,
    );
    if (!resumed) {
      throw new KernelError("Run changed before it could be resumed.", 409);
    }
    this.store.mergeRunMetadata(
      run.id,
      { toolLoopState: "manual_resume_requested" },
      now,
    );
    this.queueResumeAgentRun(run.id);
    return this.getRun(run.id)!;
  }

  listRunEvents(runId: string, after = 0): RunEvent[] {
    this.getRun(runId);
    return this.store.listEvents(runId, after).map(toPublicRunEvent);
  }

  getLatestRunEventSeq(runId: string): number {
    this.getRun(runId);
    return this.store.getLatestEventSeq(runId);
  }

  subscribeRunEvents(runId: string, listener: RunEventListener): () => void {
    this.getRun(runId);
    return this.eventBus.subscribe(runId, (event) =>
      listener(toPublicRunEvent(event)),
    );
  }

  listPermissionRequests(
    status?: PermissionRequestType.Status,
  ): PermissionRequest[] {
    return this.store
      .listPermissionRequests(status ? { status } : {})
      .map(toPublicPermissionRequest);
  }

  async approvePermissionRequest(id: string): Promise<InvokeToolResponse> {
    this.assertAcceptingWork();
    const candidate = this.store.getPermissionRequest(id);
    if (
      candidate &&
      this.store.getRun(candidate.runId)?.status === "waiting_permission"
    ) {
      await this.executions.get(candidate.runId)?.activePromise;
    }
    const request = this.getResolvablePermissionRequest(id);
    const run = this.getRun(request.runId);
    if (run.status !== "waiting_permission") {
      throw new KernelError(
        "Permission request can only be approved while its run is waiting for permission.",
        409,
      );
    }

    const resolvedAt = new Date().toISOString();
    const approvedRequest = this.store.resolvePermissionRequest(
      request.id,
      "approved",
      resolvedAt,
    );
    if (!approvedRequest) {
      throw new KernelError(
        "Permission request or run changed before approval completed.",
        409,
      );
    }
    return this.executeApprovedPermission(approvedRequest);
  }

  private async executeApprovedPermission(
    approvedRequest: StoredPermissionRequest,
  ): Promise<InvokeToolResponse> {
    const request = approvedRequest;
    const run = this.getRun(request.runId);
    const resolvedAt = approvedRequest.resolvedAt ?? new Date().toISOString();
    const isAgentToolPermission =
      booleanField(request.metadata, "agentToolLoop") === true;
    let prepared: PreparedToolInvocation;
    try {
      if (isAgentToolPermission) {
        this.store.mergeRunMetadata(
          run.id,
          {
            toolLoopState: "resuming_after_permission",
            resolvedPermissionRequestId: request.id,
          },
          resolvedAt,
        );
      }
      const resumedRun = this.getRun(run.id);
      this.emit(resumedRun, "permission.approved", {
        requestId: approvedRequest.id,
        status: "approved",
        reason: approvedRequest.reason,
        riskLevel: approvedRequest.riskLevel,
        request: toPublicPermissionRequest(approvedRequest),
      });
      prepared = this.prepareToolInvocationFromPermission(approvedRequest);
    } catch (error) {
      this.failResolvedPermissionPreparation(run.id, error);
      throw error;
    }
    const response = await this.trackExecution(prepared.execution, () =>
      this.executePreparedToolInvocation(prepared, {
        state: "executed",
        permissionRequest: toPublicPermissionRequest(approvedRequest),
        finishRun: !isAgentToolPermission,
      }),
    );
    if (
      isAgentToolPermission &&
      this.store.getRun(approvedRequest.runId)?.status === "running"
    ) {
      this.queueResumeAgentRun(approvedRequest.runId);
    }
    return response;
  }

  denyPermissionRequest(id: string): InvokeToolResponse {
    this.assertAcceptingWork();
    const request = this.getResolvablePermissionRequest(id);
    const run = this.getRun(request.runId);
    const isAgentToolPermission =
      booleanField(request.metadata, "agentToolLoop") === true;
    if (run.status !== "waiting_permission") {
      throw new KernelError(
        "Permission request can only be denied while its run is waiting for permission.",
        409,
      );
    }

    const resolvedAt = new Date().toISOString();
    const deniedRequest = this.store.resolvePermissionRequest(
      request.id,
      "denied",
      resolvedAt,
    );
    if (!deniedRequest) {
      throw new KernelError(
        "Permission request or run changed before denial completed.",
        409,
      );
    }
    let prepared: PreparedToolInvocation;
    try {
      if (isAgentToolPermission) {
        this.store.mergeRunMetadata(
          run.id,
          {
            toolLoopState: "resuming_after_permission_denial",
            resolvedPermissionRequestId: request.id,
          },
          resolvedAt,
        );
      }
      const resumedRun = this.getRun(run.id);
      this.emit(resumedRun, "permission.denied", {
        requestId: deniedRequest.id,
        status: "denied",
        reason: deniedRequest.reason,
        riskLevel: deniedRequest.riskLevel,
        request: toPublicPermissionRequest(deniedRequest),
      });
      prepared = this.prepareToolInvocationFromPermission(deniedRequest);
    } catch (error) {
      this.failResolvedPermissionPreparation(run.id, error);
      throw error;
    }
    const response = this.denyPreparedToolInvocation(prepared, deniedRequest, {
      finishRun: !isAgentToolPermission,
    });
    if (
      isAgentToolPermission &&
      this.store.getRun(deniedRequest.runId)?.status === "running"
    ) {
      this.queueResumeAgentRun(deniedRequest.runId);
    } else {
      this.releaseTerminalExecution(prepared.execution);
    }
    return response;
  }

  private prepareToolInvocation(
    sessionId: string,
    toolId: string,
    input: JsonObject,
    options: InvokeToolOptions,
  ): PreparedToolInvocation {
    const session = this.getSession(sessionId);
    const registeredTool = this.tools.get(toolId.trim());
    if (!registeredTool) {
      throw new KernelError("Tool not found", 404);
    }

    const toolSettings = this.getToolSettings();
    const executionCwd = this.getToolExecutionCwd(session);
    const validationContext = { cwd: executionCwd };
    let executionInput: JsonObject;
    let publicInput: JsonObject;
    try {
      executionInput =
        registeredTool.executor.validateInput?.(input, validationContext) ??
        input;
      publicInput =
        registeredTool.executor.toPublicInput?.(
          executionInput,
          validationContext,
        ) ?? executionInput;
    } catch (error) {
      if (error instanceof ToolInputError) {
        throw new KernelError(error.message, error.statusCode);
      }
      throw error;
    }

    const caller = options.caller ?? "manual";
    const permission = evaluateToolPermission({
      tool: registeredTool.definition,
      caller,
      publicInput,
      executionInput,
      executionCwd,
      settings: toolSettings,
    });
    const now = new Date().toISOString();
    const run = this.createRun({
      id: randomUUID(),
      sessionId,
      provider: `tool:${registeredTool.definition.id}`,
      status: "running",
      segmentId: session.activeSegmentId,
      createdAt: now,
      updatedAt: now,
      metadata: buildToolRunMetadata(
        registeredTool.definition,
        publicInput,
        caller,
        permission,
        executionCwd,
      ),
    });
    this.store.touchSession(sessionId, now);

    const assistantMessage = this.store.createMessage({
      id: randomUUID(),
      sessionId,
      runId: run.id,
      segmentId: session.activeSegmentId,
      role: "assistant",
      status: "streaming",
      createdAt: now,
      updatedAt: now,
      metadata: buildToolMessageMetadata(
        registeredTool.definition,
        publicInput,
        caller,
        permission,
      ),
    });

    const invocation: ToolInvocation = {
      id: randomUUID(),
      toolId: registeredTool.definition.id,
      toolName: registeredTool.definition.name,
      sessionId,
      runId: run.id,
      messageId: assistantMessage.id,
      caller,
      status:
        permission.decision === "allowed" ? "created" : "pending_permission",
      permissionDecision: permission.decision,
      input: publicInput,
      metadata: {
        toolSource: registeredTool.definition.source,
        executionCwd,
        permissionRuleId: permission.ruleId,
        riskLevel: permission.riskLevel,
      },
      createdAt: now,
      updatedAt: now,
    };

    this.emit(run, "run_started", {
      runId: run.id,
      sessionId,
      provider: "tool",
      toolId: registeredTool.definition.id,
      toolName: registeredTool.definition.name,
      caller,
      permissionDecision: permission.decision,
      permissionAction: permission.action,
      permissionRuleId: permission.ruleId,
      riskLevel: permission.riskLevel,
    });
    this.emit(run, "assistant_message_created", {
      message: this.store.getMessage(assistantMessage.id)!,
    });

    const execution = this.getOrCreateExecution(run.id);
    const writer = new RunWriter({
      store: this.store,
      eventBus: this.eventBus,
      run,
      assistantMessageId: assistantMessage.id,
      signal: execution.controller.signal,
    });

    const toolCallPart = writer.recordToolCall({
      callId: invocation.id,
      toolId: registeredTool.definition.id,
      toolName: registeredTool.definition.name,
      provider: toolProviderForPart(registeredTool.definition.id),
      input: publicInput,
      inputSummary: summarizeToolInput(
        registeredTool.definition.id,
        publicInput,
      ),
      metadata: {
        caller,
        permissionDecision: permission.decision,
        permissionAction: permission.action,
        permissionRuleId: permission.ruleId,
        riskLevel: permission.riskLevel,
        toolSource: registeredTool.definition.source,
      },
    });

    const commandOutputPart =
      registeredTool.definition.id === "shell.exec"
        ? writer.recordCommandOutput({
            callId: invocation.id,
            stream: "combined",
            text: "",
            cwd: stringField(executionInput, "cwd"),
            metadata: {
              invocationId: invocation.id,
              toolId: registeredTool.definition.id,
            },
          })
        : null;

    return {
      registeredTool,
      executionInput,
      publicInput,
      executionCwd,
      caller,
      permission,
      run,
      assistantMessage,
      invocation,
      writer,
      toolCallPart,
      commandOutputPart,
      createdAt: now,
      resumeAgentRun: false,
      execution,
    };
  }

  private prepareToolInvocationFromPermission(
    request: StoredPermissionRequest,
  ): PreparedToolInvocation {
    const registeredTool = this.tools.get(request.toolId);
    if (!registeredTool) {
      throw new KernelError("Tool not found for permission request", 404);
    }
    const run = this.getRun(request.runId);
    const assistantMessage = this.store.getMessage(request.messageId);
    if (!assistantMessage) {
      throw new KernelError(
        "Assistant message for permission request not found",
        404,
      );
    }
    const toolCallPart = assistantMessage.parts.find(
      (part) => part.id === request.toolCallPartId,
    );
    if (!toolCallPart) {
      throw new KernelError(
        "Tool call part for permission request not found",
        404,
      );
    }
    const commandOutputPart = request.commandOutputPartId
      ? (assistantMessage.parts.find(
          (part) => part.id === request.commandOutputPartId,
        ) ?? null)
      : null;
    if (!commandOutputPart && request.toolId === "shell.exec") {
      throw new KernelError(
        "Command output part for permission request not found",
        404,
      );
    }

    const executionCwd =
      stringField(request.metadata, "executionCwd") ||
      this.getToolExecutionCwd(this.getSession(request.sessionId));
    const permission = permissionEvaluationFromRequest(request, executionCwd);
    const invocation: ToolInvocation = {
      id: request.invocationId,
      toolId: request.toolId,
      toolName: request.toolName,
      sessionId: request.sessionId,
      runId: request.runId,
      messageId: request.messageId,
      caller: request.caller,
      status: new PermissionRequestVO.Status(request.status).isApproved() ? "created" : "pending_permission",
      permissionDecision: request.permissionDecision,
      input: request.publicInput,
      metadata: request.metadata,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    };

    const execution = this.getOrCreateExecution(run.id);
    return {
      registeredTool,
      executionInput: request.executionInput,
      publicInput: request.publicInput,
      executionCwd,
      caller: request.caller,
      permission,
      run,
      assistantMessage,
      invocation,
      writer: new RunWriter({
        store: this.store,
        eventBus: this.eventBus,
        run,
        assistantMessageId: assistantMessage.id,
        signal: execution.controller.signal,
      }),
      toolCallPart,
      commandOutputPart,
      createdAt: request.createdAt,
      resumeAgentRun: booleanField(request.metadata, "agentToolLoop") === true,
      toolLoopIteration:
        numberField(request.metadata, "toolLoopIteration") ?? undefined,
      providerToolCallName:
        stringField(request.metadata, "providerToolCallName") || undefined,
      execution,
    };
  }

  private createPendingPermissionResponse(
    prepared: PreparedToolInvocation,
  ): InvokeToolResponse {
    const now = new Date().toISOString();
    const executionCwd = prepared.executionCwd;
    const toolCallPart = this.updateToolCallStatus(
      prepared.toolCallPart,
      "pending_permission",
      now,
    );
    const permissionRequest = this.store.createPermissionRequest({
      id: randomUUID(),
      sessionId: prepared.invocation.sessionId,
      runId: prepared.run.id,
      messageId: prepared.assistantMessage.id,
      invocationId: prepared.invocation.id,
      toolId: prepared.registeredTool.definition.id,
      toolName: prepared.registeredTool.definition.name,
      caller: prepared.caller,
      permissionDecision: prepared.permission.decision,
      inputSummary: summarizeToolInput(
        prepared.registeredTool.definition.id,
        prepared.publicInput,
      ),
      publicInput: prepared.publicInput,
      executionInput: prepared.executionInput,
      riskLevel: prepared.permission.riskLevel,
      reason: prepared.permission.reason,
      status: "pending",
      toolCallPartId: toolCallPart.id,
      commandOutputPartId: prepared.commandOutputPart?.id,
      metadata: {
        toolSource: prepared.registeredTool.definition.source,
        executionCwd,
        permissionAction: prepared.permission.action,
        permissionRuleId: prepared.permission.ruleId,
        policy: permissionPolicySummary(prepared.permission),
        ...(prepared.resumeAgentRun
          ? {
              agentToolLoop: true,
              resumeOnApproval: true,
              toolLoopIteration: prepared.toolLoopIteration ?? null,
              providerToolCallName: prepared.providerToolCallName ?? null,
            }
          : {}),
      },
      createdAt: now,
      updatedAt: now,
    });

    this.emit(prepared.run, "permission.requested", {
      requestId: permissionRequest.id,
      status: "requested",
      reason: permissionRequest.reason,
      riskLevel: permissionRequest.riskLevel,
      request: toPublicPermissionRequest(permissionRequest),
    });

    this.markRunWaitingForPermission(
      prepared.run,
      prepared.assistantMessage.id,
      permissionRequest.id,
    );
    const waitingMessage = this.store.getMessage(prepared.assistantMessage.id);
    if (waitingMessage) {
      this.emit(prepared.run, "assistant_message_updated", {
        message: waitingMessage,
      });
    }
    prepared.execution.phase = "waiting_permission";
    prepared.execution.toolId = prepared.registeredTool.definition.id;

    return {
      state: "pending_permission",
      invocation: toPublicToolInvocation({
        ...prepared.invocation,
        status: "pending_permission",
        updatedAt: now,
      }),
      permissionRequest: toPublicPermissionRequest(permissionRequest),
      run: this.toPublicRunSummary(this.store.getRun(prepared.run.id)!),
      message: toPublicMessage(
        this.store.getMessage(prepared.assistantMessage.id)!,
      ),
      toolCallPartId: toolCallPart.id,
      commandOutputPartId: prepared.commandOutputPart?.id,
    };
  }

  private async executePreparedToolInvocation(
    prepared: PreparedToolInvocation,
    responseOptions: {
      state: "executed";
      permissionRequest?: PermissionRequest;
      finishRun?: boolean;
    },
  ): Promise<InvokeToolResponse> {
    if (prepared.registeredTool.definition.id !== "shell.exec") {
      return this.executeGenericTool(prepared, responseOptions);
    }
    const {
      registeredTool,
      executionInput,
      caller,
      permission,
      run,
      assistantMessage,
      invocation,
      writer,
    } = prepared;
    const execution = prepared.execution;
    execution.phase = "tool";
    execution.toolId = registeredTool.definition.id;
    const executionCwd = prepared.executionCwd;
    const commandOutputMaxChars = commandOutputMaxCharsForTool(
      registeredTool.definition.id,
      this.getToolSettings(),
    );
    let toolCallPart = prepared.toolCallPart;
    if (!prepared.commandOutputPart)
      throw new Error("Shell output part is missing.");
    let commandOutputPart: MessagePart = prepared.commandOutputPart;
    let commandOutputText =
      partString(commandOutputPart, "text") || commandOutputPart.text || "";
    let commandOutputTruncated = false;

    const startedAt = new Date().toISOString();
    const runningInvocation: ToolInvocation = {
      ...invocation,
      status: "running",
      updatedAt: startedAt,
    };
    toolCallPart = this.updateToolCallStatus(
      toolCallPart,
      "running",
      startedAt,
    );
    this.emit(run, "tool.started", {
      messageId: assistantMessage.id,
      partId: toolCallPart.id,
      part: toolCallPart,
      outputPartId: commandOutputPart.id,
      outputPart: commandOutputPart,
      callId: invocation.id,
      toolId: registeredTool.definition.id,
      toolName: registeredTool.definition.name,
      caller,
      permissionDecision: permission.decision,
      permissionAction: permission.action,
      permissionRuleId: permission.ruleId,
      riskLevel: permission.riskLevel,
      status: "running",
    });

    const onToolEvent = (event: ToolExecutionEvent): void => {
      const currentRun = this.store.getRun(run.id);
      if (
        execution.controller.signal.aborted ||
        !currentRun ||
        new RunVO.Status(currentRun.status).isTerminal()
      ) {
        return;
      }
      if (
        event.type === "tool.stdout.delta" ||
        event.type === "tool.stderr.delta"
      ) {
        const delta =
          typeof event.payload.text === "string" ? event.payload.text : "";
        if (!delta) {
          return;
        }
        const nextOutput = appendLimitedText(
          commandOutputText,
          commandOutputTruncated,
          delta,
          commandOutputMaxChars,
          "command output",
        );
        commandOutputText = nextOutput.text;
        commandOutputTruncated = nextOutput.truncated;
        const updatedAt = new Date().toISOString();
        commandOutputPart = this.updateCommandOutputPart(
          commandOutputPart,
          commandOutputText,
          updatedAt,
          {
            truncated: commandOutputTruncated,
          },
        );
        this.emit(run, event.type, {
          ...event.payload,
          messageId: assistantMessage.id,
          partId: commandOutputPart.id,
          part: commandOutputPart,
          callId: invocation.id,
          toolId: registeredTool.definition.id,
          toolName: registeredTool.definition.name,
        });
        return;
      }

      this.emit(run, event.type, {
        ...event.payload,
        messageId: assistantMessage.id,
        callId: invocation.id,
        toolId: registeredTool.definition.id,
        toolName: registeredTool.definition.name,
      });
    };

    let result: ToolExecutionResult;
    try {
      const output = await registeredTool.executor.execute(executionInput, {
        invocation: runningInvocation,
        cwd: executionCwd,
        signal: execution.controller.signal,
        emit: onToolEvent,
      });
      if (execution.controller.signal.aborted) {
        throw new ToolExecutionAbortError(
          "Tool execution was cancelled.",
          output,
        );
      }
      const completedAt = new Date().toISOString();
      result = buildToolExecutionResult(
        invocation,
        registeredTool.definition.id,
        output,
        startedAt,
        completedAt,
      );
    } catch (error) {
      const completedAt = new Date().toISOString();
      const toolError = toError(error);
      const cancelled =
        execution.controller.signal.aborted ||
        error instanceof ToolExecutionAbortError ||
        isAbortLike(error);
      result = {
        invocationId: invocation.id,
        toolId: registeredTool.definition.id,
        status: cancelled ? "cancelled" : "failed",
        output: error instanceof ToolExecutionAbortError ? error.output : {},
        error: toolError.message,
        startedAt,
        completedAt,
        durationMs: Math.max(
          0,
          Date.parse(completedAt) - Date.parse(startedAt),
        ),
        metadata: {
          ...(cancelled ? { cancelled: true } : { failedBeforeResult: true }),
        },
      };
    }

    const completedAt = result.completedAt;
    const finalInvocation: ToolInvocation = {
      ...invocation,
      status: result.status,
      updatedAt: completedAt,
    };
    const persistedRun = this.store.getRun(run.id);
    const terminating = execution.controller.signal.aborted;
    if (!persistedRun || new RunVO.Status(persistedRun.status).isTerminal()) {
      return {
        state: responseOptions.state,
        invocation: toPublicToolInvocation(finalInvocation),
        result: toPublicToolExecutionResult(result),
        permissionRequest: responseOptions.permissionRequest,
        run: this.toPublicRunSummary(
          this.store.getRun(run.id) ?? persistedRun ?? run,
        ),
        message: toPublicMessage(this.store.getMessage(assistantMessage.id)!),
        toolCallPartId: toolCallPart.id,
        commandOutputPartId: commandOutputPart.id,
      };
    }
    if (!terminating && persistedRun.status !== "running") {
      if (persistedRun.status === "cancelling") {
        this.finishAbortedWriter(execution, writer);
      }
      return {
        state: responseOptions.state,
        invocation: toPublicToolInvocation(finalInvocation),
        result: toPublicToolExecutionResult(result),
        permissionRequest: responseOptions.permissionRequest,
        run: this.toPublicRunSummary(this.store.getRun(run.id) ?? persistedRun),
        message: toPublicMessage(this.store.getMessage(assistantMessage.id)!),
        toolCallPartId: toolCallPart.id,
        commandOutputPartId: commandOutputPart.id,
      };
    }
    commandOutputPart = this.updateCommandOutputPart(
      commandOutputPart,
      commandOutputText,
      completedAt,
      commandOutputMetadataFromResult(result, commandOutputTruncated),
    );
    toolCallPart = this.updateToolCallStatus(
      toolCallPart,
      terminating ? "cancelled" : result.status,
      completedAt,
    );
    this.emit(
      run,
      !terminating && result.status === "completed"
        ? "tool.completed"
        : "tool.failed",
      {
        messageId: assistantMessage.id,
        partId: toolCallPart.id,
        part: toolCallPart,
        outputPartId: commandOutputPart.id,
        outputPart: commandOutputPart,
        callId: invocation.id,
        toolId: registeredTool.definition.id,
        toolName: registeredTool.definition.name,
        status: terminating ? "cancelled" : result.status,
        error: result.error,
        durationMs: result.durationMs,
      },
    );
    const toolResultPart = writer.recordToolResult(
      {
        callId: invocation.id,
        toolId: registeredTool.definition.id,
        toolName: registeredTool.definition.name,
        status: terminating ? "cancelled" : result.status,
        outputSummary: summarizeToolResult(result),
        error: result.error ?? undefined,
        metadata: {
          durationMs: result.durationMs,
          permissionDecision: permission.decision,
          permissionAction: permission.action,
          permissionRuleId: permission.ruleId,
          riskLevel: permission.riskLevel,
          ...(prepared.resumeAgentRun
            ? {
                agentToolLoop: true,
                toolLoopIteration: prepared.toolLoopIteration ?? null,
                providerToolCallName: prepared.providerToolCallName ?? null,
              }
            : {}),
          ...(result.metadata ?? {}),
        },
      },
      { allowWhileTerminating: terminating },
    );

    if (terminating) {
      this.finishAbortedWriter(execution, writer);
      return {
        state: responseOptions.state,
        invocation: toPublicToolInvocation(finalInvocation),
        result: toPublicToolExecutionResult(result),
        permissionRequest: responseOptions.permissionRequest,
        run: this.toPublicRunSummary(this.store.getRun(run.id) ?? persistedRun),
        message: toPublicMessage(this.store.getMessage(assistantMessage.id)!),
        toolCallPartId: toolCallPart.id,
        commandOutputPartId: commandOutputPart.id,
        toolResultPartId: toolResultPart.id,
      };
    }

    if (responseOptions.finishRun !== false) {
      if (result.status === "completed") {
        writer.complete();
      } else if (result.status === "cancelled") {
        if (execution.termination === "interrupted") {
          writer.interrupt();
        } else {
          writer.cancel();
        }
      } else {
        writer.fail(new Error(result.error ?? "Tool execution failed."));
      }
    }

    return {
      state: responseOptions.state,
      invocation: toPublicToolInvocation(finalInvocation),
      result: toPublicToolExecutionResult(result),
      permissionRequest: responseOptions.permissionRequest,
      run: this.toPublicRunSummary(this.store.getRun(run.id)!),
      message: toPublicMessage(this.store.getMessage(assistantMessage.id)!),
      toolCallPartId: toolCallPart.id,
      commandOutputPartId: commandOutputPart.id,
      toolResultPartId: toolResultPart.id,
    };
  }

  private async executeGenericTool(
    prepared: PreparedToolInvocation,
    options: {
      state: "executed";
      permissionRequest?: PermissionRequest;
      finishRun?: boolean;
    },
  ): Promise<InvokeToolResponse> {
    const { invocation, writer, run, execution } = prepared;
    execution.phase = "tool";
    execution.toolId = prepared.registeredTool.definition.id;
    this.updateToolCallStatus(
      prepared.toolCallPart,
      "running",
      new Date().toISOString(),
    );
    let output: JsonObject = {},
      error: string | null = null;
    try {
      if (execution.controller.signal.aborted)
        throw new ToolExecutionAbortError();
      if (invocation.toolId === "subsession.start" && !prepared.resumeAgentRun)
        throw new Error("Delegation requires an owning model run.");
      output = await prepared.registeredTool.executor.execute(
        prepared.executionInput,
        {
          invocation,
          cwd: prepared.executionCwd,
          signal: execution.controller.signal,
          emit: () => undefined,
        },
      );
    } catch (failure) {
      error = sanitizedCompactionError(failure);
      if (failure instanceof SubsessionAdmissionError)
        output = { code: failure.code, ...failure.details };
      if (failure instanceof ToolExecutionAbortError) output = failure.output;
    }
    const now = new Date().toISOString();
    const persistedRun = this.store.getRun(run.id);
    const terminating =
      execution.controller.signal.aborted ||
      persistedRun?.status === "cancelling" ||
      new RunVO.Status(persistedRun?.status).isStopped();
    const status = terminating ? "cancelled" : error ? "failed" : "completed";
    const result: ToolExecutionResult = {
      invocationId: invocation.id,
      toolId: invocation.toolId,
      status,
      output,
      error,
      metadata: {},
      startedAt: prepared.createdAt,
      completedAt: now,
      durationMs: Math.max(0, Date.parse(now) - Date.parse(prepared.createdAt)),
    };
    const response = (toolResultPartId?: string): InvokeToolResponse => ({
      state: "executed",
      invocation: toPublicToolInvocation({
        ...invocation,
        status,
        updatedAt: now,
      }),
      result: toPublicToolExecutionResult(result),
      permissionRequest: options.permissionRequest,
      run: this.toPublicRunSummary(
        this.store.getRun(run.id) ?? persistedRun ?? run,
      ),
      message: toPublicMessage(this.store.getMessage(writer.messageId)!),
      toolCallPartId: prepared.toolCallPart.id,
      ...(toolResultPartId ? { toolResultPartId } : {}),
    });
    // A terminal CAS winner owns final state. Late executors return a public result without further writes/events.
    if (!persistedRun || new RunVO.Status(persistedRun.status).isTerminal())
      return response();
    if (!terminating && persistedRun.status !== "running") return response();
    const part = writer.recordToolResult(
      {
        callId: invocation.id,
        toolId: invocation.toolId,
        toolName: invocation.toolName,
        status,
        outputSummary: boundHistoricalContextText(
          JSON.stringify(error ? { error, ...output } : output),
          6000,
        ),
        ...(error ? { error } : {}),
      },
      { allowWhileTerminating: terminating },
    );
    this.updateToolCallStatus(prepared.toolCallPart, status, now);
    this.emit(run, status === "completed" ? "tool.completed" : "tool.failed", {
      runId: run.id,
      messageId: writer.messageId,
      toolId: invocation.toolId,
      callId: invocation.id,
      status,
    });
    if (terminating) this.finishAbortedWriter(execution, writer);
    else if (options.finishRun !== false) {
      if (error) writer.fail(new Error(error));
      else writer.complete();
    }
    return response(part.id);
  }

  private denyPreparedToolInvocation(
    prepared: PreparedToolInvocation,
    request: StoredPermissionRequest | null,
    options: { finishRun?: boolean } = {},
  ): InvokeToolResponse {
    const now = new Date().toISOString();
    const executionCwd = prepared.executionCwd;
    const permissionRequest =
      request ??
      this.store.createPermissionRequest({
        id: randomUUID(),
        sessionId: prepared.invocation.sessionId,
        runId: prepared.run.id,
        messageId: prepared.assistantMessage.id,
        invocationId: prepared.invocation.id,
        toolId: prepared.registeredTool.definition.id,
        toolName: prepared.registeredTool.definition.name,
        caller: prepared.caller,
        permissionDecision: prepared.permission.decision,
        inputSummary: summarizeToolInput(
          prepared.registeredTool.definition.id,
          prepared.publicInput,
        ),
        publicInput: prepared.publicInput,
        executionInput: prepared.executionInput,
        riskLevel: prepared.permission.riskLevel,
        reason: prepared.permission.reason,
        status: "denied",
        toolCallPartId: prepared.toolCallPart.id,
        commandOutputPartId: prepared.commandOutputPart?.id,
        metadata: {
          toolSource: prepared.registeredTool.definition.source,
          executionCwd,
          permissionAction: prepared.permission.action,
          permissionRuleId: prepared.permission.ruleId,
          policy: permissionPolicySummary(prepared.permission),
          ...(prepared.resumeAgentRun
            ? {
                agentToolLoop: true,
                toolLoopIteration: prepared.toolLoopIteration ?? null,
                providerToolCallName: prepared.providerToolCallName ?? null,
              }
            : {}),
        },
        createdAt: now,
        updatedAt: now,
        resolvedAt: now,
      });

    if (!request) {
      this.emit(prepared.run, "permission.denied", {
        requestId: permissionRequest.id,
        status: "denied",
        reason: permissionRequest.reason,
        riskLevel: permissionRequest.riskLevel,
        request: toPublicPermissionRequest(permissionRequest),
      });
    }

    const completedAt = new Date().toISOString();
    const result = buildPermissionBlockedResult(
      prepared.invocation,
      prepared.registeredTool.definition.id,
      request ? "denied" : prepared.permission.decision,
      prepared.permission.reason,
      prepared.createdAt,
      completedAt,
    );
    const toolCallPart = this.updateToolCallStatus(
      prepared.toolCallPart,
      result.status,
      completedAt,
    );
    const toolResultPart = prepared.writer.recordToolResult({
      callId: prepared.invocation.id,
      toolId: prepared.registeredTool.definition.id,
      toolName: prepared.registeredTool.definition.name,
      status: result.status,
      outputSummary:
        result.error ?? "Tool execution denied by permission policy.",
      error: result.error ?? undefined,
      metadata: {
        permissionDecision: prepared.permission.decision,
        permissionAction: prepared.permission.action,
        permissionRuleId: prepared.permission.ruleId,
        riskLevel: prepared.permission.riskLevel,
        permissionRequestId: permissionRequest.id,
        ...(prepared.resumeAgentRun
          ? {
              agentToolLoop: true,
              toolLoopIteration: prepared.toolLoopIteration ?? null,
              providerToolCallName: prepared.providerToolCallName ?? null,
            }
          : {}),
      },
    });
    if (options.finishRun !== false) {
      prepared.writer.fail(
        new Error(
          result.error ?? "Tool execution denied by permission policy.",
        ),
      );
    }

    return {
      state: "denied",
      invocation: toPublicToolInvocation({
        ...prepared.invocation,
        status: result.status,
        updatedAt: completedAt,
      }),
      result: toPublicToolExecutionResult(result),
      permissionRequest: toPublicPermissionRequest(permissionRequest),
      run: this.toPublicRunSummary(this.store.getRun(prepared.run.id)!),
      message: toPublicMessage(
        this.store.getMessage(prepared.assistantMessage.id)!,
      ),
      toolCallPartId: toolCallPart.id,
      commandOutputPartId: prepared.commandOutputPart?.id,
      toolResultPartId: toolResultPart.id,
    };
  }

  private getResolvablePermissionRequest(id: string): StoredPermissionRequest {
    const request = this.store.getPermissionRequest(id);
    if (!request) {
      throw new KernelError("Permission request not found", 404);
    }
    if (!new PermissionRequestVO.Status(request.status).isPending()) {
      throw new KernelError(
        `Permission request is already ${request.status}.`,
        409,
      );
    }
    return request;
  }

  private getOrCreateExecution(runId: string): RunExecution {
    const existing = this.executions.get(runId);
    if (existing) {
      return existing;
    }
    const execution: RunExecution = {
      runId,
      controller: new AbortController(),
      phase: "idle",
      providerId: null,
      toolId: null,
      termination: null,
      activePromise: null,
    };
    this.executions.set(runId, execution);
    return execution;
  }

  private createRun(input: CreateRunInput): Run {
    try {
      return this.store.createRun(input);
    } catch (error) {
      if (error instanceof ActiveRunExistsStoreError) {
        throw new KernelError(
          "This session already has an active run. Reconnect to or cancel it before starting another run.",
          409,
          "active_run_exists",
          { run: this.toPublicRunSummary(error.activeRun) },
        );
      }
      throw error;
    }
  }

  private toPublicRunSummary(run: Run): PublicRunSummary {
    const children = this.store.subsessions.list(run.id);
    return {
      children: {
        unfinished: children.filter((item) => item.result === null).length,
        pendingResults: children.filter(
          (item) => item.result !== null && !item.acknowledged,
        ).length,
      },
      id: run.id,
      sessionId: run.sessionId,
      provider: sanitizedPublicString(run.provider, 160) ?? "unknown",
      status: run.status,
      model: sanitizedPublicString(run.model, 240),
      runOptions: publicRunOptions(run.runOptions),
      usage: run.usage ? { ...run.usage } : null,
      currentPhase: this.publicRunPhase(run),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      error: sanitizedPublicString(run.error, 1_000),
      context: publicContextPlanSummary(
        contextPlanRecordObjects(run.metadata).at(-1),
      ),
    };
  }

  private publicRunPhase(run: Run): PublicRunPhase | null {
    if (run.status === "waiting_children") return "waiting_children";
    if (run.status === "waiting_permission") {
      return "waiting_permission";
    }
    if (run.status === "cancelling") {
      return "cancelling";
    }
    if (run.status !== "running") {
      return null;
    }
    const phase = this.executions.get(run.id)?.phase;
    return phase === "provider" ||
      phase === "tool" ||
      phase === "compacting_context"
      ? phase
      : "running";
  }

  private assertAcceptingWork(): void {
    if (this.shuttingDown) {
      throw new KernelError(
        "The daemon is shutting down and is not accepting new work.",
        503,
      );
    }
  }

  private async trackExecution<T>(
    execution: RunExecution,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (execution.activePromise) {
      throw new KernelError(
        `Run '${execution.runId}' already has active work.`,
        409,
      );
    }

    let activePromise: Promise<T> | null = null;
    try {
      const run = this.store.getRun(execution.runId);
      if (!run || run.status !== "running") {
        throw new KernelError(
          `Run '${execution.runId}' is not available for execution.`,
          409,
        );
      }
      if (execution.controller.signal.aborted) {
        throw execution.controller.signal.reason instanceof Error
          ? execution.controller.signal.reason
          : new RunTerminationError(execution.termination ?? "cancelled");
      }

      activePromise = operation();
      execution.activePromise = activePromise;
      return await activePromise;
    } catch (error) {
      this.finalizeExecutionError(execution, error);
      throw error;
    } finally {
      if (activePromise && execution.activePromise === activePromise) {
        execution.activePromise = null;
      }
      const run = this.store.getRun(execution.runId);
      execution.phase =
        run?.status === "waiting_permission" ? "waiting_permission" : "idle";
      if (execution.phase === "idle") {
        execution.toolId = null;
      }
      this.finalizeRequestedTermination(execution);
      this.releaseTerminalExecution(execution);
      this.subsessions.changed();
    }
  }

  private finishAbortedWriter(
    execution: RunExecution,
    writer: RunWriter,
  ): void {
    if (execution.termination === "interrupted") {
      writer.interrupt();
    } else {
      writer.cancel();
    }
  }

  private finalizeRequestedTermination(execution: RunExecution): void {
    if (!execution.termination) {
      return;
    }
    const run = this.store.getRun(execution.runId);
    if (!run || new RunVO.Status(run.status).isTerminal()) {
      return;
    }
    if (execution.termination === "cancelled" && run.status !== "cancelling") {
      return;
    }
    this.finalizeRunTermination(run, execution.termination);
  }

  private finalizeRunTermination(
    run: Run,
    termination: RunTermination,
    reason?: string,
  ): void {
    if (new RunVO.Status(run.status).isTerminal()) {
      return;
    }
    const assistantMessage = this.getLatestAssistantMessageForRun(run.id);
    if (assistantMessage) {
      const writer = new RunWriter({
        store: this.store,
        eventBus: this.eventBus,
        run: this.store.getRun(run.id) ?? run,
        assistantMessageId: assistantMessage.id,
      });
      if (termination === "interrupted") {
        writer.interrupt(reason);
      } else {
        writer.cancel();
      }
      return;
    }

    const updatedAt = new Date().toISOString();
    const error =
      termination === "interrupted"
        ? (reason ??
          "The daemon stopped before the run reached a terminal state.")
        : null;
    const status = termination === "interrupted" ? "interrupted" : "cancelled";
    const result = this.store.finalizeRun({
      runId: run.id,
      expectedStatuses:
        termination === "interrupted"
          ? ["running", "cancelling"]
          : ["running", "waiting_permission", "waiting_children", "cancelling"],
      status,
      error,
      updatedAt,
      event: {
        id: randomUUID(),
        type:
          termination === "interrupted" ? "run_interrupted" : "run_cancelled",
        payload: {
          ...(error ? { error } : {}),
          runId: run.id,
        },
      },
    });
    if (result) {
      this.eventBus.publish(result.event);
    }
  }

  private releaseTerminalExecution(execution: RunExecution): void {
    const run = this.store.getRun(execution.runId);
    if (
      run &&
      new RunVO.Status(run.status).isTerminal() &&
      this.executions.get(execution.runId) === execution
    ) {
      this.executions.delete(execution.runId);
    }
  }

  private handleQueuedExecutionError(
    runId: string,
    execution: RunExecution,
    error: unknown,
  ): void {
    if (
      error instanceof KernelError &&
      error.statusCode === 409 &&
      execution.activePromise
    ) {
      return;
    }
    const run = this.store.getRun(runId);
    if (!run || new RunVO.Status(run.status).isTerminal()) {
      this.releaseTerminalExecution(execution);
      return;
    }
    console.error("Agent run execution failed", {
      runId,
      error: toError(error).message,
    });
    this.finalizeExecutionError(execution, error);
  }

  private finalizeExecutionError(
    execution: RunExecution,
    error: unknown,
  ): void {
    const run = this.store.getRun(execution.runId);
    if (!run || new RunVO.Status(run.status).isTerminal()) {
      return;
    }
    if (execution.controller.signal.aborted || isAbortLike(error)) {
      if (execution.termination) {
        this.finalizeRequestedTermination(execution);
      } else {
        this.finalizeRunTermination(run, "cancelled");
      }
      return;
    }
    if (run.status !== "running") {
      return;
    }

    const runError = toError(error);
    const assistantMessage = this.getLatestAssistantMessageForRun(run.id);
    if (assistantMessage) {
      new RunWriter({
        store: this.store,
        eventBus: this.eventBus,
        run,
        assistantMessageId: assistantMessage.id,
      }).fail(runError);
      return;
    }
    const result = this.store.finalizeRun({
      runId: run.id,
      expectedStatuses: ["running"],
      status: "failed",
      error: runError.message,
      updatedAt: new Date().toISOString(),
      event: {
        id: randomUUID(),
        type: "run_failed",
        payload: { runId: run.id, error: runError.message },
      },
    });
    if (result) {
      this.eventBus.publish(result.event);
    }
  }

  private failResolvedPermissionPreparation(
    runId: string,
    error: unknown,
  ): void {
    const execution = this.getOrCreateExecution(runId);
    this.finalizeExecutionError(execution, error);
    this.releaseTerminalExecution(execution);
  }

  private getToolSettings(): ToolSettings {
    return normalizeToolSettings(
      this.store.listSettings()[toolSettingsSettingKey],
    );
  }

  private getToolExecutionCwd(session: Session): string {
    const workingDirectory = resolve(
      session.workingDirectory || this.defaultWorkingDirectory,
    );
    assertExistingDirectory(workingDirectory, "Session workingDirectory");
    return workingDirectory;
  }

  private normalizeWorkingDirectory(
    value: string | undefined,
    options: { allowDefault: boolean },
  ): string {
    const candidate = value?.trim();
    if (!candidate) {
      if (options.allowDefault) {
        return this.defaultWorkingDirectory;
      }
      throw new KernelError(
        "Session workingDirectory must be a non-empty path.",
        400,
      );
    }

    const workingDirectory = resolve(candidate);
    assertExistingDirectory(workingDirectory, "Session workingDirectory");
    return workingDirectory;
  }

  private updateToolCallStatus(
    part: MessagePart,
    status: ToolInvocationStatus | ToolResultStatus,
    updatedAt: string,
  ): MessagePart {
    return (
      this.store.updateMessagePart({
        id: part.id,
        text: part.text,
        content: { ...part.content, status },
        metadata: part.metadata,
        updatedAt,
      }) ?? part
    );
  }

  private updateCommandOutputPart(
    part: MessagePart,
    text: string,
    updatedAt: string,
    metadata: JsonObject = {},
  ): MessagePart {
    const nextMetadata = { ...part.metadata, ...metadata };
    const nextContent: JsonObject = { ...part.content, text };
    if (typeof metadata.cwd === "string") {
      nextContent.cwd = metadata.cwd;
    }
    if (
      typeof metadata.exitCode === "number" &&
      Number.isFinite(metadata.exitCode)
    ) {
      nextContent.exitCode = metadata.exitCode;
    }
    if (typeof metadata.timedOut === "boolean") {
      nextContent.timedOut = metadata.timedOut;
    }
    if (typeof metadata.truncated === "boolean") {
      nextContent.truncated = metadata.truncated;
    }
    if (typeof metadata.stdoutTruncated === "boolean") {
      nextContent.stdoutTruncated = metadata.stdoutTruncated;
    }
    if (typeof metadata.stderrTruncated === "boolean") {
      nextContent.stderrTruncated = metadata.stderrTruncated;
    }

    return (
      this.store.updateMessagePart({
        id: part.id,
        text,
        content: nextContent,
        metadata: nextMetadata,
        updatedAt,
      }) ?? part
    );
  }

  private async executeRun(
    run: Run,
    provider: ProviderAdapter,
    input: ProviderRunInput,
    execution: RunExecution,
    writer: RunWriter,
  ): Promise<void> {
    let activeWriter = writer;
    execution.providerId = provider.id;
    try {
      await this.executeAgentToolLoop(
        run,
        provider,
        input,
        execution,
        writer,
        (nextWriter) => {
          activeWriter = nextWriter;
        },
      );
    } catch (error) {
      if (execution.controller.signal.aborted || isAbortLike(error)) {
        this.finishAbortedWriter(execution, activeWriter);
      } else {
        const runError = toError(error);
        if (error instanceof ProviderContextLengthError) {
          this.store.mergeRunMetadata(
            run.id,
            { errorCode: error.code, providerContextOverflow: true },
            new Date().toISOString(),
          );
        } else if (
          error instanceof KernelError &&
          error.code === "context_budget_exceeded"
        ) {
          this.store.mergeRunMetadata(
            run.id,
            { errorCode: error.code, contextPreflightOverflow: true },
            new Date().toISOString(),
          );
        }
        if (error instanceof NativeTranscriptError) {
          this.store.mergeRunMetadata(
            run.id,
            { errorCode: error.code },
            new Date().toISOString(),
          );
        }
        console.error("Provider run failed", {
          runId: run.id,
          provider: provider.id,
          error: runError.message,
        });
        activeWriter.fail(runError);
      }
    }
  }

  private async executeAgentToolLoop(
    run: Run,
    provider: ProviderAdapter,
    input: ProviderRunInput,
    execution: RunExecution,
    writer: RunWriter,
    onActiveWriterChange: (writer: RunWriter) => void,
    startingIteration = numberField(run.metadata, "toolIterations") ?? 0,
  ): Promise<void> {
    let iteration = startingIteration;
    let providerInput = input;
    let currentWriter = writer;

    while (true) {
      this.store.subsessions.reconcile();
      this.store.subsessions.deliver(run.id, currentWriter.messageId);
      const deliveredIds = this.store.subsessions
        .list(run.id)
        .filter((item) => item.deliveredPartId && !item.acknowledged)
        .map((item) => item.id);
      providerInput = this.withCurrentToolLoopContext(
        input,
        run.id,
        provider,
        iteration,
      );
      execution.phase = "provider";
      execution.toolId = null;
      this.store.mergeMessageMetadata(
        currentWriter.messageId,
        { providerResponseBatchId: `${run.id}:${iteration + 1}` },
        new Date().toISOString(),
      );
      const result = await provider.run(providerInput, {
        signal: execution.controller.signal,
        writer: currentWriter,
      });
      this.store.subsessions.acknowledge(run.id, deliveredIds);

      if (execution.controller.signal.aborted) {
        this.finishAbortedWriter(execution, currentWriter);
        return;
      }

      const toolCalls = result.toolCalls ?? [];
      if (toolCalls.length === 0) {
        const children = this.store.subsessions.list(run.id);
        if (
          children.some((item) => item.result === null || !item.acknowledged)
        ) {
          currentWriter.completeMessage();
          const waiting = this.store.transitionRunStatus(
            run.id,
            ["running"],
            "waiting_children",
            null,
            new Date().toISOString(),
          );
          if (waiting)
            this.emit(waiting, "run_waiting_children", {
              runId: run.id,
              sessionId: run.sessionId,
              status: "waiting_children",
              children: this.toPublicRunSummary(waiting).children,
            });
          this.subsessions.requestWake(run.id);
          return;
        }
        if (
          providerInput.context.agent.contextPolicy?.automaticCompaction !==
            false &&
          providerInput.context.plan.compactionRecommended &&
          !execution.controller.signal.aborted
        ) {
          try {
            execution.phase = "compacting_context";
            await this.coordinateCompaction(
              run.sessionId,
              this.store.getRun(run.id) ?? run,
              execution.controller.signal,
            );
          } catch (error) {
            if (!execution.controller.signal.aborted) {
              this.emit(run, "context_compaction_failed", {
                runId: run.id,
                sessionId: run.sessionId,
                sourceSegmentId: providerInput.context.plan.activeSegmentId,
                error: sanitizedCompactionError(error),
              });
              this.store.mergeRunMetadata(
                run.id,
                { contextCompactionWarning: sanitizedCompactionError(error) },
                new Date().toISOString(),
              );
            }
          }
          execution.phase = "provider";
        }
        if (execution.controller.signal.aborted) {
          this.finishAbortedWriter(execution, currentWriter);
          return;
        }
        currentWriter.writeMetadata({
          toolIterations: iteration,
          toolLoopState: "completed",
        });
        currentWriter.complete();
        return;
      }

      const nextIteration = iteration + 1;
      currentWriter.writeMetadata({
        toolIterations: nextIteration,
        toolLoopState: "executing_tools",
        modelToolCallCount: toolCalls.length,
      });

      const assistantMessage = this.store.getMessage(currentWriter.messageId);
      if (!assistantMessage) {
        throw new KernelError("Assistant message for run not found", 404);
      }

      const step = await this.handleModelToolCalls(
        run,
        currentWriter,
        assistantMessage,
        toolCalls,
        nextIteration,
      );
      if (step === "waiting_permission") {
        return;
      }
      if (execution.controller.signal.aborted) {
        this.finishAbortedWriter(execution, currentWriter);
        return;
      }

      currentWriter.completeMessage();
      iteration = nextIteration;
      currentWriter = this.createFollowUpAssistantWriter(
        run,
        iteration,
        execution,
      );
      onActiveWriterChange(currentWriter);
    }
  }

  private async handleModelToolCalls(
    run: Run,
    writer: RunWriter,
    assistantMessage: Message,
    toolCalls: ProviderToolCall[],
    iteration: number,
  ): Promise<"continue" | "waiting_permission"> {
    if (toolCalls.length > 16)
      throw new KernelError(
        "Provider tool batch exceeds the 16-call safety limit.",
        400,
      );
    for (const [index, toolCall] of toolCalls.entries()) {
      const prepared = this.prepareModelToolInvocation(
        run,
        assistantMessage,
        writer,
        toolCall,
        iteration,
      );
      if (!prepared) {
        continue;
      }

      if (prepared.permission.decision === "allowed") {
        await this.executePreparedToolInvocation(prepared, {
          state: "executed",
          finishRun: false,
        });
        if (prepared.execution.controller.signal.aborted) {
          return "continue";
        }
        continue;
      }

      if (prepared.permission.decision === "requires_approval") {
        this.store.mergeRunMetadata(
          run.id,
          {
            queuedModelToolCalls: toolCalls.slice(index + 1).map((call) => ({
              id: call.id,
              name: call.name,
              arguments: call.arguments,
              ...(call.argumentsText !== undefined
                ? { argumentsText: call.argumentsText }
                : {}),
              ...(call.metadata ? { metadata: call.metadata } : {}),
            })),
          },
          new Date().toISOString(),
        );
        this.createPendingPermissionResponse(prepared);
        return "waiting_permission";
      }

      this.denyPreparedToolInvocation(prepared, null, { finishRun: false });
    }

    return "continue";
  }

  private prepareModelToolInvocation(
    run: Run,
    assistantMessage: Message,
    writer: RunWriter,
    toolCall: ProviderToolCall,
    iteration: number,
  ): PreparedToolInvocation | null {
    const providerToolName = toolCall.name.trim();
    const canonicalToolId =
      providerToolNameToToolId(providerToolName) ?? providerToolName;
    const registeredTool = this.tools.get(canonicalToolId);
    const callId = normalizeToolCallId(toolCall.id);
    const nativeToolCall: JsonObject = {
      id: toolCall.id || callId,
      name: providerToolName,
      argumentsText:
        toolCall.argumentsText ?? JSON.stringify(toolCall.arguments),
      batchId: `${run.id}:${iteration}`,
      ...(typeof toolCall.metadata?.nativeItemId === "string"
        ? { nativeItemId: toolCall.metadata.nativeItemId }
        : {}),
    };
    if (
      this.listAssistantMessagesForRun(run.id).some((message) =>
        message.parts.some(
          (part) =>
            part.type === "tool_call" &&
            typeof part.metadata.nativeToolCall === "object" &&
            part.metadata.nativeToolCall !== null &&
            !Array.isArray(part.metadata.nativeToolCall) &&
            part.metadata.nativeToolCall.id === nativeToolCall.id,
        ),
      )
    ) {
      throw new KernelError(
        "Provider repeated a native tool call ID; no duplicate tool was executed.",
        400,
        "duplicate_tool_call_id",
      );
    }
    const toolName = registeredTool?.definition.name ?? providerToolName;

    if (!registeredTool) {
      const toolCallPart = writer.recordToolCall({
        callId,
        toolId: canonicalToolId || providerToolName || "unknown",
        toolName,
        provider: "native",
        inputSummary: `Unsupported model tool call: ${providerToolName || "unknown"}`,
        metadata: {
          nativeToolCall,
          caller: "model",
          providerToolCallName: providerToolName,
          toolLoopIteration: iteration,
          unsupportedTool: true,
        },
      });
      writer.recordToolResult({
        callId,
        toolId: canonicalToolId || undefined,
        toolName,
        status: "failed",
        error: `Unsupported model tool '${providerToolName || "unknown"}'.`,
        outputSummary: `Unsupported model tool '${providerToolName || "unknown"}'.`,
        metadata: {
          toolCallPartId: toolCallPart.id,
          toolLoopIteration: iteration,
        },
      });
      return null;
    }

    const agent = this.getAgentForRun(run);
    const rootOnlyDenied =
      registeredTool.definition.id === "subsession.start" &&
      Boolean(this.getSession(run.sessionId).parentSessionId);
    if (
      rootOnlyDenied ||
      !effectiveAgentToolIds(agent).includes(registeredTool.definition.id)
    ) {
      const denial = rootOnlyDenied
        ? "Only root Sessions may delegate; child re-delegation is forbidden regardless of Agent profile."
        : `Agent profile '${agent.name}' does not allow tool '${registeredTool.definition.id}'.`;
      const toolCallPart = writer.recordToolCall({
        callId,
        toolId: registeredTool.definition.id,
        toolName: registeredTool.definition.name,
        provider: toolProviderForPart(registeredTool.definition.id),
        inputSummary: denial,
        metadata: {
          nativeToolCall,
          caller: "model",
          providerToolCallName: providerToolName,
          toolLoopIteration: iteration,
          profileToolDenied: true,
          agentId: agent.id,
          agentRevision: agent.revision,
        },
      });
      writer.recordToolResult({
        callId,
        toolId: registeredTool.definition.id,
        toolName: registeredTool.definition.name,
        status: "failed",
        error: denial,
        outputSummary: rootOnlyDenied
          ? JSON.stringify({ code: "subsession_root_only", error: denial })
          : denial,
        metadata: {
          toolCallPartId: toolCallPart.id,
          toolLoopIteration: iteration,
          profileToolDenied: true,
          agentId: agent.id,
          agentRevision: agent.revision,
        },
      });
      return null;
    }

    if (stringField(toolCall.metadata ?? {}, "argumentsParseError")) {
      const parseError = stringField(
        toolCall.metadata ?? {},
        "argumentsParseError",
      );
      const toolCallPart = writer.recordToolCall({
        callId,
        toolId: registeredTool.definition.id,
        toolName: registeredTool.definition.name,
        provider: toolProviderForPart(registeredTool.definition.id),
        inputSummary: `Invalid tool arguments for ${providerToolName}: ${parseError}`,
        metadata: {
          nativeToolCall,
          caller: "model",
          providerToolCallName: providerToolName,
          toolLoopIteration: iteration,
          argumentsParseError: parseError,
        },
      });
      writer.recordToolResult({
        callId,
        toolId: registeredTool.definition.id,
        toolName: registeredTool.definition.name,
        status: "failed",
        error: parseError,
        outputSummary: parseError,
        metadata: {
          toolCallPartId: toolCallPart.id,
          toolLoopIteration: iteration,
        },
      });
      return null;
    }

    const executionCwd =
      stringField(run.metadata, "workingDirectory") ||
      this.getToolExecutionCwd(this.getSession(run.sessionId));
    const validationContext = { cwd: executionCwd };
    let executionInput: JsonObject;
    let publicInput: JsonObject;
    try {
      executionInput =
        registeredTool.executor.validateInput?.(
          toolCall.arguments,
          validationContext,
        ) ?? toolCall.arguments;
      publicInput =
        registeredTool.executor.toPublicInput?.(
          executionInput,
          validationContext,
        ) ?? executionInput;
    } catch (error) {
      const validationError =
        error instanceof ToolInputError
          ? new KernelError(error.message, error.statusCode)
          : toError(error);
      const toolCallPart = writer.recordToolCall({
        callId,
        toolId: registeredTool.definition.id,
        toolName: registeredTool.definition.name,
        provider: toolProviderForPart(registeredTool.definition.id),
        inputSummary: `Invalid ${registeredTool.definition.id} input: ${validationError.message}`,
        metadata: {
          nativeToolCall,
          caller: "model",
          providerToolCallName: providerToolName,
          toolLoopIteration: iteration,
          validationError: validationError.message,
        },
      });
      writer.recordToolResult({
        callId,
        toolId: registeredTool.definition.id,
        toolName: registeredTool.definition.name,
        status: "failed",
        error: validationError.message,
        outputSummary: validationError.message,
        metadata: {
          toolCallPartId: toolCallPart.id,
          toolLoopIteration: iteration,
        },
      });
      return null;
    }

    const permission = evaluateToolPermission({
      tool: registeredTool.definition,
      caller: "model",
      publicInput,
      executionInput,
      executionCwd,
      settings: this.getToolSettings(),
    });
    const now = new Date().toISOString();
    const invocation: ToolInvocation = {
      id: callId,
      toolId: registeredTool.definition.id,
      toolName: registeredTool.definition.name,
      sessionId: run.sessionId,
      runId: run.id,
      messageId: assistantMessage.id,
      caller: "model",
      status:
        permission.decision === "allowed" ? "created" : "pending_permission",
      permissionDecision: permission.decision,
      input: publicInput,
      metadata: {
        toolSource: registeredTool.definition.source,
        executionCwd,
        permissionRuleId: permission.ruleId,
        riskLevel: permission.riskLevel,
        providerToolCallName: providerToolName,
        toolLoopIteration: iteration,
        agentToolLoop: true,
      },
      createdAt: now,
      updatedAt: now,
    };
    const toolCallPart = writer.recordToolCall({
      callId: invocation.id,
      toolId: registeredTool.definition.id,
      toolName: registeredTool.definition.name,
      provider: toolProviderForPart(registeredTool.definition.id),
      input: publicInput,
      inputSummary: summarizeToolInput(
        registeredTool.definition.id,
        publicInput,
      ),
      metadata: {
        nativeToolCall,
        caller: "model",
        providerToolCallName: providerToolName,
        toolLoopIteration: iteration,
        permissionDecision: permission.decision,
        permissionAction: permission.action,
        permissionRuleId: permission.ruleId,
        riskLevel: permission.riskLevel,
        toolSource: registeredTool.definition.source,
        agentToolLoop: true,
      },
    });
    const commandOutputPart =
      registeredTool.definition.id === "shell.exec"
        ? writer.recordCommandOutput({
            callId: invocation.id,
            stream: "combined",
            text: "",
            cwd: stringField(executionInput, "cwd"),
            metadata: {
              invocationId: invocation.id,
              toolId: registeredTool.definition.id,
              caller: "model",
              toolLoopIteration: iteration,
              agentToolLoop: true,
            },
          })
        : null;

    return {
      registeredTool,
      executionInput,
      publicInput,
      executionCwd,
      caller: "model",
      permission,
      run,
      assistantMessage,
      invocation,
      writer,
      toolCallPart,
      commandOutputPart,
      createdAt: now,
      resumeAgentRun: true,
      toolLoopIteration: iteration,
      providerToolCallName: providerToolName,
      execution: this.getOrCreateExecution(run.id),
    };
  }

  private withCurrentToolLoopContext(
    input: ProviderRunInput,
    runId: string,
    provider: ProviderAdapter,
    toolIteration: number,
  ): ProviderRunInput {
    const assistantMessages = this.listAssistantMessagesForRun(runId);
    if (assistantMessages.length === 0) {
      return input;
    }
    const syntheticToolMessages = currentRunToolTranscript(assistantMessages);
    if (syntheticToolMessages.length === 0) {
      return input;
    }
    const currentUserMessageId = input.sourceMessages.find(
      (message) => message.runId === runId && message.role === "user",
    )?.id;
    const inheritedArtifact = input.context.plan.inheritedArtifactId
      ? this.store.getContextArtifact(input.context.plan.inheritedArtifactId)
      : null;
    const contextResult = this.buildContext({
      session: input.session,
      agent: input.context.agent,
      messages: input.sourceMessages,
      providerProfileId: input.profile.id,
      runOptions: input.runOptions,
      availableTools: input.context.availableTools,
      metadata: {
        runId,
        toolLoopSyntheticMessageCount: syntheticToolMessages.length,
      },
      activeSegmentId:
        input.context.plan.activeSegmentId ?? input.session.activeSegmentId,
      compactionArtifact: inheritedArtifact,
      resolvedBudget:
        contextBudgetFromMetadata(input.context.plan) ?? undefined,
      currentMessageId: currentUserMessageId,
      providerOverhead: provider.contextPlanning,
      syntheticMessages: syntheticToolMessages,
    });
    const context = contextResult.context;
    this.appendContextPlanRecord(runId, context.plan, toolIteration);
    return {
      ...input,
      context,
      messages: toProviderMessages(context),
    };
  }

  private createContextPlanRecord(
    plan: ContextPlan,
    providerTurn: number,
    toolIteration: number,
    createdAt = new Date().toISOString(),
  ): ContextPlanRecord {
    return {
      planId: randomUUID(),
      providerTurn,
      toolIteration,
      createdAt,
      plan,
    };
  }

  private appendContextPlanRecord(
    runId: string,
    plan: ContextPlan,
    toolIteration: number,
  ): void {
    const run = this.getRun(runId);
    const records = contextPlanRecordObjects(run.metadata);
    const last = records.at(-1);
    const providerTurn = integerJsonField(last, "providerTurn") + 1;
    const record = this.createContextPlanRecord(
      plan,
      providerTurn,
      toolIteration,
    );
    const serializedRecord = contextPlanRecordToJson(record);
    const boundedRecords =
      records.length < 128
        ? [...records, serializedRecord]
        : [records[0], ...records.slice(-126), serializedRecord];
    this.store.mergeRunMetadata(
      runId,
      {
        contextPlanRecords: boundedRecords,
        latestContextPlanId: record.planId,
      },
      record.createdAt,
    );
  }

  private markRunWaitingForPermission(
    run: Run,
    messageId: string,
    permissionRequestId: string,
  ): void {
    const now = new Date().toISOString();
    this.store.mergeRunMetadata(
      run.id,
      {
        toolLoopState: "waiting_permission",
        pendingPermissionRequestId: permissionRequestId,
      },
      now,
    );
    this.store.mergeMessageMetadata(
      messageId,
      {
        toolLoopState: "waiting_permission",
        pendingPermissionRequestId: permissionRequestId,
      },
      now,
    );
    this.emit(run, "run_waiting_permission", {
      runId: run.id,
      sessionId: run.sessionId,
      messageId,
      permissionRequestId,
      status: "waiting_permission",
    });
  }

  private queueResumeAgentRun(runId: string): void {
    queueMicrotask(() => {
      if (this.shuttingDown) {
        return;
      }
      const execution = this.getOrCreateExecution(runId);
      void this.trackExecution(execution, () =>
        this.resumeAgentRun(runId, execution),
      ).catch((error) =>
        this.handleQueuedExecutionError(runId, execution, error),
      );
    });
  }

  private wakeWaitingParent(runId: string): void {
    if (this.shuttingDown || this.executions.get(runId)?.activePromise) return;
    const run = this.store.getRun(runId);
    if (run?.status !== "waiting_children") return;
    if (
      !this.store.subsessions
        .list(runId)
        .some((item) => item.result !== null && !item.acknowledged)
    )
      return;
    if (!this.store.subsessions.wake(runId)) return;
    this.emit(this.getRun(runId), "child_result_available", {
      runId,
      sessionId: run.sessionId,
      status: "running",
      children: this.getPublicRun(runId).children,
    });
    this.queueResumeAgentRun(runId);
  }

  private async executeAdmittedSubsession(runId: string): Promise<void> {
    this.assertAcceptingWork();
    const run = this.getRun(runId);
    if (run.status !== "running") return;
    this.getOrCreateExecution(run.id);
    await this.startRunAttempt(
      run.sessionId,
      this.store.subsessions.task(run.id),
      {},
      true,
      run.id,
    );
  }

  listSubsessions(sessionId: string) {
    this.getSession(sessionId);
    return this.store.subsessions
      .list()
      .filter((item) => item.parentSessionId === sessionId)
      .map((item) => {
        const child = this.store.getRun(item.childRunId);
        const snapshot = child ? agentFromRunMetadata(child.metadata) : null;
        return {
          ...item,
          status: child?.status ?? item.status,
          agentName:
            sanitizePublicText(snapshot?.name ?? item.agentId, 120) ?? "Child",
          taskPreview:
            sanitizePublicText(
              this.store.subsessions.task(item.childRunId),
              240,
            ) ?? "",
        };
      });
  }

  private async resumeAgentRun(
    runId: string,
    execution: RunExecution,
  ): Promise<void> {
    const run = this.getRun(runId);
    if (run.status !== "running") {
      return;
    }
    const assistantMessages = this.listAssistantMessagesForRun(runId);
    if (assistantMessages.length === 0) {
      throw new KernelError("Assistant message for run not found", 404);
    }
    const { provider, input } = this.buildProviderInputForExistingRun(run);
    this.completeStreamingAssistantMessagesForRun(run);
    const iteration = numberField(run.metadata, "toolIterations") ?? 0;
    let writer = this.createFollowUpAssistantWriter(run, iteration, execution);
    const queued = run.metadata.queuedModelToolCalls;
    if (Array.isArray(queued) && queued.length > 0) {
      this.store.mergeRunMetadata(
        run.id,
        { queuedModelToolCalls: [] },
        new Date().toISOString(),
      );
      const calls = queued as unknown as ProviderToolCall[];
      const step = await this.handleModelToolCalls(
        run,
        writer,
        this.store.getMessage(writer.messageId)!,
        calls,
        numberField(run.metadata, "toolIterations") ?? 0,
      );
      if (step === "waiting_permission") return;
      if (execution.controller.signal.aborted) {
        this.finishAbortedWriter(execution, writer);
        return;
      }
      if (this.store.getRun(run.id)?.status !== "running") return;
      // This message owns only the remaining calls/results from the preceding provider batch.
      // The next model response must not append its text or calls to that same message.
      writer.completeMessage();
      writer = this.createFollowUpAssistantWriter(run, iteration, execution);
    }
    await this.executeRun(
      this.store.getRun(run.id) ?? run,
      provider,
      input,
      execution,
      writer,
    );
  }

  private createFollowUpAssistantWriter(
    run: Run,
    iteration: number,
    execution: RunExecution,
  ): RunWriter {
    const runSnapshot = this.store.getRun(run.id) ?? run;
    const priorAssistantMessages = this.listAssistantMessagesForRun(run.id);
    const createdAt = timestampAfter(
      runSnapshot.updatedAt,
      ...priorAssistantMessages.map((message) => message.updatedAt),
    );
    const message = this.store.createMessage({
      id: randomUUID(),
      sessionId: runSnapshot.sessionId,
      runId: runSnapshot.id,
      segmentId: runSnapshot.segmentId,
      role: "assistant",
      status: "streaming",
      createdAt,
      updatedAt: createdAt,
      metadata: {
        runId: runSnapshot.id,
        contextMetadataOwner: "run",
        toolLoopIteration: iteration,
        toolLoopMessageKind: "assistant_followup",
        toolLoopState: "awaiting_model_followup",
      },
    });
    this.store.touchSession(runSnapshot.sessionId, createdAt);
    this.emit(runSnapshot, "assistant_message_created", { message });
    return new RunWriter({
      store: this.store,
      eventBus: this.eventBus,
      run: runSnapshot,
      assistantMessageId: message.id,
      signal: execution.controller.signal,
    });
  }

  private completeStreamingAssistantMessagesForRun(run: Run): void {
    for (const message of this.listAssistantMessagesForRun(run.id)) {
      if (!new MessageVO.Status(message.status).isStreaming()) {
        continue;
      }
      new RunWriter({
        store: this.store,
        eventBus: this.eventBus,
        run: this.store.getRun(run.id) ?? run,
        assistantMessageId: message.id,
      }).completeMessage();
    }
  }

  private getLatestAssistantMessageForRun(runId: string): Message | null {
    const messages = this.listAssistantMessagesForRun(runId);
    return messages[messages.length - 1] ?? null;
  }

  private listAssistantMessagesForRun(runId: string): Message[] {
    const run = this.store.getRun(runId);
    if (!run) {
      return [];
    }
    return this.store
      .listMessages(run.sessionId)
      .filter(
        (message) => message.runId === runId && message.role === "assistant",
      )
      .sort(compareMessagesForTimeline);
  }

  private buildProviderInputForExistingRun(run: Run): {
    provider: ProviderAdapter;
    input: ProviderRunInput;
  } {
    const currentSession = this.getSession(run.sessionId);
    const session = {
      ...currentSession,
      workingDirectory:
        stringField(run.metadata, "workingDirectory") ||
        currentSession.workingDirectory,
    };
    const agent = this.getAgentForRun(run);
    const executionSnapshot = executionSnapshotFromRunMetadata(run.metadata);
    const providerProfileId =
      executionSnapshot?.providerProfileId ??
      (stringField(run.metadata, "providerProfileId") || run.provider);
    const resolvedProvider = this.resolveSavedProvider(providerProfileId);
    const effectiveRunOptions =
      executionSnapshot?.runOptions ??
      runOptionsFromJson(run.metadata.runOptions) ??
      run.runOptions ??
      {};
    const requestedRunOptions =
      executionSnapshot?.requestedRunOptions ??
      runOptionsFromJson(run.metadata.requestedRunOptions) ??
      effectiveRunOptions;
    const unsupportedRunOptions =
      executionSnapshot?.unsupportedRunOptions ??
      (Array.isArray(run.metadata.unsupportedRunOptions)
        ? run.metadata.unsupportedRunOptions.filter(
            (value): value is string => typeof value === "string",
          )
        : []);
    const contextHistory = this.contextHistoryForSession(session);
    const sourceMessages = contextHistory.messages.filter(
      (message) => message.runId !== run.id || message.role !== "assistant",
    );
    const currentUserMessageId = sourceMessages.find(
      (message) => message.runId === run.id && message.role === "user",
    )?.id;
    const contextResult = this.buildContext({
      session,
      agent,
      messages: sourceMessages,
      providerProfileId: resolvedProvider.profile.id,
      runOptions: effectiveRunOptions,
      availableTools: this.getAvailableToolsForAgent(agent, session),
      metadata: { runId: run.id, resumed: true },
      activeSegmentId: session.activeSegmentId,
      compactionArtifact: contextHistory.artifact,
      resolvedBudget:
        contextBudgetFromMetadata(
          contextPlanObject(contextPlanRecordObjects(run.metadata).at(-1)),
        ) ?? undefined,
      currentMessageId: currentUserMessageId,
      providerOverhead: resolvedProvider.adapter.contextPlanning,
    });
    return {
      provider: resolvedProvider.adapter,
      input: {
        session,
        context: contextResult.context,
        sourceMessages,
        messages: toProviderMessages(contextResult.context),
        profile: resolvedProvider.profile,
        credential: resolvedProvider.credential,
        requestedRunOptions,
        runOptions: effectiveRunOptions,
        unsupportedRunOptions,
      },
    };
  }

  private resolveSavedProvider(providerProfileId: string) {
    const exactResolver = (
      this.providers as ProviderRegistry & {
        resolveRunExact?: ProviderRegistry["resolveRunExact"];
      }
    ).resolveRunExact;
    if (typeof exactResolver === "function") {
      return exactResolver.call(this.providers, providerProfileId);
    }
    const resolved = this.providers.resolveRun({ providerProfileId });
    if (
      resolved.profile.id !== providerProfileId ||
      resolved.providerResolution.fallback
    ) {
      throw new Error(
        `Saved provider profile '${providerProfileId}' is unavailable; this run was not switched to fallback provider '${resolved.profile.id}'.`,
      );
    }
    return resolved;
  }

  private agentDefaultsForProvider(
    agent: AgentDefinition,
    resolvedProviderProfileId: string,
    options: StartRunOptions,
  ): RunOptions | null {
    const hasProviderOverride = Boolean(
      options.provider?.trim() || options.providerProfileId?.trim(),
    );
    if (!hasProviderOverride) {
      return agent.defaultRunOptions;
    }
    const profileProviderProfileId =
      agent.modelProfileId ?? this.providers.list().defaultProviderProfileId;
    return profileProviderProfileId === resolvedProviderProfileId
      ? agent.defaultRunOptions
      : null;
  }

  private getAvailableToolsForAgent(agent: AgentDefinition, session: Session) {
    const toolIds = effectiveAgentToolIds(agent);
    const tools = this.tools
      .list()
      .filter(
        (tool) =>
          toolIds.includes(tool.id) &&
          (!session.parentSessionId || tool.id !== "subsession.start"),
      );
    return tools.flatMap((tool) => {
      const modelTool = toModelToolDefinition(tool);
      return modelTool ? [modelTool] : [];
    });
  }

  private buildContext(input: ContextBuildInput) {
    try {
      return buildContext(input);
    } catch (error) {
      if (error instanceof ContextBudgetExceededError) {
        throw new KernelError(
          error.message,
          400,
          error.code,
          error instanceof ContextSummaryExceedsBudgetError
            ? { ...error.details, artifactId: error.artifactId }
            : error.details,
        );
      }
      if (error instanceof InvalidContextPolicyError) {
        throw new KernelError(error.message, 400, error.code, error.details);
      }
      throw error;
    }
  }

  private contextHistoryForSession(session: Session) {
    const segment = this.store.getContextSegment(session.activeSegmentId);
    if (
      !segment ||
      segment.status !== "active" ||
      segment.sessionId !== session.id
    ) {
      throw new KernelError(
        "Session context segment is unavailable or inconsistent.",
        409,
        "context_segment_mismatch",
      );
    }
    const artifact = segment.inheritedArtifactId
      ? this.store.getContextArtifact(segment.inheritedArtifactId)
      : null;
    if (
      segment.inheritedArtifactId &&
      (!artifact ||
        artifact.status !== "completed" ||
        artifact.targetSegmentId !== segment.id)
    ) {
      throw new KernelError(
        "Inherited context artifact is unavailable or inconsistent.",
        409,
        "context_artifact_mismatch",
      );
    }
    if (artifact) {
      const sourceSegment = this.store.getContextSegment(
        artifact.sourceSegmentId,
      );
      if (
        !sourceSegment ||
        sourceSegment.status !== "sealed" ||
        sourceSegment.firstMessageId !== artifact.sourceFirstMessageId ||
        sourceSegment.lastMessageId !== artifact.sourceLastMessageId
      ) {
        throw new KernelError(
          "Inherited context artifact source boundary is inconsistent.",
          409,
          "context_artifact_mismatch",
        );
      }
    }
    return { messages: this.store.listMessagesBySegment(segment.id), artifact };
  }

  private coordinateCompaction(
    sessionId: string,
    automaticRun: Run | null,
    parentSignal?: AbortSignal,
  ): Promise<CompactContextResponse> {
    const existing = this.compactions.get(sessionId);
    if (existing) {
      throw new KernelError(
        "Context compaction is already in progress for this session.",
        409,
        "context_compaction_conflict",
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(
            `Context compaction timed out after ${compactionTimeoutMs / 1000}s.`,
          ),
        ),
      compactionTimeoutMs,
    );
    if (parentSignal?.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentSignal?.addEventListener(
        "abort",
        () => controller.abort(parentSignal.reason),
        { once: true },
      );
    }
    this.compactionControllers.set(sessionId, controller);
    const operation = this.performContextCompaction(
      sessionId,
      automaticRun,
      controller.signal,
    )
      .catch((error) =>
        this.recordEarlyCompactionFailure(sessionId, automaticRun, error),
      )
      .finally(() => {
        if (this.compactions.get(sessionId) === operation) {
          clearTimeout(timeout);
          this.compactions.delete(sessionId);
          this.compactionControllers.delete(sessionId);
        }
      });
    this.compactions.set(sessionId, operation);
    return operation;
  }

  private async performContextCompaction(
    sessionId: string,
    automaticRun: Run | null,
    signal: AbortSignal,
  ): Promise<CompactContextResponse> {
    const session = this.getSession(sessionId);
    const segment = this.store.getContextSegment(session.activeSegmentId);
    if (!segment || segment.status !== "active") {
      throw new KernelError(
        "Active context segment is unavailable.",
        409,
        "context_segment_mismatch",
      );
    }
    const allMessages = this.store.listMessagesBySegment(segment.id);
    const sourcePlan = selectCompactionSource(
      allMessages,
      automaticRun?.id ?? null,
    );
    if (
      sourcePlan.sourceMessages.length === 0 &&
      !segment.inheritedArtifactId
    ) {
      return {
        state: "noop",
        segment,
        artifact: null,
        message: "No eligible finalized prefix is available.",
      };
    }
    const agent = automaticRun
      ? this.getAgentForRun(automaticRun)
      : this.resolveAgentForSession(session);
    const executionSnapshot = automaticRun
      ? executionSnapshotFromRunMetadata(automaticRun.metadata)
      : null;
    const recordedProviderProfileId =
      executionSnapshot?.providerProfileId ??
      (automaticRun
        ? stringField(automaticRun.metadata, "providerProfileId")
        : "");
    const providerProfileId =
      recordedProviderProfileId ||
      agent.modelProfileId ||
      this.providers.list().defaultProviderProfileId;
    const resolvedProvider = this.resolveSavedProvider(providerProfileId);
    const optionPlan = buildRunOptionPlan(
      resolvedProvider.profile,
      executionSnapshot?.runOptions ??
        automaticRun?.runOptions ??
        agent.defaultRunOptions ??
        {},
    );
    const model =
      optionPlan.runOptions.model ?? resolvedProvider.profile.model ?? null;
    const capability = await this.getModelContextCapability(
      resolvedProvider.profile.id,
      model,
    );
    const budget = resolveContextBudget(capability, agent.contextPolicy);
    const previousArtifact = segment.inheritedArtifactId
      ? this.store.getContextArtifact(segment.inheritedArtifactId)
      : null;
    if (
      previousArtifact &&
      this.inheritedSummaryExceedsBudget(
        session,
        segment.id,
        agent,
        previousArtifact,
        resolvedProvider.adapter,
        resolvedProvider.profile.id,
        optionPlan.runOptions,
        budget,
      )
    ) {
      return this.performSummaryOnlyRecovery({
        session,
        segment,
        previousArtifact,
        agent,
        resolvedProvider,
        optionPlan,
        budget,
        signal,
        automaticRun,
      });
    }
    if (sourcePlan.sourceMessages.length === 0) {
      if (automaticRun) {
        this.emit(automaticRun, "context_compaction_skipped", {
          runId: automaticRun.id,
          sessionId,
          segmentId: segment.id,
          reason: "no_finalized_prefix",
        });
      }
      return {
        state: "noop",
        segment,
        artifact: null,
        message: "No eligible finalized prefix is available.",
      };
    }
    const createdAt = new Date().toISOString();
    const artifactId = randomUUID();
    if (automaticRun) {
      this.emit(automaticRun, "context_compaction_started", {
        runId: automaticRun.id,
        sessionId,
        artifactId,
        sourceSegmentId: segment.id,
        providerProfileId: resolvedProvider.profile.id,
        model,
      });
    }

    let selectedEntries = [...sourcePlan.entries];
    let selectedMessages = selectedEntries.flatMap((entry) => entry.messages);
    let contextResult: ReturnType<typeof buildContext> | null = null;
    while (selectedMessages.length > 0) {
      const summaryInput = buildCompactionInput(
        previousArtifact?.summary ?? null,
        selectedEntries,
      );
      try {
        contextResult = this.buildContext({
          session,
          agent: {
            ...agent,
            systemPrompt: compactionSystemPrompt,
            toolIds: [],
            skillIds: [],
            contextPolicy: agent.contextPolicy,
          },
          messages: [],
          currentMessage: {
            content: summaryInput,
            messageId: `compaction:${artifactId}`,
          },
          currentMessageId: `compaction:${artifactId}`,
          providerProfileId: resolvedProvider.profile.id,
          runOptions: { ...optionPlan.runOptions, temperature: 0 },
          availableTools: [],
          resolvedBudget: budget,
          providerOverhead: resolvedProvider.adapter.contextPlanning,
          activeSegmentId: segment.id,
        });
        break;
      } catch (error) {
        if (
          !(error instanceof KernelError) ||
          error.code !== "context_budget_exceeded"
        ) {
          throw error;
        }
        selectedEntries = selectedEntries.slice(0, -1);
        selectedMessages = selectedEntries.flatMap((entry) => entry.messages);
      }
    }
    if (!contextResult || selectedMessages.length === 0) {
      return this.recordCompactionFailure({
        session,
        segmentId: segment.id,
        artifactId,
        previousArtifactId: previousArtifact?.id ?? null,
        sourceMessages: sourcePlan.sourceMessages,
        sourceCategories: sourcePlan.entries.map((entry) => entry.category),
        budget,
        providerProfileId: resolvedProvider.profile.id,
        model,
        error: "No eligible source prefix fits the compaction provider budget.",
        automaticRun,
      });
    }

    const selectedIds = new Set(selectedMessages.map((message) => message.id));
    const preservedMessageIds = allMessages
      .filter((message) => !selectedIds.has(message.id))
      .map((message) => message.id);
    const segmentRuns = this.store
      .listRuns({ sessionId })
      .filter((candidate) => candidate.segmentId === segment.id);
    const sourceRunIds = [
      ...new Set(
        selectedMessages.flatMap((message) =>
          message.runId ? [message.runId] : [],
        ),
      ),
    ];
    const sourceRunSet = new Set(sourceRunIds);
    const preservedRunIds = segmentRuns
      .filter((candidate) => !sourceRunSet.has(candidate.id))
      .map((candidate) => candidate.id);
    const collector = new CompactionCollector();
    try {
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("Compaction cancelled.");
      }
      const providerInput: ProviderRunInput = {
        session,
        context: contextResult.context,
        sourceMessages: selectedMessages,
        messages: toProviderMessages(contextResult.context),
        profile: resolvedProvider.profile,
        credential: resolvedProvider.credential,
        requestedRunOptions: optionPlan.requestedRunOptions,
        runOptions: { ...optionPlan.runOptions, temperature: 0 },
        unsupportedRunOptions: optionPlan.unsupportedRunOptions,
      };
      const result = await resolvedProvider.adapter.run(providerInput, {
        signal,
        writer: collector,
      });
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("Compaction cancelled.");
      }
      if (result.toolCalls.length > 0) {
        throw new Error(
          "Compaction provider returned a tool call instead of a summary.",
        );
      }
      const summary = validatedCompactionSummary(
        collector.text,
        budget.inputBudgetTokens,
      );
      const sourceMessageIds = selectedMessages.map((message) => message.id);
      const artifact: ContextArtifact = {
        id: artifactId,
        kind: "compaction",
        sessionId,
        sourceSegmentId: segment.id,
        targetSegmentId: null,
        previousArtifactId: previousArtifact?.id ?? null,
        sourceMessageIds,
        sourceCategories: selectedEntries.map((entry) => entry.category),
        sourceFirstMessageId: sourceMessageIds[0] ?? null,
        sourceLastMessageId: sourceMessageIds.at(-1) ?? null,
        summary,
        strategyVersion: compactionStrategyVersion,
        estimatorVersion: contextEstimatorVersion,
        estimatedTokensBefore: estimateTextTokens(
          buildCompactionInput(
            previousArtifact?.summary ?? null,
            selectedEntries,
          ),
        ),
        estimatedTokensAfter: estimateTextTokens(summary),
        resolvedWindowTokens: budget.windowTokens,
        windowSource: budget.windowSource,
        status: "completed",
        providerProfileId: resolvedProvider.profile.id,
        model,
        usage: collector.usage,
        error: null,
        createdAt,
      };
      const rotated = this.store.rotateContextSegment({
        sessionId,
        expectedActiveSegmentId: segment.id,
        newSegmentId: randomUUID(),
        preservedMessageIds,
        sourceRunIds,
        preservedRunIds,
        artifact,
        rotatedAt: new Date().toISOString(),
        ...(automaticRun ? { allowedActiveRunId: automaticRun.id } : {}),
      });
      if (!rotated) {
        throw new Error("Context segment rotation lost its concurrency check.");
      }
      if (automaticRun) {
        this.store.mergeRunMetadata(
          automaticRun.id,
          {
            contextCompactionArtifactId: artifact.id,
            contextCompactionUsage: runUsageToJson(collector.usage),
          },
          new Date().toISOString(),
        );
        this.emit(automaticRun, "context_compaction_completed", {
          runId: automaticRun.id,
          sessionId,
          artifactId: artifact.id,
          sourceSegmentId: segment.id,
          targetSegmentId: rotated.segment.id,
          estimatedTokensBefore: artifact.estimatedTokensBefore,
          estimatedTokensAfter: artifact.estimatedTokensAfter,
          providerProfileId: artifact.providerProfileId,
          model: artifact.model,
          usage: artifact.usage,
        });
        this.emit(automaticRun, "segment_rotated", {
          runId: automaticRun.id,
          sessionId,
          artifactId: artifact.id,
          sourceSegmentId: segment.id,
          targetSegmentId: rotated.segment.id,
        });
      }
      return {
        state: "completed",
        segment: rotated.segment,
        artifact: rotated.artifact,
      };
    } catch (error) {
      return this.recordCompactionFailure({
        session,
        segmentId: segment.id,
        artifactId,
        previousArtifactId: previousArtifact?.id ?? null,
        sourceMessages: selectedMessages,
        sourceCategories: selectedEntries.map((entry) => entry.category),
        budget,
        providerProfileId: resolvedProvider.profile.id,
        model,
        error: sanitizedCompactionError(error),
        usage: collector.usage,
        automaticRun,
      });
    }
  }

  private recordCompactionFailure(input: {
    session: Session;
    segmentId: string;
    artifactId: string;
    previousArtifactId: string | null;
    sourceMessages: Message[];
    sourceCategories: ContextArtifactSourceCategory[];
    budget: ReturnType<typeof resolveContextBudget>;
    providerProfileId: string;
    model: string | null;
    error: string;
    usage?: RunUsage | null;
    automaticRun: Run | null;
  }): CompactContextResponse {
    const sourceMessageIds = input.sourceMessages.map((message) => message.id);
    const artifact = this.store.createContextArtifact({
      id: input.artifactId,
      kind: "compaction",
      sessionId: input.session.id,
      sourceSegmentId: input.segmentId,
      previousArtifactId: input.previousArtifactId,
      sourceMessageIds,
      sourceCategories: input.sourceCategories,
      sourceFirstMessageId: sourceMessageIds[0] ?? null,
      sourceLastMessageId: sourceMessageIds.at(-1) ?? null,
      summary: "",
      strategyVersion: compactionStrategyVersion,
      estimatorVersion: contextEstimatorVersion,
      estimatedTokensBefore: estimateTextTokens(
        buildCompactionInput(
          null,
          entriesFromCategories(input.sourceMessages, input.sourceCategories),
        ),
      ),
      estimatedTokensAfter: 0,
      resolvedWindowTokens: input.budget.windowTokens,
      windowSource: input.budget.windowSource,
      status: "failed",
      providerProfileId: input.providerProfileId,
      model: input.model,
      usage: input.usage ?? null,
      error: input.error,
      createdAt: new Date().toISOString(),
    });
    if (input.automaticRun) {
      this.emit(input.automaticRun, "context_compaction_failed", {
        runId: input.automaticRun.id,
        sessionId: input.session.id,
        artifactId: artifact.id,
        sourceSegmentId: input.segmentId,
        providerProfileId: input.providerProfileId,
        model: input.model,
        usage: artifact.usage,
        error: artifact.error,
      });
    }
    return {
      state: "failed",
      segment: this.store.getContextSegment(input.segmentId)!,
      artifact,
      message: input.error,
    };
  }

  private recordEarlyCompactionFailure(
    sessionId: string,
    automaticRun: Run | null,
    error: unknown,
  ): CompactContextResponse {
    const session = this.getSession(sessionId);
    const segment = this.store.getContextSegment(session.activeSegmentId);
    if (!segment || segment.status !== "active") throw error;
    const previous = segment.inheritedArtifactId
      ? this.store.getContextArtifact(segment.inheritedArtifactId)
      : null;
    const sourcePlan = selectCompactionSource(
      this.store.listMessagesBySegment(segment.id),
      automaticRun?.id ?? null,
    );
    const sourceMessageIds =
      sourcePlan.sourceMessages.length > 0
        ? sourcePlan.sourceMessages.map((message) => message.id)
        : (previous?.sourceMessageIds ?? []);
    const sourceCategories =
      sourcePlan.entries.length > 0
        ? sourcePlan.entries.map((entry) => entry.category)
        : previous
          ? [
              {
                category: "summary_recovery" as const,
                messageIds: previous.sourceMessageIds,
                runId: null,
                status: "resolution_failed",
              },
            ]
          : [];
    const summaryRecoveryAttempt =
      sourcePlan.sourceMessages.length === 0 && previous !== null;
    const agent = automaticRun
      ? this.getAgentForRun(automaticRun)
      : this.resolveAgentForSession(session);
    const artifact = this.store.createContextArtifact({
      id: randomUUID(),
      kind: "compaction",
      sessionId,
      sourceSegmentId: summaryRecoveryAttempt
        ? previous.sourceSegmentId
        : segment.id,
      targetSegmentId: summaryRecoveryAttempt ? segment.id : null,
      previousArtifactId: previous?.id ?? null,
      sourceMessageIds,
      sourceCategories,
      sourceFirstMessageId: sourceMessageIds[0] ?? null,
      sourceLastMessageId: sourceMessageIds.at(-1) ?? null,
      summary: "",
      strategyVersion: compactionStrategyVersion,
      estimatorVersion: contextEstimatorVersion,
      estimatedTokensBefore: 0,
      estimatedTokensAfter: 0,
      resolvedWindowTokens: 16_384,
      windowSource: "assumed",
      status: "failed",
      providerProfileId: automaticRun
        ? stringField(automaticRun.metadata, "providerProfileId") ||
          agent.modelProfileId
        : agent.modelProfileId,
      model: automaticRun?.model ?? agent.defaultRunOptions?.model ?? null,
      usage: null,
      error: sanitizedCompactionError(error),
      createdAt: new Date().toISOString(),
    });
    if (automaticRun) {
      this.emit(automaticRun, "context_compaction_failed", {
        runId: automaticRun.id,
        sessionId,
        artifactId: artifact.id,
        sourceSegmentId: artifact.sourceSegmentId,
        providerProfileId: artifact.providerProfileId,
        model: artifact.model,
        error: artifact.error,
      });
    }
    return {
      state: "failed",
      segment,
      artifact,
      message: artifact.error ?? undefined,
    };
  }

  private inheritedSummaryExceedsBudget(
    session: Session,
    activeSegmentId: string,
    agent: AgentDefinition,
    artifact: ContextArtifact,
    adapter: ProviderAdapter,
    providerProfileId: string,
    runOptions: RunOptions,
    budget: ReturnType<typeof resolveContextBudget>,
  ): boolean {
    try {
      this.buildContext({
        session,
        agent,
        messages: [],
        providerProfileId,
        runOptions,
        availableTools: this.getAvailableToolsForAgent(agent, session),
        resolvedBudget: budget,
        providerOverhead: adapter.contextPlanning,
        activeSegmentId,
        compactionArtifact: artifact,
      });
      return false;
    } catch (error) {
      if (
        error instanceof KernelError &&
        error.code === "context_summary_exceeds_budget"
      )
        return true;
      throw error;
    }
  }

  private async performSummaryOnlyRecovery(input: {
    session: Session;
    segment: ContextSegment;
    previousArtifact: ContextArtifact;
    agent: AgentDefinition;
    resolvedProvider: ResolvedProviderRun;
    optionPlan: RunOptionPlan;
    budget: ReturnType<typeof resolveContextBudget>;
    signal: AbortSignal;
    automaticRun: Run | null;
  }): Promise<CompactContextResponse> {
    const artifactId = randomUUID();
    const sourceCategory: ContextArtifactSourceCategory = {
      category: "summary_recovery",
      messageIds: input.previousArtifact.sourceMessageIds,
      runId: null,
      status: "completed_artifact",
    };
    if (input.automaticRun) {
      this.emit(input.automaticRun, "context_compaction_started", {
        runId: input.automaticRun.id,
        sessionId: input.session.id,
        artifactId,
        sourceSegmentId: input.previousArtifact.sourceSegmentId,
        targetSegmentId: input.segment.id,
        reason: "summary_only_recovery",
        providerProfileId: input.resolvedProvider.profile.id,
        model:
          input.optionPlan.runOptions.model ??
          input.resolvedProvider.profile.model ??
          null,
      });
    }
    let contextResult: ReturnType<typeof buildContext> | null = null;
    let reducedSource = input.previousArtifact.summary;
    let maxChars = reducedSource.length;
    while (maxChars >= 64) {
      reducedSource = boundHistoricalContextText(
        input.previousArtifact.summary,
        maxChars,
      );
      try {
        contextResult = this.buildContext({
          session: input.session,
          agent: {
            ...input.agent,
            systemPrompt: compactionSystemPrompt,
            toolIds: [],
            skillIds: [],
          },
          messages: [],
          currentMessage: {
            content: buildSummaryRecoveryInput(
              input.previousArtifact.id,
              reducedSource,
            ),
            messageId: `summary-recovery:${artifactId}`,
          },
          currentMessageId: `summary-recovery:${artifactId}`,
          providerProfileId: input.resolvedProvider.profile.id,
          runOptions: { ...input.optionPlan.runOptions, temperature: 0 },
          availableTools: [],
          resolvedBudget: input.budget,
          providerOverhead: input.resolvedProvider.adapter.contextPlanning,
          activeSegmentId: input.segment.id,
        });
        break;
      } catch (error) {
        if (
          !(error instanceof KernelError) ||
          error.code !== "context_budget_exceeded"
        )
          throw error;
        maxChars = Math.floor(maxChars * 0.75);
      }
    }
    const collector = new CompactionCollector();
    try {
      if (!contextResult)
        throw new Error(
          "The inherited summary cannot fit the current provider budget even after deterministic reduction.",
        );
      const providerInput: ProviderRunInput = {
        session: input.session,
        context: contextResult.context,
        sourceMessages: [],
        messages: toProviderMessages(contextResult.context),
        profile: input.resolvedProvider.profile,
        credential: input.resolvedProvider.credential,
        requestedRunOptions: input.optionPlan.requestedRunOptions,
        runOptions: { ...input.optionPlan.runOptions, temperature: 0 },
        unsupportedRunOptions: input.optionPlan.unsupportedRunOptions,
      };
      const result = await input.resolvedProvider.adapter.run(providerInput, {
        signal: input.signal,
        writer: collector,
      });
      if (input.signal.aborted)
        throw input.signal.reason instanceof Error
          ? input.signal.reason
          : new Error("Summary recovery cancelled.");
      if (result.toolCalls.length > 0)
        throw new Error("Summary recovery provider returned a tool call.");
      const summary = validatedCompactionSummary(
        collector.text,
        input.budget.inputBudgetTokens,
      );
      const artifact: ContextArtifact = {
        id: artifactId,
        kind: "compaction",
        sessionId: input.session.id,
        sourceSegmentId: input.previousArtifact.sourceSegmentId,
        targetSegmentId: input.segment.id,
        previousArtifactId: input.previousArtifact.id,
        sourceMessageIds: input.previousArtifact.sourceMessageIds,
        sourceCategories: [sourceCategory],
        sourceFirstMessageId: input.previousArtifact.sourceFirstMessageId,
        sourceLastMessageId: input.previousArtifact.sourceLastMessageId,
        summary,
        strategyVersion: "continuity-summary-recovery-v1",
        estimatorVersion: contextEstimatorVersion,
        estimatedTokensBefore: estimateTextTokens(
          input.previousArtifact.summary,
        ),
        estimatedTokensAfter: estimateTextTokens(summary),
        resolvedWindowTokens: input.budget.windowTokens,
        windowSource: input.budget.windowSource,
        status: "completed",
        providerProfileId: input.resolvedProvider.profile.id,
        model:
          input.optionPlan.runOptions.model ??
          input.resolvedProvider.profile.model ??
          null,
        usage: collector.usage,
        error: null,
        createdAt: new Date().toISOString(),
      };
      const replaced = this.store.replaceInheritedContextArtifact({
        sessionId: input.session.id,
        expectedActiveSegmentId: input.segment.id,
        expectedArtifactId: input.previousArtifact.id,
        artifact,
        updatedAt: artifact.createdAt,
      });
      if (!replaced)
        throw new Error(
          "Inherited summary recovery lost its segment/artifact CAS.",
        );
      if (input.automaticRun) {
        this.emit(input.automaticRun, "context_compaction_completed", {
          runId: input.automaticRun.id,
          sessionId: input.session.id,
          artifactId: artifact.id,
          sourceSegmentId: artifact.sourceSegmentId,
          targetSegmentId: input.segment.id,
          reason: "summary_only_recovery",
          estimatedTokensBefore: artifact.estimatedTokensBefore,
          estimatedTokensAfter: artifact.estimatedTokensAfter,
          providerProfileId: artifact.providerProfileId,
          model: artifact.model,
          usage: artifact.usage,
        });
      }
      return {
        state: "completed",
        segment: replaced.segment,
        artifact: replaced.artifact,
      };
    } catch (error) {
      const failed = this.store.createContextArtifact({
        id: artifactId,
        kind: "compaction",
        sessionId: input.session.id,
        sourceSegmentId: input.previousArtifact.sourceSegmentId,
        targetSegmentId: input.segment.id,
        previousArtifactId: input.previousArtifact.id,
        sourceMessageIds: input.previousArtifact.sourceMessageIds,
        sourceCategories: [sourceCategory],
        sourceFirstMessageId: input.previousArtifact.sourceFirstMessageId,
        sourceLastMessageId: input.previousArtifact.sourceLastMessageId,
        summary: "",
        strategyVersion: "continuity-summary-recovery-v1",
        estimatorVersion: contextEstimatorVersion,
        estimatedTokensBefore: estimateTextTokens(
          input.previousArtifact.summary,
        ),
        estimatedTokensAfter: 0,
        resolvedWindowTokens: input.budget.windowTokens,
        windowSource: input.budget.windowSource,
        status: "failed",
        providerProfileId: input.resolvedProvider.profile.id,
        model:
          input.optionPlan.runOptions.model ??
          input.resolvedProvider.profile.model ??
          null,
        usage: collector.usage,
        error: sanitizedCompactionError(error),
        createdAt: new Date().toISOString(),
      });
      if (input.automaticRun) {
        this.emit(input.automaticRun, "context_compaction_failed", {
          runId: input.automaticRun.id,
          sessionId: input.session.id,
          artifactId: failed.id,
          sourceSegmentId: failed.sourceSegmentId,
          targetSegmentId: input.segment.id,
          reason: "summary_only_recovery",
          error: failed.error,
        });
      }
      return {
        state: "failed",
        segment: this.store.getContextSegment(input.segment.id)!,
        artifact: failed,
        message: failed.error ?? undefined,
      };
    }
  }

  private async getModelContextCapability(
    providerProfileId: string,
    modelId: string | null | undefined,
  ) {
    const registry = this.providers as ProviderRegistry & {
      resolveModelContextCapability?: ProviderRegistry["resolveModelContextCapability"];
      getModelContextCapability?: ProviderRegistry["getModelContextCapability"];
    };
    if (typeof registry.resolveModelContextCapability === "function") {
      return registry.resolveModelContextCapability.call(
        this.providers,
        providerProfileId,
        modelId,
      );
    }
    return (
      registry.getModelContextCapability?.call(
        this.providers,
        providerProfileId,
        modelId,
      ) ?? null
    );
  }

  private resolveAgentForSession(
    session: Session,
    explicitAgentId?: string,
  ): AgentDefinition {
    return this.getAgentDefinition(
      explicitAgentId?.trim() || session.agentId || defaultAgentId,
    );
  }

  private getAgentForRun(run: Run): AgentDefinition {
    const snapshot = agentFromRunMetadata(run.metadata);
    if (snapshot) {
      return snapshot;
    }
    const agentId = stringField(run.metadata, "agentId") || defaultAgentId;
    const fallback =
      this.store.getAgentDefinition(agentId) ??
      this.store.getAgentDefinition(defaultAgentId);
    if (!fallback) {
      throw new KernelError(
        "Agent snapshot and fallback profile are unavailable for this legacy run.",
        409,
      );
    }
    this.store.mergeRunMetadata(
      run.id,
      {
        agentSnapshotFallback: "legacy-current-profile",
        agentSnapshotFallbackAgentId: fallback.id,
      },
      new Date().toISOString(),
    );
    return fallback;
  }

  private normalizeAgentDefinition(
    input: CreateAgentDefinitionOptions,
    existingId?: string,
  ): Omit<
    CreateAgentDefinitionInput,
    "id" | "metadata" | "createdAt" | "updatedAt"
  > {
    const name = input.name.trim();
    if (!name || name.length > 120 || hasControlCharacters(name)) {
      throw new KernelError(
        "Agent name must be 1-120 characters without control characters.",
        400,
      );
    }
    const duplicate = this.store
      .listAgentDefinitions()
      .find(
        (agent) =>
          agent.id !== existingId &&
          agent.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
      );
    if (duplicate) {
      throw new KernelError(
        `Agent profile name '${name}' is already in use.`,
        409,
        "duplicate_agent_name",
      );
    }

    const systemPrompt = input.systemPrompt;
    if (
      !systemPrompt.trim() ||
      systemPrompt.length > 20_000 ||
      hasUnsafeTextControlCharacters(systemPrompt)
    ) {
      throw new KernelError(
        "Agent systemPrompt must be 1-20000 characters without unsafe control characters.",
        400,
      );
    }
    const description = input.description?.trim() || null;
    if (
      (description?.length ?? 0) > 1_000 ||
      (description ? hasUnsafeTextControlCharacters(description) : false)
    ) {
      throw new KernelError(
        "Agent description must be 1000 characters or fewer without unsafe control characters.",
        400,
      );
    }

    const modelProfileId = input.modelProfileId?.trim() || null;
    if (
      modelProfileId &&
      !this.providers
        .list()
        .providers.some((profile) => profile.id === modelProfileId)
    ) {
      throw new KernelError(
        `Provider profile '${modelProfileId}' was not found.`,
        400,
        "unknown_provider_profile",
      );
    }

    const defaultRunOptions = normalizeAgentRunOptions(input.defaultRunOptions);
    const contextPolicy = normalizeAgentContextPolicy(input.contextPolicy);
    const skillIds = normalizeAgentIdList(input.skillIds ?? [], "skillIds");
    const toolIds = normalizeAgentIdList(input.toolIds ?? [], "toolIds");
    for (const toolId of toolIds) {
      if (!this.tools.get(toolId)) {
        throw new KernelError(
          `Tool '${toolId}' is not registered.`,
          400,
          "unknown_tool",
        );
      }
    }

    return {
      name,
      description,
      systemPrompt,
      modelProfileId,
      defaultRunOptions,
      contextPolicy,
      skillIds,
      toolIds,
    };
  }

  private nextAgentCopyName(sourceName: string): string {
    const names = new Set(
      this.store
        .listAgentDefinitions()
        .map((agent) => agent.name.trim().toLocaleLowerCase()),
    );
    for (let suffix = 1; suffix <= 10_000; suffix += 1) {
      const copySuffix = ` Copy${suffix === 1 ? "" : ` ${suffix}`}`;
      const candidate = `${sourceName.slice(0, 120 - copySuffix.length).trimEnd()}${copySuffix}`;
      if (!names.has(candidate.toLocaleLowerCase())) {
        return candidate;
      }
    }
    throw new KernelError(
      "Unable to allocate a unique cloned agent name.",
      409,
    );
  }

  private emit(run: Run, type: RunEventType, payload: unknown): RunEvent {
    const event = this.store.appendEvent({
      id: randomUUID(),
      runId: run.id,
      sessionId: run.sessionId,
      type,
      createdAt: new Date().toISOString(),
      payload,
    });
    this.eventBus.publish(event);
    return event;
  }
}

function normalizeAgentRunOptions(
  value: RunOptions | null | undefined,
): RunOptions | null {
  if (!value) {
    return null;
  }
  const options: RunOptions = {};
  const model = value.model?.trim();
  if (model) {
    if (model.length > 200 || hasControlCharacters(model)) {
      throw new KernelError(
        "Agent default model must be 200 characters or fewer without control characters.",
        400,
      );
    }
    options.model = model;
  }
  const reasoningEffort = normalizeReasoningEffort(value.reasoningEffort);
  if (
    value.reasoningEffort &&
    (!reasoningEffort ||
      value.reasoningEffort.length > maxReasoningEffortLength)
  ) {
    throw new KernelError(
      `Agent default reasoning effort must be ${maxReasoningEffortLength} characters or fewer.`,
      400,
    );
  }
  if (reasoningEffort) {
    options.reasoningEffort = reasoningEffort;
  }
  if (value.temperature !== undefined) {
    if (
      !Number.isFinite(value.temperature) ||
      value.temperature < 0 ||
      value.temperature > 2
    ) {
      throw new KernelError(
        "Agent default temperature must be between 0 and 2.",
        400,
      );
    }
    options.temperature = value.temperature;
  }
  return Object.keys(options).length > 0 ? options : null;
}

function normalizeAgentContextPolicy(
  value: AgentDefinition["contextPolicy"] | undefined,
): AgentDefinition["contextPolicy"] {
  if (!value) {
    return null;
  }
  const policy: NonNullable<AgentDefinition["contextPolicy"]> = {};
  if (value.contextWindowTokensOverride !== undefined) {
    if (
      !Number.isInteger(value.contextWindowTokensOverride) ||
      value.contextWindowTokensOverride < 1_024 ||
      value.contextWindowTokensOverride > 2_000_000
    ) {
      throw new KernelError(
        "Agent context window override must be an integer between 1024 and 2000000 tokens.",
        400,
      );
    }
    policy.contextWindowTokensOverride = value.contextWindowTokensOverride;
  }
  if (value.reservedOutputTokens !== undefined) {
    if (
      !Number.isInteger(value.reservedOutputTokens) ||
      value.reservedOutputTokens < 128 ||
      value.reservedOutputTokens > 500_000
    ) {
      throw new KernelError(
        "Agent reserved output tokens must be an integer between 128 and 500000.",
        400,
      );
    }
    policy.reservedOutputTokens = value.reservedOutputTokens;
  }
  if (value.safetyMarginRatio !== undefined) {
    if (
      !Number.isFinite(value.safetyMarginRatio) ||
      value.safetyMarginRatio < 0 ||
      value.safetyMarginRatio > 0.5
    ) {
      throw new KernelError(
        "Agent context safety margin ratio must be between 0 and 0.5.",
        400,
      );
    }
    policy.safetyMarginRatio = value.safetyMarginRatio;
  }
  if (value.automaticCompaction !== undefined) {
    if (typeof value.automaticCompaction !== "boolean") {
      throw new KernelError(
        "Agent automatic compaction must be a boolean.",
        400,
      );
    }
    policy.automaticCompaction = value.automaticCompaction;
  }
  if (
    policy.contextWindowTokensOverride !== undefined &&
    policy.reservedOutputTokens !== undefined &&
    policy.reservedOutputTokens >= policy.contextWindowTokensOverride
  ) {
    throw new KernelError(
      "Agent reserved output tokens must be smaller than the context window override.",
      400,
    );
  }
  return Object.keys(policy).length > 0 ? policy : null;
}

function normalizeAgentIdList(
  values: string[],
  field: "skillIds" | "toolIds",
): string[] {
  if (values.length > 100) {
    throw new KernelError(`Agent ${field} must contain 100 IDs or fewer.`, 400);
  }
  const output: string[] = [];
  for (const value of values) {
    const id = value.trim();
    if (!id || id.length > 120 || hasControlCharacters(id)) {
      throw new KernelError(
        `Agent ${field} must contain non-empty IDs of 120 characters or fewer.`,
        400,
      );
    }
    if (output.includes(id)) {
      throw new KernelError(
        `Agent ${field} contains duplicate ID '${id}'.`,
        400,
      );
    }
    output.push(id);
  }
  return output;
}

function hasUnsafeTextControlCharacters(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function assertExistingDirectory(path: string, label: string): void {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new KernelError(`${label} does not exist: ${path}`, 400);
  }
  if (!stat.isDirectory()) {
    throw new KernelError(`${label} is not a directory: ${path}`, 400);
  }
}

function compareMessagesForTimeline(a: Message, b: Message): number {
  return (
    a.createdAt.localeCompare(b.createdAt) ||
    a.updatedAt.localeCompare(b.updatedAt) ||
    a.id.localeCompare(b.id)
  );
}

function timestampAfter(
  ...timestamps: Array<string | null | undefined>
): string {
  const latestTimestamp = timestamps.reduce((latest, timestamp) => {
    if (!timestamp) {
      return latest;
    }
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
  }, Date.now());
  return new Date(latestTimestamp + 1).toISOString();
}

function isAbortLike(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /aborted/i.test(error.message))
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function publicRunOptions(options: RunOptions | null): RunOptions | null {
  if (!options) {
    return null;
  }
  const output: RunOptions = {};
  const model = sanitizedPublicString(options.model, 240);
  if (model) {
    output.model = model;
  }
  const reasoningEffort = sanitizedPublicString(options.reasoningEffort, 64);
  if (reasoningEffort) {
    output.reasoningEffort = reasoningEffort;
  }
  if (
    typeof options.temperature === "number" &&
    Number.isFinite(options.temperature)
  ) {
    output.temperature = options.temperature;
  }
  return Object.keys(output).length > 0 ? output : null;
}

const compactionStrategyVersion = "continuity-summary-v1";
const compactionSummaryMaxChars = 12_000;
const compactionSummaryMaxTokens = 3_072;
const compactionTimeoutMs = 30_000;
const compactionSummaryHeadings = [
  "Goals and user intent",
  "Decisions and constraints",
  "Current implementation and changed files",
  "Validation and results",
  "Open issues and next work",
  "Important tool results",
];
const compactionSystemPrompt = [
  "Create a cumulative continuity summary for a later model context.",
  `Return plain text with these headings: ${compactionSummaryHeadings.join("; ")}.`,
  "Preserve concrete identifiers and unresolved constraints. Do not call tools, include hidden reasoning, credentials, or raw provider payloads.",
  "The previous summary is authoritative continuity. Merge it with only the supplied new source messages.",
].join("\n");

class CompactionCollector implements ProviderRunWriter {
  text = "";
  usage: RunUsage | null = null;

  writeDelta(text: string): void {
    if (this.text.length <= compactionSummaryMaxChars) {
      this.text += text.slice(
        0,
        compactionSummaryMaxChars + 1 - this.text.length,
      );
    }
  }

  writeUsage(usage: RunUsage): void {
    this.usage = mergeCompactionUsage(this.usage, usage);
  }

  writeMetadata(): void {}
}

interface CompactionSourceEntry {
  messages: Message[];
  category: ContextArtifactSourceCategory;
  hardBoundary: boolean;
}

function selectCompactionSource(
  messages: Message[],
  activeRunId: string | null,
): {
  entries: CompactionSourceEntry[];
  sourceMessages: Message[];
  preservedMessages: Message[];
} {
  const grouped: Message[][] = [];
  for (const message of messages) {
    if (message.role === "user") {
      grouped.push([message]);
    } else if (
      grouped.length > 0 &&
      grouped[grouped.length - 1][0]?.role === "user" &&
      !(
        message.role === "assistant" &&
        grouped[grouped.length - 1].some((item) => item.role === "assistant") &&
        message.runId !== grouped[grouped.length - 1][0]?.runId
      )
    ) {
      grouped[grouped.length - 1].push(message);
    } else {
      grouped.push([message]);
    }
  }
  const entries = grouped.map((group) =>
    classifyCompactionEntry(group, activeRunId),
  );
  const successfulCount = entries.filter(
    (entry) => entry.category.category === "completed_turn",
  ).length;
  let remainingSuccessful = successfulCount;
  const selected: CompactionSourceEntry[] = [];
  for (const entry of entries) {
    if (entry.hardBoundary) break;
    if (
      entry.category.category === "completed_turn" &&
      remainingSuccessful <= 2
    )
      break;
    selected.push(entry);
    if (entry.category.category === "completed_turn") remainingSuccessful -= 1;
  }
  const sourceMessages = selected.flatMap((entry) => entry.messages);
  const sourceIds = new Set(sourceMessages.map((message) => message.id));
  return {
    entries: selected,
    sourceMessages,
    preservedMessages: messages.filter((message) => !sourceIds.has(message.id)),
  };
}

function classifyCompactionEntry(
  messages: Message[],
  activeRunId: string | null,
): CompactionSourceEntry {
  const first = messages[0];
  const runId = first?.runId ?? null;
  const hardBoundary = messages.some(
    (message) =>
      (activeRunId !== null && message.runId === activeRunId) ||
      new MessageVO.Status(message.status).isStreaming(),
  );
  const successfulAssistant = messages.find(
    (message) =>
      message.role === "assistant" &&
      new MessageVO.Status(message.status).isCompleted() &&
      !message.error,
  );
  const terminalFailure = messages.find((message) => {
    const status = new MessageVO.Status(message.status);
    return status.isFailed() || status.isStopped() || Boolean(message.error);
  });
  let category: ContextArtifactSourceCategory["category"];
  let status: string;
  if (first?.role === "user" && successfulAssistant) {
    category = "completed_turn";
    status = "completed";
  } else if (first?.role === "user") {
    category = "unsuccessful_turn";
    status =
      terminalFailure?.status ??
      (hardBoundary ? "active" : "terminal_without_completed_assistant");
  } else if (
    messages.some((message) =>
      message.parts.some(
        (part) => part.type === "tool_result" || part.type === "command_output",
      ),
    )
  ) {
    category = "standalone_tool";
    status = terminalFailure?.status ?? first?.status ?? "completed";
  } else {
    category = "orphan_record";
    status = terminalFailure?.status ?? first?.status ?? "unknown";
  }
  return {
    messages,
    hardBoundary,
    category: {
      category,
      messageIds: messages.map((message) => message.id),
      runId,
      status,
    },
  };
}

function buildCompactionInput(
  previousSummary: string | null,
  entries: CompactionSourceEntry[],
): string {
  const messageText = entries.map(compactionEntryText).join("\n\n");
  return [
    "Previous cumulative summary:",
    previousSummary?.trim() || "(none)",
    "",
    "New finalized source messages:",
    messageText,
  ].join("\n");
}

function buildSummaryRecoveryInput(
  previousArtifactId: string,
  summary: string,
): string {
  return [
    `Previous completed artifact: ${previousArtifactId}`,
    "Create a smaller cumulative continuity summary from this previous summary only.",
    "Do not infer or request sealed raw messages.",
    "",
    summary,
  ].join("\n");
}

function validatedCompactionSummary(
  raw: string,
  inputBudgetTokens: number,
): string {
  const summary = sanitizeCompactionSummary(raw).trim();
  if (!summary)
    throw new Error("Compaction provider returned an empty summary.");
  if (
    !compactionSummaryHeadings.every((heading) =>
      summary.toLowerCase().includes(heading.toLowerCase()),
    )
  ) {
    throw new Error(
      "Compaction provider summary did not contain the required continuity sections.",
    );
  }
  const summaryTokenLimit = Math.min(
    compactionSummaryMaxTokens,
    Math.max(256, Math.floor(inputBudgetTokens * 0.4)),
  );
  if (
    summary.length > compactionSummaryMaxChars ||
    estimateTextTokens(summary) > summaryTokenLimit
  ) {
    throw new Error(
      "Compaction provider summary exceeded the bounded artifact limit.",
    );
  }
  return summary;
}

function compactionEntryText(entry: CompactionSourceEntry): string {
  const header = `[${entry.category.category} · ${entry.category.status} · ${entry.category.messageIds.join(",")}]`;
  if (entry.category.category === "orphan_record") {
    return `${header}\nAudit-only orphan record; raw content intentionally omitted.`;
  }
  if (entry.category.category === "unsuccessful_turn") {
    const users = projectStoredMessagesForContext(
      entry.messages.filter((message) => message.role === "user"),
    );
    const intent = users
      .map((message) => boundHistoricalContextText(message.content))
      .join("\n");
    const error = entry.messages.map((message) => message.error).find(Boolean);
    return `${header}\nUser intent: ${intent || "(unavailable)"}\nTerminal result: ${entry.category.status}${error ? ` · ${sanitizedCompactionError(error)}` : ""}`;
  }
  const projected = projectStoredMessagesForContext(entry.messages);
  const body = projected
    .map(
      (message) =>
        `[${message.role} · ${message.messageId ?? "unknown"}]\n${boundHistoricalContextText(message.content)}`,
    )
    .join("\n\n");
  return `${header}\n${body || "(no provider-visible content)"}`;
}

function entriesFromCategories(
  messages: Message[],
  categories: ContextArtifactSourceCategory[],
): CompactionSourceEntry[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  return categories.map((category) => ({
    category,
    hardBoundary: false,
    messages: category.messageIds.flatMap((id) => {
      const message = byId.get(id);
      return message ? [message] : [];
    }),
  }));
}

function mergeCompactionUsage(
  current: RunUsage | null,
  update: RunUsage,
): RunUsage {
  const output: RunUsage = { ...(current ?? {}) };
  for (const key of [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
  ] as const) {
    if (typeof update[key] === "number") {
      output[key] = update[key];
    }
  }
  return output;
}

function runUsageToJson(usage: RunUsage | null): JsonObject {
  return usage ? { ...usage } : {};
}

function sanitizedCompactionError(error: unknown): string {
  return (
    sanitizedPublicString(
      error instanceof Error ? error.message : String(error),
      800,
    ) ?? "Context compaction failed."
  );
}

function sanitizeCompactionSummary(value: string): string {
  return value
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
    .replace(
      /("(?:access|refresh|id)_?token"\s*:\s*")[^"]+("|$)/gi,
      "$1[REDACTED]$2",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function publicContextPlanSummary(value: unknown): PublicRunSummary["context"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as JsonObject;
  const object = contextPlanObject(record);
  if (!object) {
    return null;
  }
  const planId = stringField(record, "planId");
  const providerTurn = numberField(record, "providerTurn");
  const toolIteration = numberField(record, "toolIteration");
  const inputBudgetTokens = numberField(object, "inputBudgetTokens");
  const estimatedInputTokens = numberField(object, "estimatedInputTokens");
  const providerNeutralTokens =
    numberField(object, "providerNeutralTokens") ?? estimatedInputTokens;
  const nativeOverheadTokens = numberField(object, "nativeOverheadTokens") ?? 0;
  const trimmingApplied = booleanField(object, "trimmingApplied");
  const capabilityStale = booleanField(object, "capabilityStale") ?? false;
  const windowSource = stringField(object, "windowSource");
  if (
    !planId ||
    providerTurn === null ||
    toolIteration === null ||
    inputBudgetTokens === null ||
    estimatedInputTokens === null ||
    providerNeutralTokens === null ||
    nativeOverheadTokens === null ||
    trimmingApplied === null ||
    estimatedInputTokens !== providerNeutralTokens + nativeOverheadTokens ||
    estimatedInputTokens > inputBudgetTokens ||
    (windowSource !== "provider" &&
      windowSource !== "adapter" &&
      windowSource !== "user" &&
      windowSource !== "assumed")
  ) {
    return null;
  }
  return {
    planId,
    providerTurn,
    toolIteration,
    inputBudgetTokens,
    estimatedInputTokens,
    providerNeutralTokens,
    nativeOverheadTokens,
    trimmingApplied,
    windowSource,
    capabilityStale,
  };
}

function contextPlanRecordObjects(metadata: JsonObject): JsonObject[] {
  const records = metadata.contextPlanRecords;
  if (Array.isArray(records)) {
    return records.filter((record): record is JsonObject =>
      Boolean(record && typeof record === "object" && !Array.isArray(record)),
    );
  }
  const legacyPlan = metadata.contextPlan;
  return legacyPlan &&
    typeof legacyPlan === "object" &&
    !Array.isArray(legacyPlan)
    ? [
        {
          planId: "legacy-context-plan",
          providerTurn: 0,
          toolIteration: 0,
          createdAt: "1970-01-01T00:00:00.000Z",
          plan: legacyPlan,
        },
      ]
    : [];
}

function contextPlanObject(record: JsonObject | undefined): JsonObject | null {
  const plan = record?.plan;
  return plan && typeof plan === "object" && !Array.isArray(plan)
    ? (plan as JsonObject)
    : null;
}

function integerJsonField(object: JsonObject | undefined, key: string): number {
  const value = object?.[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : -1;
}

function sanitizedPublicString(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const redacted = value
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
    .replace(
      /("(?:access|refresh|id)_?token"\s*:\s*")[^"]+("|$)/gi,
      "$1[REDACTED]$2",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]");
  const sanitized = redacted
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
  return sanitized || null;
}

async function settleWithin(
  promises: readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<void> {
  if (promises.length === 0) {
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.allSettled(promises).then(() => undefined),
      new Promise<void>((resolvePromise) => {
        timeout = setTimeout(resolvePromise, Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
