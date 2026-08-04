import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { buildContext, defaultAgentId } from "./context-builder";
import type { RunEventBus, RunEventListener } from "./event-bus";
import {
  booleanField,
  buildContextRunMetadata,
  buildRunMetadata,
  buildRunOptionPlan,
  effectiveAgentToolIds,
  mergeRunOptions,
  numberField,
  partString,
  stringField,
  toProviderMessages
} from "./kernel-metadata";
import { RunWriter } from "./run-writer";
import {
  toPublicMessage,
  toPublicProviderResolution,
  toPublicRunEvent,
  toPublicToolExecutionResult,
  toPublicToolInvocation
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
  toolLoopSyntheticMessages,
  toolProviderForPart,
  toPublicPermissionRequest
} from "./tool-execution";
import type { ProviderAdapter, ProviderRunInput, ProviderToolCall } from "../providers/types";
import type { ProviderRegistry } from "../providers/registry";
import type { CreateRunInput, StoreAdapter, StoredPermissionRequest, UpdateAgentDefinitionInput } from "../store/types";
import { ActiveRunExistsStoreError } from "../store/types";
import { providerToolNameToToolId, toModelToolDefinition } from "../shared/model-tools";
import { normalizeToolSettings, toolSettingsSettingKey } from "../shared/tool-settings";
import { evaluateToolPermission, type ToolPermissionEvaluation } from "../tools/permission-policy";
import type { ToolRegistry } from "../tools/registry";
import { ToolExecutionAbortError, ToolInputError, type RegisteredTool } from "../tools/types";
import type {
  AgentDefinition,
  BuiltContext,
  ContextPreviewResponse,
  CreateRunResponse,
  InvokeToolResponse,
  JsonObject,
  Message,
  MessagePart,
  PermissionRequest,
  PermissionRequestStatus,
  PublicRunPhase,
  PublicRunSummary,
  ProviderResolution,
  Run,
  RunEvent,
  RunEventType,
  RunOptions,
  Session,
  ToolDefinition,
  ToolExecutionEvent,
  ToolExecutionResult,
  ToolInvocation,
  ToolInvocationCaller,
  ToolInvocationStatus,
  ToolSettings,
  ToolResultStatus
} from "../shared/types";
import { ACTIVE_RUN_STATUSES, isTerminalRunStatus } from "../shared/types";

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
  commandOutputPart: MessagePart;
  createdAt: string;
  resumeAgentRun: boolean;
  toolLoopIteration?: number;
  providerToolCallName?: string;
  execution: RunExecution;
}

type RunExecutionPhase = "idle" | "provider" | "tool" | "waiting_permission";
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
    readonly details?: Record<string, unknown>
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
  private readonly store: StoreAdapter;
  private readonly providers: ProviderRegistry;
  private readonly eventBus: RunEventBus;
  private readonly tools: ToolRegistry;
  private readonly defaultWorkingDirectory: string;
  private readonly executions = new Map<string, RunExecution>();
  private shuttingDown = false;

  constructor(options: KernelOptions) {
    this.store = options.store;
    this.providers = options.providers;
    this.eventBus = options.eventBus;
    this.tools = options.tools;
    this.defaultWorkingDirectory = resolve(options.toolExecutionCwd ?? homedir());
    assertExistingDirectory(this.defaultWorkingDirectory, "Default session workingDirectory");
  }

  listSessions(): Session[] {
    return this.store.listSessions();
  }

  createSession(options: CreateSessionOptions | string = {}): Session {
    const input = typeof options === "string" ? { title: options } : options;
    const now = new Date().toISOString();
    return this.store.createSession({
      id: randomUUID(),
      title: input.title?.trim() || "New session",
      workingDirectory: this.normalizeWorkingDirectory(input.workingDirectory, { allowDefault: true }),
      createdAt: now,
      updatedAt: now
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
    this.getSession(id);
    const now = new Date().toISOString();
    const updated = this.store.updateSessionWorkingDirectory(id, this.normalizeWorkingDirectory(workingDirectory, { allowDefault: false }), now);
    if (!updated) {
      throw new KernelError("Session not found", 404);
    }
    return updated;
  }

  listMessages(sessionId: string): Message[] {
    this.getSession(sessionId);
    return this.store.listMessages(sessionId).map(toPublicMessage);
  }

  listTools(): ToolDefinition[] {
    return this.tools.list();
  }

  async invokeTool(sessionId: string, toolId: string, input: JsonObject, options: InvokeToolOptions = {}): Promise<InvokeToolResponse> {
    this.assertAcceptingWork();
    const prepared = this.prepareToolInvocation(sessionId, toolId, input, options);
    if (prepared.permission.decision === "allowed") {
      return this.trackExecution(prepared.execution, () => this.executePreparedToolInvocation(prepared, { state: "executed" }));
    }
    if (prepared.permission.decision === "requires_approval") {
      return this.createPendingPermissionResponse(prepared);
    }
    const response = this.denyPreparedToolInvocation(prepared, null);
    this.releaseTerminalExecution(prepared.execution);
    return response;
  }

  startToolInvocation(sessionId: string, toolId: string, input: JsonObject, options: InvokeToolOptions = {}): InvokeToolResponse {
    this.assertAcceptingWork();
    const prepared = this.prepareToolInvocation(sessionId, toolId, input, options);
    if (prepared.permission.decision === "requires_approval") {
      return this.createPendingPermissionResponse(prepared);
    }
    if (prepared.permission.decision === "denied") {
      const response = this.denyPreparedToolInvocation(prepared, null);
      this.releaseTerminalExecution(prepared.execution);
      return response;
    }

    queueMicrotask(() => {
      void this.trackExecution(prepared.execution, () => this.executePreparedToolInvocation(prepared, { state: "executed" })).catch((error) =>
        this.handleQueuedExecutionError(prepared.run.id, prepared.execution, error)
      );
    });
    return {
      state: "running",
      invocation: toPublicToolInvocation(prepared.invocation),
      run: this.toPublicRunSummary(this.store.getRun(prepared.run.id) ?? prepared.run),
      message: toPublicMessage(this.store.getMessage(prepared.assistantMessage.id) ?? prepared.assistantMessage),
      toolCallPartId: prepared.toolCallPart.id,
      commandOutputPartId: prepared.commandOutputPart.id
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
    const agent = this.store.updateAgentDefinition(input);
    if (!agent) {
      throw new KernelError("Agent definition not found", 404);
    }
    return agent;
  }

  previewContext(sessionId: string, options: PreviewContextOptions = {}): ContextPreviewResponse {
    const session = this.getSession(sessionId);
    const agent = this.getAgentDefinition(options.agentId ?? defaultAgentId);
    const resolvedProvider = this.providers.resolveRun({
      provider: options.provider,
      providerProfileId: options.providerProfileId ?? agent.modelProfileId ?? undefined
    });
    const optionPlan = buildRunOptionPlan(resolvedProvider.profile, mergeRunOptions(agent.defaultRunOptions, options.runOptions));
    const providerResolution: ProviderResolution = {
      ...resolvedProvider.providerResolution,
      model: optionPlan.runOptions.model ?? resolvedProvider.providerResolution.model
    };
    const contextResult = buildContext({
      session,
      agent,
      messages: this.store.listMessages(sessionId),
      currentMessage: options.text?.trim() ? { content: options.text } : undefined,
      providerProfileId: resolvedProvider.profile.id,
      runOptions: optionPlan.runOptions,
      availableTools: this.getAvailableToolsForAgent(agent)
    });

    return {
      ...contextResult,
      providerResolution: toPublicProviderResolution(providerResolution),
      requestedRunOptions: optionPlan.requestedRunOptions,
      unsupportedRunOptions: optionPlan.unsupportedRunOptions
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
      ...(activeOnly ? { statuses: ACTIVE_RUN_STATUSES } : {})
    });
  }

  getPublicRun(runId: string): PublicRunSummary {
    return this.toPublicRunSummary(this.getRun(runId));
  }

  listPublicRuns(sessionId?: string, activeOnly = false): PublicRunSummary[] {
    return this.listRuns(sessionId, activeOnly).map((run) => this.toPublicRunSummary(run));
  }

  /** Call only after the server owns the exclusive database lease and has bound its listening socket. */
  reconcileStartupState(): void {
    const reconciledAt = new Date().toISOString();
    this.store.expirePendingPermissionsForTerminalRuns(reconciledAt);
    const pendingPermissionRunIds = new Set(this.store.listPermissionRequests({ status: "pending" }).map((request) => request.runId));
    for (const run of this.store.listRuns({ statuses: ["running"] })) {
      if (pendingPermissionRunIds.has(run.id)) {
        this.store.transitionRunStatus(run.id, ["running"], "waiting_permission", null, reconciledAt);
      }
    }
    const staleRuns = this.store.listRuns({ statuses: ["running", "cancelling"] });
    for (const run of staleRuns) {
      this.finalizeRunTermination(run, "interrupted", "The daemon restarted before the run reached a terminal state.");
    }
  }

  async shutdown(timeoutMs = 5_000): Promise<void> {
    this.shuttingDown = true;
    const activePromises: Promise<unknown>[] = [];
    for (const execution of this.executions.values()) {
      const run = this.store.getRun(execution.runId);
      if (!run || (run.status !== "running" && run.status !== "cancelling")) {
        continue;
      }
      execution.termination ??= run.status === "cancelling" ? "cancelled" : "interrupted";
      execution.controller.abort(new RunTerminationError(execution.termination));
      if (execution.activePromise) {
        activePromises.push(execution.activePromise);
      }
    }

    await settleWithin(activePromises, timeoutMs);
    for (const run of this.store.listRuns({ statuses: ["running", "cancelling"] })) {
      if (run.status === "cancelling") {
        this.finalizeRunTermination(run, "cancelled");
      } else {
        this.finalizeRunTermination(run, "interrupted", "The daemon stopped before the run reached a terminal state.");
      }
    }
    for (const execution of this.executions.values()) {
      this.releaseTerminalExecution(execution);
    }
  }

  startRun(sessionId: string, text: string, options: StartRunOptions = {}): CreateRunResponse {
    this.assertAcceptingWork();
    const session = this.getSession(sessionId);
    const prompt = text.trim();
    if (!prompt) {
      throw new KernelError("Run text is required", 400);
    }

    const agent = this.getAgentDefinition(options.agentId ?? defaultAgentId);
    const requestedRunOptions = mergeRunOptions(agent.defaultRunOptions, options.runOptions);
    const resolvedProvider = this.providers.resolveRun({
      provider: options.provider,
      providerProfileId: options.providerProfileId ?? agent.modelProfileId ?? undefined
    });
    const optionPlan = buildRunOptionPlan(resolvedProvider.profile, requestedRunOptions);
    const providerResolution: ProviderResolution = {
      ...resolvedProvider.providerResolution,
      model: optionPlan.runOptions.model ?? resolvedProvider.providerResolution.model
    };
    const runMetadata = buildRunMetadata(providerResolution, optionPlan, agent, options.runOptions ?? {});
    const now = new Date().toISOString();
    const run = this.createRun({
      id: randomUUID(),
      sessionId,
      provider: resolvedProvider.profile.id,
      status: "running",
      createdAt: now,
      updatedAt: now,
      metadata: runMetadata
    });
    this.store.touchSession(sessionId, now);

    const userMessage = this.store.createMessage({
      id: randomUUID(),
      sessionId,
      runId: run.id,
      role: "user",
      status: "completed",
      createdAt: now,
      updatedAt: now
    });
    this.store.addMessagePart({
      id: randomUUID(),
      messageId: userMessage.id,
      seq: 0,
      text: prompt,
      createdAt: now,
      updatedAt: now
    });

    const assistantCreatedAt = new Date(Date.parse(now) + 1).toISOString();
    const assistantMessage = this.store.createMessage({
      id: randomUUID(),
      sessionId,
      runId: run.id,
      role: "assistant",
      status: "streaming",
      createdAt: assistantCreatedAt,
      updatedAt: assistantCreatedAt,
      metadata: runMetadata
    });

    const sourceMessages = this.store.listMessages(sessionId).filter((message) => message.id !== assistantMessage.id);
    const contextResult = buildContext({
      session,
      agent,
      messages: sourceMessages,
      providerProfileId: resolvedProvider.profile.id,
      runOptions: optionPlan.runOptions,
      availableTools: this.getAvailableToolsForAgent(agent),
      metadata: { runId: run.id }
    });
    const contextMetadata = buildContextRunMetadata(contextResult.context, contextResult.warnings, contextResult.skippedMessageIds);
    this.store.mergeRunMetadata(run.id, contextMetadata, now);
    this.store.mergeMessageMetadata(assistantMessage.id, contextMetadata, now);

    const runWithMetadata = this.store.getRun(run.id)!;
    const userMessageWithParts = this.store.getMessage(userMessage.id)!;
    const assistantMessageWithParts = this.store.getMessage(assistantMessage.id)!;

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
      requestedRunOptions: optionPlan.requestedRunOptions,
      runOptions: optionPlan.runOptions,
      unsupportedRunOptions: optionPlan.unsupportedRunOptions,
      model: optionPlan.runOptions.model ?? null
    });
    this.emit(run, "user_message_created", { message: userMessageWithParts });
    this.emit(run, "assistant_message_created", { message: assistantMessageWithParts });

    const execution = this.getOrCreateExecution(run.id);
    const writer = new RunWriter({
      store: this.store,
      eventBus: this.eventBus,
      run: runWithMetadata,
      assistantMessageId: assistantMessage.id,
      signal: execution.controller.signal
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
      unsupportedRunOptions: optionPlan.unsupportedRunOptions
    };

    queueMicrotask(() => {
      void this.trackExecution(execution, () =>
        this.executeRun(runWithMetadata, resolvedProvider.adapter, providerInput, execution, writer)
      ).catch((error) => this.handleQueuedExecutionError(run.id, execution, error));
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
      assistantMessageId: assistantMessage.id
    };
  }

  cancelRun(runId: string): Run {
    const run = this.getRun(runId);
    if (isTerminalRunStatus(run.status)) {
      return run;
    }

    const cancellation = this.store.requestRunCancellation({
      runId,
      updatedAt: new Date().toISOString(),
      event: {
        id: randomUUID(),
        type: "run_cancelling",
        payload: { runId, status: "cancelling" }
      }
    });
    const cancellingRun = cancellation?.run ?? this.getRun(runId);
    if (isTerminalRunStatus(cancellingRun.status)) {
      return cancellingRun;
    }
    if (cancellation?.event) {
      this.eventBus.publish(cancellation.event);
    }

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
    const pendingForRun = this.store.listPermissionRequests({ status: "pending" }).some((request) => request.runId === run.id);
    if (pendingForRun) {
      throw new KernelError("Run still has pending permissions. Approve or deny them before resuming.", 409);
    }
    const now = new Date().toISOString();
    const resumed = this.store.transitionRunStatus(run.id, ["waiting_permission"], "running", null, now);
    if (!resumed) {
      throw new KernelError("Run changed before it could be resumed.", 409);
    }
    this.store.mergeRunMetadata(run.id, { toolLoopState: "manual_resume_requested" }, now);
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
    return this.eventBus.subscribe(runId, (event) => listener(toPublicRunEvent(event)));
  }

  listPermissionRequests(status?: PermissionRequestStatus): PermissionRequest[] {
    return this.store.listPermissionRequests(status ? { status } : {}).map(toPublicPermissionRequest);
  }

  async approvePermissionRequest(id: string): Promise<InvokeToolResponse> {
    this.assertAcceptingWork();
    const request = this.getResolvablePermissionRequest(id);
    const run = this.getRun(request.runId);
    const isAgentToolPermission = booleanField(request.metadata, "agentToolLoop") === true;
    if (run.status !== "waiting_permission") {
      throw new KernelError("Permission request can only be approved while its run is waiting for permission.", 409);
    }

    const resolvedAt = new Date().toISOString();
    const approvedRequest = this.store.resolvePermissionRequest(request.id, "approved", resolvedAt);
    if (!approvedRequest) {
      throw new KernelError("Permission request or run changed before approval completed.", 409);
    }
    let prepared: PreparedToolInvocation;
    try {
      if (isAgentToolPermission) {
        this.store.mergeRunMetadata(
          run.id,
          {
            toolLoopState: "resuming_after_permission",
            resolvedPermissionRequestId: request.id
          },
          resolvedAt
        );
      }
      const resumedRun = this.getRun(run.id);
      this.emit(resumedRun, "permission.approved", {
        requestId: approvedRequest.id,
        status: "approved",
        reason: approvedRequest.reason,
        riskLevel: approvedRequest.riskLevel,
        request: toPublicPermissionRequest(approvedRequest)
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
        finishRun: !isAgentToolPermission
      })
    );
    if (isAgentToolPermission && this.store.getRun(approvedRequest.runId)?.status === "running") {
      this.queueResumeAgentRun(approvedRequest.runId);
    }
    return response;
  }

  denyPermissionRequest(id: string): InvokeToolResponse {
    this.assertAcceptingWork();
    const request = this.getResolvablePermissionRequest(id);
    const run = this.getRun(request.runId);
    const isAgentToolPermission = booleanField(request.metadata, "agentToolLoop") === true;
    if (run.status !== "waiting_permission") {
      throw new KernelError("Permission request can only be denied while its run is waiting for permission.", 409);
    }

    const resolvedAt = new Date().toISOString();
    const deniedRequest = this.store.resolvePermissionRequest(request.id, "denied", resolvedAt);
    if (!deniedRequest) {
      throw new KernelError("Permission request or run changed before denial completed.", 409);
    }
    let prepared: PreparedToolInvocation;
    try {
      if (isAgentToolPermission) {
        this.store.mergeRunMetadata(
          run.id,
          {
            toolLoopState: "resuming_after_permission_denial",
            resolvedPermissionRequestId: request.id
          },
          resolvedAt
        );
      }
      const resumedRun = this.getRun(run.id);
      this.emit(resumedRun, "permission.denied", {
        requestId: deniedRequest.id,
        status: "denied",
        reason: deniedRequest.reason,
        riskLevel: deniedRequest.riskLevel,
        request: toPublicPermissionRequest(deniedRequest)
      });
      prepared = this.prepareToolInvocationFromPermission(deniedRequest);
    } catch (error) {
      this.failResolvedPermissionPreparation(run.id, error);
      throw error;
    }
    const response = this.denyPreparedToolInvocation(prepared, deniedRequest, {
      finishRun: !isAgentToolPermission
    });
    if (isAgentToolPermission && this.store.getRun(deniedRequest.runId)?.status === "running") {
      this.queueResumeAgentRun(deniedRequest.runId);
    } else {
      this.releaseTerminalExecution(prepared.execution);
    }
    return response;
  }

  private prepareToolInvocation(sessionId: string, toolId: string, input: JsonObject, options: InvokeToolOptions): PreparedToolInvocation {
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
      executionInput = registeredTool.executor.validateInput?.(input, validationContext) ?? input;
      publicInput = registeredTool.executor.toPublicInput?.(executionInput, validationContext) ?? executionInput;
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
      settings: toolSettings
    });
    const now = new Date().toISOString();
    const run = this.createRun({
      id: randomUUID(),
      sessionId,
      provider: `tool:${registeredTool.definition.id}`,
      status: "running",
      createdAt: now,
      updatedAt: now,
      metadata: buildToolRunMetadata(registeredTool.definition, publicInput, caller, permission, executionCwd)
    });
    this.store.touchSession(sessionId, now);

    const assistantMessage = this.store.createMessage({
      id: randomUUID(),
      sessionId,
      runId: run.id,
      role: "assistant",
      status: "streaming",
      createdAt: now,
      updatedAt: now,
      metadata: buildToolMessageMetadata(registeredTool.definition, publicInput, caller, permission)
    });

    const invocation: ToolInvocation = {
      id: randomUUID(),
      toolId: registeredTool.definition.id,
      toolName: registeredTool.definition.name,
      sessionId,
      runId: run.id,
      messageId: assistantMessage.id,
      caller,
      status: permission.decision === "allowed" ? "created" : "pending_permission",
      permissionDecision: permission.decision,
      input: publicInput,
      metadata: {
        toolSource: registeredTool.definition.source,
        executionCwd,
        permissionRuleId: permission.ruleId,
        riskLevel: permission.riskLevel
      },
      createdAt: now,
      updatedAt: now
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
      riskLevel: permission.riskLevel
    });
    this.emit(run, "assistant_message_created", { message: this.store.getMessage(assistantMessage.id)! });

    const execution = this.getOrCreateExecution(run.id);
    const writer = new RunWriter({
      store: this.store,
      eventBus: this.eventBus,
      run,
      assistantMessageId: assistantMessage.id,
      signal: execution.controller.signal
    });

    const toolCallPart = writer.recordToolCall({
      callId: invocation.id,
      toolId: registeredTool.definition.id,
      toolName: registeredTool.definition.name,
      provider: toolProviderForPart(registeredTool.definition.id),
      input: publicInput,
      inputSummary: summarizeToolInput(registeredTool.definition.id, publicInput),
      metadata: {
        caller,
        permissionDecision: permission.decision,
        permissionAction: permission.action,
        permissionRuleId: permission.ruleId,
        riskLevel: permission.riskLevel,
        toolSource: registeredTool.definition.source
      }
    });

    const commandOutputPart = writer.recordCommandOutput({
      callId: invocation.id,
      stream: "combined",
      text: "",
      cwd: stringField(executionInput, "cwd"),
      metadata: {
        invocationId: invocation.id,
        toolId: registeredTool.definition.id
      }
    });

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
      execution
    };
  }

  private prepareToolInvocationFromPermission(request: StoredPermissionRequest): PreparedToolInvocation {
    const registeredTool = this.tools.get(request.toolId);
    if (!registeredTool) {
      throw new KernelError("Tool not found for permission request", 404);
    }
    const run = this.getRun(request.runId);
    const assistantMessage = this.store.getMessage(request.messageId);
    if (!assistantMessage) {
      throw new KernelError("Assistant message for permission request not found", 404);
    }
    const toolCallPart = assistantMessage.parts.find((part) => part.id === request.toolCallPartId);
    if (!toolCallPart) {
      throw new KernelError("Tool call part for permission request not found", 404);
    }
    const commandOutputPart = request.commandOutputPartId
      ? assistantMessage.parts.find((part) => part.id === request.commandOutputPartId)
      : null;
    if (!commandOutputPart) {
      throw new KernelError("Command output part for permission request not found", 404);
    }

    const executionCwd = stringField(request.metadata, "executionCwd") || this.getToolExecutionCwd(this.getSession(request.sessionId));
    const permission = permissionEvaluationFromRequest(request, executionCwd);
    const invocation: ToolInvocation = {
      id: request.invocationId,
      toolId: request.toolId,
      toolName: request.toolName,
      sessionId: request.sessionId,
      runId: request.runId,
      messageId: request.messageId,
      caller: request.caller,
      status: request.status === "approved" ? "created" : "pending_permission",
      permissionDecision: request.permissionDecision,
      input: request.publicInput,
      metadata: request.metadata,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt
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
        signal: execution.controller.signal
      }),
      toolCallPart,
      commandOutputPart,
      createdAt: request.createdAt,
      resumeAgentRun: booleanField(request.metadata, "agentToolLoop") === true,
      toolLoopIteration: numberField(request.metadata, "toolLoopIteration") ?? undefined,
      providerToolCallName: stringField(request.metadata, "providerToolCallName") || undefined,
      execution
    };
  }

  private createPendingPermissionResponse(prepared: PreparedToolInvocation): InvokeToolResponse {
    const now = new Date().toISOString();
    const executionCwd = prepared.executionCwd;
    const toolCallPart = this.updateToolCallStatus(prepared.toolCallPart, "pending_permission", now);
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
      inputSummary: summarizeToolInput(prepared.registeredTool.definition.id, prepared.publicInput),
      publicInput: prepared.publicInput,
      executionInput: prepared.executionInput,
      riskLevel: prepared.permission.riskLevel,
      reason: prepared.permission.reason,
      status: "pending",
      toolCallPartId: toolCallPart.id,
      commandOutputPartId: prepared.commandOutputPart.id,
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
              providerToolCallName: prepared.providerToolCallName ?? null
            }
          : {})
      },
      createdAt: now,
      updatedAt: now
    });

    this.emit(prepared.run, "permission.requested", {
      requestId: permissionRequest.id,
      status: "requested",
      reason: permissionRequest.reason,
      riskLevel: permissionRequest.riskLevel,
      request: toPublicPermissionRequest(permissionRequest)
    });

    this.markRunWaitingForPermission(prepared.run, prepared.assistantMessage.id, permissionRequest.id);
    const waitingMessage = this.store.getMessage(prepared.assistantMessage.id);
    if (waitingMessage) {
      this.emit(prepared.run, "assistant_message_updated", { message: waitingMessage });
    }
    prepared.execution.phase = "waiting_permission";
    prepared.execution.toolId = prepared.registeredTool.definition.id;

    return {
      state: "pending_permission",
      invocation: toPublicToolInvocation({ ...prepared.invocation, status: "pending_permission", updatedAt: now }),
      permissionRequest: toPublicPermissionRequest(permissionRequest),
      run: this.toPublicRunSummary(this.store.getRun(prepared.run.id)!),
      message: toPublicMessage(this.store.getMessage(prepared.assistantMessage.id)!),
      toolCallPartId: toolCallPart.id,
      commandOutputPartId: prepared.commandOutputPart.id
    };
  }

  private async executePreparedToolInvocation(
    prepared: PreparedToolInvocation,
    responseOptions: { state: "executed"; permissionRequest?: PermissionRequest; finishRun?: boolean }
  ): Promise<InvokeToolResponse> {
    const { registeredTool, executionInput, caller, permission, run, assistantMessage, invocation, writer } = prepared;
    const execution = prepared.execution;
    execution.phase = "tool";
    execution.toolId = registeredTool.definition.id;
    const executionCwd = prepared.executionCwd;
    const commandOutputMaxChars = commandOutputMaxCharsForTool(registeredTool.definition.id, this.getToolSettings());
    let toolCallPart = prepared.toolCallPart;
    let commandOutputPart = prepared.commandOutputPart;
    let commandOutputText = partString(commandOutputPart, "text") || commandOutputPart.text || "";
    let commandOutputTruncated = false;

    const startedAt = new Date().toISOString();
    const runningInvocation: ToolInvocation = { ...invocation, status: "running", updatedAt: startedAt };
    toolCallPart = this.updateToolCallStatus(toolCallPart, "running", startedAt);
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
      status: "running"
    });

    const onToolEvent = (event: ToolExecutionEvent): void => {
      const currentRun = this.store.getRun(run.id);
      if (execution.controller.signal.aborted || !currentRun || isTerminalRunStatus(currentRun.status)) {
        return;
      }
      if (event.type === "tool.stdout.delta" || event.type === "tool.stderr.delta") {
        const delta = typeof event.payload.text === "string" ? event.payload.text : "";
        if (!delta) {
          return;
        }
        const nextOutput = appendLimitedText(commandOutputText, commandOutputTruncated, delta, commandOutputMaxChars, "command output");
        commandOutputText = nextOutput.text;
        commandOutputTruncated = nextOutput.truncated;
        const updatedAt = new Date().toISOString();
        commandOutputPart = this.updateCommandOutputPart(commandOutputPart, commandOutputText, updatedAt, {
          truncated: commandOutputTruncated
        });
        this.emit(run, event.type, {
          ...event.payload,
          messageId: assistantMessage.id,
          partId: commandOutputPart.id,
          part: commandOutputPart,
          callId: invocation.id,
          toolId: registeredTool.definition.id,
          toolName: registeredTool.definition.name
        });
        return;
      }

      this.emit(run, event.type, {
        ...event.payload,
        messageId: assistantMessage.id,
        callId: invocation.id,
        toolId: registeredTool.definition.id,
        toolName: registeredTool.definition.name
      });
    };

    let result: ToolExecutionResult;
    try {
      const output = await registeredTool.executor.execute(executionInput, {
        invocation: runningInvocation,
        cwd: executionCwd,
        signal: execution.controller.signal,
        emit: onToolEvent
      });
      if (execution.controller.signal.aborted) {
        throw new ToolExecutionAbortError("Tool execution was cancelled.", output);
      }
      const completedAt = new Date().toISOString();
      result = buildToolExecutionResult(invocation, registeredTool.definition.id, output, startedAt, completedAt);
    } catch (error) {
      const completedAt = new Date().toISOString();
      const toolError = toError(error);
      const cancelled = execution.controller.signal.aborted || error instanceof ToolExecutionAbortError || isAbortLike(error);
      result = {
        invocationId: invocation.id,
        toolId: registeredTool.definition.id,
        status: cancelled ? "cancelled" : "failed",
        output: error instanceof ToolExecutionAbortError ? error.output : {},
        error: toolError.message,
        startedAt,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        metadata: {
          ...(cancelled ? { cancelled: true } : { failedBeforeResult: true })
        }
      };
    }

    const completedAt = result.completedAt;
    const finalInvocation: ToolInvocation = { ...invocation, status: result.status, updatedAt: completedAt };
    const persistedRun = this.store.getRun(run.id);
    const terminating = execution.controller.signal.aborted;
    if (!persistedRun || isTerminalRunStatus(persistedRun.status)) {
      return {
        state: responseOptions.state,
        invocation: toPublicToolInvocation(finalInvocation),
        result: toPublicToolExecutionResult(result),
        permissionRequest: responseOptions.permissionRequest,
        run: this.toPublicRunSummary(this.store.getRun(run.id) ?? persistedRun ?? run),
        message: toPublicMessage(this.store.getMessage(assistantMessage.id)!),
        toolCallPartId: toolCallPart.id,
        commandOutputPartId: commandOutputPart.id
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
        commandOutputPartId: commandOutputPart.id
      };
    }
    commandOutputPart = this.updateCommandOutputPart(commandOutputPart, commandOutputText, completedAt, commandOutputMetadataFromResult(result, commandOutputTruncated));
    toolCallPart = this.updateToolCallStatus(toolCallPart, terminating ? "cancelled" : result.status, completedAt);
    this.emit(run, !terminating && result.status === "completed" ? "tool.completed" : "tool.failed", {
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
      durationMs: result.durationMs
    });
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
                providerToolCallName: prepared.providerToolCallName ?? null
              }
            : {}),
          ...(result.metadata ?? {})
        }
      },
      { allowWhileTerminating: terminating }
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
        toolResultPartId: toolResultPart.id
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
      toolResultPartId: toolResultPart.id
    };
  }

  private denyPreparedToolInvocation(
    prepared: PreparedToolInvocation,
    request: StoredPermissionRequest | null,
    options: { finishRun?: boolean } = {}
  ): InvokeToolResponse {
    const now = new Date().toISOString();
    const executionCwd = prepared.executionCwd;
    const permissionRequest = request ?? this.store.createPermissionRequest({
      id: randomUUID(),
      sessionId: prepared.invocation.sessionId,
      runId: prepared.run.id,
      messageId: prepared.assistantMessage.id,
      invocationId: prepared.invocation.id,
      toolId: prepared.registeredTool.definition.id,
      toolName: prepared.registeredTool.definition.name,
      caller: prepared.caller,
      permissionDecision: prepared.permission.decision,
      inputSummary: summarizeToolInput(prepared.registeredTool.definition.id, prepared.publicInput),
      publicInput: prepared.publicInput,
      executionInput: prepared.executionInput,
      riskLevel: prepared.permission.riskLevel,
      reason: prepared.permission.reason,
      status: "denied",
      toolCallPartId: prepared.toolCallPart.id,
      commandOutputPartId: prepared.commandOutputPart.id,
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
              providerToolCallName: prepared.providerToolCallName ?? null
            }
          : {})
      },
      createdAt: now,
      updatedAt: now,
      resolvedAt: now
    });

    if (!request) {
      this.emit(prepared.run, "permission.denied", {
        requestId: permissionRequest.id,
        status: "denied",
        reason: permissionRequest.reason,
        riskLevel: permissionRequest.riskLevel,
        request: toPublicPermissionRequest(permissionRequest)
      });
    }

    const completedAt = new Date().toISOString();
    const result = buildPermissionBlockedResult(
      prepared.invocation,
      prepared.registeredTool.definition.id,
      request ? "denied" : prepared.permission.decision,
      prepared.permission.reason,
      prepared.createdAt,
      completedAt
    );
    const toolCallPart = this.updateToolCallStatus(prepared.toolCallPart, result.status, completedAt);
    const toolResultPart = prepared.writer.recordToolResult({
      callId: prepared.invocation.id,
      toolId: prepared.registeredTool.definition.id,
      toolName: prepared.registeredTool.definition.name,
      status: result.status,
      outputSummary: result.error ?? "Tool execution denied by permission policy.",
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
              providerToolCallName: prepared.providerToolCallName ?? null
            }
          : {})
      }
    });
    if (options.finishRun !== false) {
      prepared.writer.fail(new Error(result.error ?? "Tool execution denied by permission policy."));
    }

    return {
      state: "denied",
      invocation: toPublicToolInvocation({ ...prepared.invocation, status: result.status, updatedAt: completedAt }),
      result: toPublicToolExecutionResult(result),
      permissionRequest: toPublicPermissionRequest(permissionRequest),
      run: this.toPublicRunSummary(this.store.getRun(prepared.run.id)!),
      message: toPublicMessage(this.store.getMessage(prepared.assistantMessage.id)!),
      toolCallPartId: toolCallPart.id,
      commandOutputPartId: prepared.commandOutputPart.id,
      toolResultPartId: toolResultPart.id
    };
  }

  private getResolvablePermissionRequest(id: string): StoredPermissionRequest {
    const request = this.store.getPermissionRequest(id);
    if (!request) {
      throw new KernelError("Permission request not found", 404);
    }
    if (request.status !== "pending") {
      throw new KernelError(`Permission request is already ${request.status}.`, 409);
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
      activePromise: null
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
          { run: this.toPublicRunSummary(error.activeRun) }
        );
      }
      throw error;
    }
  }

  private toPublicRunSummary(run: Run): PublicRunSummary {
    return {
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
      error: sanitizedPublicString(run.error, 1_000)
    };
  }

  private publicRunPhase(run: Run): PublicRunPhase | null {
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
    return phase === "provider" || phase === "tool" ? phase : "running";
  }

  private assertAcceptingWork(): void {
    if (this.shuttingDown) {
      throw new KernelError("The daemon is shutting down and is not accepting new work.", 503);
    }
  }

  private async trackExecution<T>(execution: RunExecution, operation: () => Promise<T>): Promise<T> {
    if (execution.activePromise) {
      throw new KernelError(`Run '${execution.runId}' already has active work.`, 409);
    }

    let activePromise: Promise<T> | null = null;
    try {
      const run = this.store.getRun(execution.runId);
      if (!run || run.status !== "running") {
        throw new KernelError(`Run '${execution.runId}' is not available for execution.`, 409);
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
      execution.phase = run?.status === "waiting_permission" ? "waiting_permission" : "idle";
      if (execution.phase === "idle") {
        execution.toolId = null;
      }
      this.finalizeRequestedTermination(execution);
      this.releaseTerminalExecution(execution);
    }
  }

  private finishAbortedWriter(execution: RunExecution, writer: RunWriter): void {
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
    if (!run || isTerminalRunStatus(run.status)) {
      return;
    }
    if (execution.termination === "cancelled" && run.status !== "cancelling") {
      return;
    }
    this.finalizeRunTermination(run, execution.termination);
  }

  private finalizeRunTermination(run: Run, termination: RunTermination, reason?: string): void {
    if (isTerminalRunStatus(run.status)) {
      return;
    }
    const assistantMessage = this.getLatestAssistantMessageForRun(run.id);
    if (assistantMessage) {
      const writer = new RunWriter({
        store: this.store,
        eventBus: this.eventBus,
        run: this.store.getRun(run.id) ?? run,
        assistantMessageId: assistantMessage.id
      });
      if (termination === "interrupted") {
        writer.interrupt(reason);
      } else {
        writer.cancel();
      }
      return;
    }

    const updatedAt = new Date().toISOString();
    const error = termination === "interrupted" ? reason ?? "The daemon stopped before the run reached a terminal state." : null;
    const status = termination === "interrupted" ? "interrupted" : "cancelled";
    const result = this.store.finalizeRun({
      runId: run.id,
      expectedStatuses: termination === "interrupted" ? ["running", "cancelling"] : ["running", "waiting_permission", "cancelling"],
      status,
      error,
      updatedAt,
      event: {
        id: randomUUID(),
        type: termination === "interrupted" ? "run_interrupted" : "run_cancelled",
        payload: {
          ...(error ? { error } : {}),
          runId: run.id
        }
      }
    });
    if (result) {
      this.eventBus.publish(result.event);
    }
  }

  private releaseTerminalExecution(execution: RunExecution): void {
    const run = this.store.getRun(execution.runId);
    if (run && isTerminalRunStatus(run.status) && this.executions.get(execution.runId) === execution) {
      this.executions.delete(execution.runId);
    }
  }

  private handleQueuedExecutionError(runId: string, execution: RunExecution, error: unknown): void {
    if (error instanceof KernelError && error.statusCode === 409 && execution.activePromise) {
      return;
    }
    const run = this.store.getRun(runId);
    if (!run || isTerminalRunStatus(run.status)) {
      this.releaseTerminalExecution(execution);
      return;
    }
    console.error("Agent run execution failed", { runId, error: toError(error).message });
    this.finalizeExecutionError(execution, error);
  }

  private finalizeExecutionError(execution: RunExecution, error: unknown): void {
    const run = this.store.getRun(execution.runId);
    if (!run || isTerminalRunStatus(run.status)) {
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
      new RunWriter({ store: this.store, eventBus: this.eventBus, run, assistantMessageId: assistantMessage.id }).fail(runError);
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
        payload: { runId: run.id, error: runError.message }
      }
    });
    if (result) {
      this.eventBus.publish(result.event);
    }
  }

  private failResolvedPermissionPreparation(runId: string, error: unknown): void {
    const execution = this.getOrCreateExecution(runId);
    this.finalizeExecutionError(execution, error);
    this.releaseTerminalExecution(execution);
  }

  private getToolSettings(): ToolSettings {
    return normalizeToolSettings(this.store.listSettings()[toolSettingsSettingKey]);
  }

  private getToolExecutionCwd(session: Session): string {
    const workingDirectory = resolve(session.workingDirectory || this.defaultWorkingDirectory);
    assertExistingDirectory(workingDirectory, "Session workingDirectory");
    return workingDirectory;
  }

  private normalizeWorkingDirectory(value: string | undefined, options: { allowDefault: boolean }): string {
    const candidate = value?.trim();
    if (!candidate) {
      if (options.allowDefault) {
        return this.defaultWorkingDirectory;
      }
      throw new KernelError("Session workingDirectory must be a non-empty path.", 400);
    }

    const workingDirectory = resolve(candidate);
    assertExistingDirectory(workingDirectory, "Session workingDirectory");
    return workingDirectory;
  }

  private updateToolCallStatus(part: MessagePart, status: ToolInvocationStatus | ToolResultStatus, updatedAt: string): MessagePart {
    return (
      this.store.updateMessagePart({
        id: part.id,
        text: part.text,
        content: { ...part.content, status },
        metadata: part.metadata,
        updatedAt
      }) ?? part
    );
  }

  private updateCommandOutputPart(part: MessagePart, text: string, updatedAt: string, metadata: JsonObject = {}): MessagePart {
    const nextMetadata = { ...part.metadata, ...metadata };
    const nextContent: JsonObject = { ...part.content, text };
    if (typeof metadata.cwd === "string") {
      nextContent.cwd = metadata.cwd;
    }
    if (typeof metadata.exitCode === "number" && Number.isFinite(metadata.exitCode)) {
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
        updatedAt
      }) ?? part
    );
  }

  private async executeRun(
    run: Run,
    provider: ProviderAdapter,
    input: ProviderRunInput,
    execution: RunExecution,
    writer: RunWriter
  ): Promise<void> {
    let activeWriter = writer;
    execution.providerId = provider.id;
    try {
      await this.executeAgentToolLoop(run, provider, input, execution, writer, (nextWriter) => {
        activeWriter = nextWriter;
      });
    } catch (error) {
      if (execution.controller.signal.aborted || isAbortLike(error)) {
        this.finishAbortedWriter(execution, activeWriter);
      } else {
        const runError = toError(error);
        console.error("Provider run failed", {
          runId: run.id,
          provider: provider.id,
          error: runError.message
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
    startingIteration = numberField(run.metadata, "toolIterations") ?? 0
  ): Promise<void> {
    let providerInput = this.withCurrentToolLoopContext(input, run.id);
    let iteration = startingIteration;
    let currentWriter = writer;

    while (true) {
      execution.phase = "provider";
      execution.toolId = null;
      const result = await provider.run(providerInput, {
        signal: execution.controller.signal,
        writer: currentWriter
      });

      if (execution.controller.signal.aborted) {
        this.finishAbortedWriter(execution, currentWriter);
        return;
      }

      const toolCalls = result.toolCalls ?? [];
      if (toolCalls.length === 0) {
        currentWriter.writeMetadata({ toolIterations: iteration, toolLoopState: "completed" });
        currentWriter.complete();
        return;
      }

      const nextIteration = iteration + 1;
      currentWriter.writeMetadata({
        toolIterations: nextIteration,
        toolLoopState: "executing_tools",
        modelToolCallCount: toolCalls.length
      });

      const assistantMessage = this.store.getMessage(currentWriter.messageId);
      if (!assistantMessage) {
        throw new KernelError("Assistant message for run not found", 404);
      }

      const step = await this.handleModelToolCalls(run, currentWriter, assistantMessage, toolCalls, nextIteration);
      if (step === "waiting_permission") {
        return;
      }
      if (execution.controller.signal.aborted) {
        this.finishAbortedWriter(execution, currentWriter);
        return;
      }

      currentWriter.completeMessage();
      iteration = nextIteration;
      currentWriter = this.createFollowUpAssistantWriter(run, iteration, execution);
      onActiveWriterChange(currentWriter);
      providerInput = this.withCurrentToolLoopContext(input, run.id);
    }
  }

  private async handleModelToolCalls(
    run: Run,
    writer: RunWriter,
    assistantMessage: Message,
    toolCalls: ProviderToolCall[],
    iteration: number
  ): Promise<"continue" | "waiting_permission"> {
    for (const toolCall of toolCalls) {
      const prepared = this.prepareModelToolInvocation(run, assistantMessage, writer, toolCall, iteration);
      if (!prepared) {
        continue;
      }

      if (prepared.permission.decision === "allowed") {
        await this.executePreparedToolInvocation(prepared, { state: "executed", finishRun: false });
        if (prepared.execution.controller.signal.aborted) {
          return "continue";
        }
        continue;
      }

      if (prepared.permission.decision === "requires_approval") {
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
    iteration: number
  ): PreparedToolInvocation | null {
    const providerToolName = toolCall.name.trim();
    const canonicalToolId = providerToolNameToToolId(providerToolName) ?? providerToolName;
    const registeredTool = this.tools.get(canonicalToolId);
    const callId = normalizeToolCallId(toolCall.id);
    const toolName = registeredTool?.definition.name ?? providerToolName;

    if (!registeredTool) {
      const toolCallPart = writer.recordToolCall({
        callId,
        toolId: canonicalToolId || providerToolName || "unknown",
        toolName,
        provider: "native",
        inputSummary: `Unsupported model tool call: ${providerToolName || "unknown"}`,
        metadata: {
          caller: "model",
          providerToolCallName: providerToolName,
          toolLoopIteration: iteration,
          unsupportedTool: true
        }
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
          toolLoopIteration: iteration
        }
      });
      return null;
    }

    if (stringField(toolCall.metadata ?? {}, "argumentsParseError")) {
      const parseError = stringField(toolCall.metadata ?? {}, "argumentsParseError");
      const toolCallPart = writer.recordToolCall({
        callId,
        toolId: registeredTool.definition.id,
        toolName: registeredTool.definition.name,
        provider: toolProviderForPart(registeredTool.definition.id),
        inputSummary: `Invalid tool arguments for ${providerToolName}: ${parseError}`,
        metadata: {
          caller: "model",
          providerToolCallName: providerToolName,
          toolLoopIteration: iteration,
          argumentsParseError: parseError
        }
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
          toolLoopIteration: iteration
        }
      });
      return null;
    }

    const executionCwd = this.getToolExecutionCwd(this.getSession(run.sessionId));
    const validationContext = { cwd: executionCwd };
    let executionInput: JsonObject;
    let publicInput: JsonObject;
    try {
      executionInput = registeredTool.executor.validateInput?.(toolCall.arguments, validationContext) ?? toolCall.arguments;
      publicInput = registeredTool.executor.toPublicInput?.(executionInput, validationContext) ?? executionInput;
    } catch (error) {
      const validationError = error instanceof ToolInputError ? new KernelError(error.message, error.statusCode) : toError(error);
      const toolCallPart = writer.recordToolCall({
        callId,
        toolId: registeredTool.definition.id,
        toolName: registeredTool.definition.name,
        provider: toolProviderForPart(registeredTool.definition.id),
        inputSummary: `Invalid ${registeredTool.definition.id} input: ${validationError.message}`,
        metadata: {
          caller: "model",
          providerToolCallName: providerToolName,
          toolLoopIteration: iteration,
          validationError: validationError.message
        }
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
          toolLoopIteration: iteration
        }
      });
      return null;
    }

    const permission = evaluateToolPermission({
      tool: registeredTool.definition,
      caller: "model",
      publicInput,
      executionInput,
      executionCwd,
      settings: this.getToolSettings()
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
      status: permission.decision === "allowed" ? "created" : "pending_permission",
      permissionDecision: permission.decision,
      input: publicInput,
      metadata: {
        toolSource: registeredTool.definition.source,
        executionCwd,
        permissionRuleId: permission.ruleId,
        riskLevel: permission.riskLevel,
        providerToolCallName: providerToolName,
        toolLoopIteration: iteration,
        agentToolLoop: true
      },
      createdAt: now,
      updatedAt: now
    };
    const toolCallPart = writer.recordToolCall({
      callId: invocation.id,
      toolId: registeredTool.definition.id,
      toolName: registeredTool.definition.name,
      provider: toolProviderForPart(registeredTool.definition.id),
      input: publicInput,
      inputSummary: summarizeToolInput(registeredTool.definition.id, publicInput),
      metadata: {
        caller: "model",
        providerToolCallName: providerToolName,
        toolLoopIteration: iteration,
        permissionDecision: permission.decision,
        permissionAction: permission.action,
        permissionRuleId: permission.ruleId,
        riskLevel: permission.riskLevel,
        toolSource: registeredTool.definition.source,
        agentToolLoop: true
      }
    });
    const commandOutputPart = writer.recordCommandOutput({
      callId: invocation.id,
      stream: "combined",
      text: "",
      cwd: stringField(executionInput, "cwd"),
      metadata: {
        invocationId: invocation.id,
        toolId: registeredTool.definition.id,
        caller: "model",
        toolLoopIteration: iteration,
        agentToolLoop: true
      }
    });

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
      execution: this.getOrCreateExecution(run.id)
    };
  }

  private withCurrentToolLoopContext(input: ProviderRunInput, runId: string): ProviderRunInput {
    const assistantMessages = this.listAssistantMessagesForRun(runId);
    if (assistantMessages.length === 0) {
      return input;
    }
    const syntheticToolMessages = assistantMessages.flatMap((message) => toolLoopSyntheticMessages(message));
    if (syntheticToolMessages.length === 0) {
      return input;
    }
    const context: BuiltContext = {
      ...input.context,
      messages: [...input.context.messages, ...syntheticToolMessages],
      metadata: {
        ...input.context.metadata,
        toolLoopSyntheticMessageCount: syntheticToolMessages.length
      }
    };
    return {
      ...input,
      context,
      messages: toProviderMessages(context)
    };
  }

  private markRunWaitingForPermission(run: Run, messageId: string, permissionRequestId: string): void {
    const now = new Date().toISOString();
    this.store.mergeRunMetadata(
      run.id,
      {
        toolLoopState: "waiting_permission",
        pendingPermissionRequestId: permissionRequestId
      },
      now
    );
    this.store.mergeMessageMetadata(
      messageId,
      {
        toolLoopState: "waiting_permission",
        pendingPermissionRequestId: permissionRequestId
      },
      now
    );
    this.emit(run, "run_waiting_permission", {
      runId: run.id,
      sessionId: run.sessionId,
      messageId,
      permissionRequestId,
      status: "waiting_permission"
    });
  }

  private queueResumeAgentRun(runId: string): void {
    queueMicrotask(() => {
      if (this.shuttingDown) {
        return;
      }
      const execution = this.getOrCreateExecution(runId);
      void this.trackExecution(execution, () => this.resumeAgentRun(runId, execution)).catch((error) =>
        this.handleQueuedExecutionError(runId, execution, error)
      );
    });
  }

  private async resumeAgentRun(runId: string, execution: RunExecution): Promise<void> {
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
    const writer = this.createFollowUpAssistantWriter(run, numberField(run.metadata, "toolIterations") ?? 0, execution);
    await this.executeRun(this.store.getRun(run.id) ?? run, provider, input, execution, writer);
  }

  private createFollowUpAssistantWriter(run: Run, iteration: number, execution: RunExecution): RunWriter {
    const runSnapshot = this.store.getRun(run.id) ?? run;
    const priorAssistantMessages = this.listAssistantMessagesForRun(run.id);
    const createdAt = timestampAfter(runSnapshot.updatedAt, ...priorAssistantMessages.map((message) => message.updatedAt));
    const message = this.store.createMessage({
      id: randomUUID(),
      sessionId: runSnapshot.sessionId,
      runId: runSnapshot.id,
      role: "assistant",
      status: "streaming",
      createdAt,
      updatedAt: createdAt,
      metadata: {
        ...runSnapshot.metadata,
        toolLoopIteration: iteration,
        toolLoopMessageKind: "assistant_followup",
        toolLoopState: "awaiting_model_followup"
      }
    });
    this.store.touchSession(runSnapshot.sessionId, createdAt);
    this.emit(runSnapshot, "assistant_message_created", { message });
    return new RunWriter({
      store: this.store,
      eventBus: this.eventBus,
      run: runSnapshot,
      assistantMessageId: message.id,
      signal: execution.controller.signal
    });
  }

  private completeStreamingAssistantMessagesForRun(run: Run): void {
    for (const message of this.listAssistantMessagesForRun(run.id)) {
      if (message.status !== "streaming") {
        continue;
      }
      new RunWriter({
        store: this.store,
        eventBus: this.eventBus,
        run: this.store.getRun(run.id) ?? run,
        assistantMessageId: message.id
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
      .filter((message) => message.runId === runId && message.role === "assistant")
      .sort(compareMessagesForTimeline);
  }

  private buildProviderInputForExistingRun(run: Run): { provider: ProviderAdapter; input: ProviderRunInput } {
    const session = this.getSession(run.sessionId);
    const agent = this.getAgentDefinition(stringField(run.metadata, "agentId") || defaultAgentId);
    const providerProfileId = stringField(run.metadata, "providerProfileId") || run.provider;
    const resolvedProvider = this.providers.resolveRun({ providerProfileId });
    const requestedRunOptions = run.runOptions ?? {};
    const optionPlan = buildRunOptionPlan(resolvedProvider.profile, requestedRunOptions);
    const sourceMessages = this.store.listMessages(run.sessionId).filter((message) => message.runId !== run.id || message.role !== "assistant");
    const contextResult = buildContext({
      session,
      agent,
      messages: sourceMessages,
      providerProfileId: resolvedProvider.profile.id,
      runOptions: optionPlan.runOptions,
      availableTools: this.getAvailableToolsForAgent(agent),
      metadata: { runId: run.id, resumed: true }
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
        requestedRunOptions: optionPlan.requestedRunOptions,
        runOptions: optionPlan.runOptions,
        unsupportedRunOptions: optionPlan.unsupportedRunOptions
      }
    };
  }

  private getAvailableToolsForAgent(agent: AgentDefinition) {
    const toolIds = effectiveAgentToolIds(agent);
    const tools = this.tools.list().filter((tool) => toolIds.includes(tool.id));
    return tools.flatMap((tool) => {
      const modelTool = toModelToolDefinition(tool);
      return modelTool ? [modelTool] : [];
    });
  }

  private emit(run: Run, type: RunEventType, payload: unknown): RunEvent {
    const event = this.store.appendEvent({
      id: randomUUID(),
      runId: run.id,
      sessionId: run.sessionId,
      type,
      createdAt: new Date().toISOString(),
      payload
    });
    this.eventBus.publish(event);
    return event;
  }
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
  return a.createdAt.localeCompare(b.createdAt) || a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id);
}

function timestampAfter(...timestamps: Array<string | null | undefined>): string {
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
  return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
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
  if (typeof options.temperature === "number" && Number.isFinite(options.temperature)) {
    output.temperature = options.temperature;
  }
  return Object.keys(output).length > 0 ? output : null;
}

function sanitizedPublicString(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const redacted = value
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
    .replace(/("(?:access|refresh|id)_?token"\s*:\s*")[^"]+("|$)/gi, "$1[REDACTED]$2")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]");
  const sanitized = redacted.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
  return sanitized || null;
}

async function settleWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (promises.length === 0) {
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.allSettled(promises).then(() => undefined),
      new Promise<void>((resolvePromise) => {
        timeout = setTimeout(resolvePromise, Math.max(0, timeoutMs));
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
