import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { buildContext, defaultAgentId } from "./context-builder";
import type { RunEventBus, RunEventListener } from "./event-bus";
import { RunWriter } from "./run-writer";
import type { ProviderAdapter, ProviderMessage, ProviderRunInput } from "../providers/types";
import type { ProviderRegistry } from "../providers/registry";
import type { StoreAdapter, StoredPermissionRequest, UpdateAgentDefinitionInput } from "../store/types";
import { normalizeShellToolSettings, normalizeToolSettings, toolSettingsSettingKey } from "../shared/tool-settings";
import { evaluateToolPermission, type ToolPermissionEvaluation } from "../tools/permission-policy";
import type { ToolRegistry } from "../tools/registry";
import { ToolInputError, type RegisteredTool } from "../tools/types";
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
  ProviderProfile,
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
  ToolPermissionDecision,
  ToolSettings,
  ToolResultStatus
} from "../shared/types";

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

interface RunOptionPlan {
  requestedRunOptions: RunOptions;
  runOptions: RunOptions;
  unsupportedRunOptions: string[];
}

interface PreparedToolInvocation {
  registeredTool: RegisteredTool;
  executionInput: JsonObject;
  publicInput: JsonObject;
  caller: ToolInvocationCaller;
  permission: ToolPermissionEvaluation;
  run: Run;
  assistantMessage: Message;
  invocation: ToolInvocation;
  writer: RunWriter;
  toolCallPart: MessagePart;
  commandOutputPart: MessagePart;
  createdAt: string;
}

const defaultCommandOutputMaxChars = 128_000;

export class KernelError extends Error {
  constructor(message: string, readonly statusCode = 500) {
    super(message);
    this.name = "KernelError";
  }
}

export interface KernelOptions {
  store: StoreAdapter;
  providers: ProviderRegistry;
  eventBus: RunEventBus;
  tools: ToolRegistry;
  /** Default tool execution cwd. Current runtime default is the user's home directory. */
  toolExecutionCwd?: string;
  /** Deprecated compatibility alias for toolExecutionCwd. */
  workspaceRoot?: string;
}

export class Kernel {
  private readonly store: StoreAdapter;
  private readonly providers: ProviderRegistry;
  private readonly eventBus: RunEventBus;
  private readonly tools: ToolRegistry;
  private readonly toolExecutionCwd: string;
  private readonly controllers = new Map<string, AbortController>();

  constructor(options: KernelOptions) {
    this.store = options.store;
    this.providers = options.providers;
    this.eventBus = options.eventBus;
    this.tools = options.tools;
    this.toolExecutionCwd = resolve(options.toolExecutionCwd ?? options.workspaceRoot ?? homedir());
  }

  listSessions(): Session[] {
    return this.store.listSessions();
  }

  createSession(title?: string): Session {
    const now = new Date().toISOString();
    return this.store.createSession({
      id: randomUUID(),
      title: title?.trim() || "New session",
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

  listMessages(sessionId: string): Message[] {
    this.getSession(sessionId);
    return this.store.listMessages(sessionId);
  }

  listTools(): ToolDefinition[] {
    return this.tools.list();
  }

  async invokeTool(sessionId: string, toolId: string, input: JsonObject, options: InvokeToolOptions = {}): Promise<InvokeToolResponse> {
    const prepared = this.prepareToolInvocation(sessionId, toolId, input, options);
    if (prepared.permission.decision === "allowed") {
      return this.executePreparedToolInvocation(prepared, { state: "executed" });
    }
    if (prepared.permission.decision === "requires_approval") {
      return this.createPendingPermissionResponse(prepared);
    }
    return this.denyPreparedToolInvocation(prepared, null);
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
      runOptions: optionPlan.runOptions
    });

    return {
      ...contextResult,
      providerResolution,
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

  startRun(sessionId: string, text: string, options: StartRunOptions = {}): CreateRunResponse {
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
    const run = this.store.createRun({
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
      providerResolution,
      agent: agentToJson(agent),
      requestedRunOptions: optionPlan.requestedRunOptions,
      runOptions: optionPlan.runOptions,
      unsupportedRunOptions: optionPlan.unsupportedRunOptions,
      context: contextSummaryToJson(contextResult.context, contextResult.warnings, contextResult.skippedMessageIds),
      model: optionPlan.runOptions.model ?? null
    });
    this.emit(run, "user_message_created", { message: userMessageWithParts });
    this.emit(run, "assistant_message_created", { message: assistantMessageWithParts });

    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const writer = new RunWriter({
      store: this.store,
      eventBus: this.eventBus,
      run: runWithMetadata,
      assistantMessageId: assistantMessage.id
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
      void this.executeRun(runWithMetadata, resolvedProvider.adapter, providerInput, controller, writer);
    });

    return {
      run: runWithMetadata,
      agentId: agent.id,
      agentName: agent.name,
      provider: resolvedProvider.adapter.id,
      providerProfileId: resolvedProvider.profile.id,
      providerResolution,
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
    if (run.status !== "running") {
      return run;
    }

    const controller = this.controllers.get(runId);
    if (controller) {
      controller.abort();
      return run;
    }

    const assistantMessage = this.store.getAssistantMessageForRun(runId);
    if (!assistantMessage) {
      throw new KernelError("Assistant message for run not found", 404);
    }

    const writer = new RunWriter({
      store: this.store,
      eventBus: this.eventBus,
      run,
      assistantMessageId: assistantMessage.id
    });
    writer.cancel();
    return this.getRun(runId);
  }

  listRunEvents(runId: string): RunEvent[] {
    this.getRun(runId);
    return this.store.listEvents(runId);
  }

  subscribeRunEvents(runId: string, listener: RunEventListener): () => void {
    this.getRun(runId);
    return this.eventBus.subscribe(runId, listener);
  }

  listPermissionRequests(status?: PermissionRequestStatus): PermissionRequest[] {
    return this.store.listPermissionRequests(status ? { status } : {}).map(toPublicPermissionRequest);
  }

  async approvePermissionRequest(id: string): Promise<InvokeToolResponse> {
    const request = this.getResolvablePermissionRequest(id);
    const run = this.getRun(request.runId);
    if (run.status !== "running") {
      throw new KernelError("Permission request can only be approved while its tool run is still running.", 409);
    }

    const resolvedAt = new Date().toISOString();
    const approvedRequest = this.store.resolvePermissionRequest(request.id, "approved", resolvedAt)!;
    this.emit(run, "permission.approved", {
      requestId: approvedRequest.id,
      status: "approved",
      reason: approvedRequest.reason,
      riskLevel: approvedRequest.riskLevel,
      request: toPublicPermissionRequest(approvedRequest)
    });

    return this.executePreparedToolInvocation(this.prepareToolInvocationFromPermission(approvedRequest), {
      state: "executed",
      permissionRequest: toPublicPermissionRequest(approvedRequest)
    });
  }

  denyPermissionRequest(id: string): InvokeToolResponse {
    const request = this.getResolvablePermissionRequest(id);
    const run = this.getRun(request.runId);
    if (run.status !== "running") {
      throw new KernelError("Permission request can only be denied while its tool run is still running.", 409);
    }

    const resolvedAt = new Date().toISOString();
    const deniedRequest = this.store.resolvePermissionRequest(request.id, "denied", resolvedAt)!;
    this.emit(run, "permission.denied", {
      requestId: deniedRequest.id,
      status: "denied",
      reason: deniedRequest.reason,
      riskLevel: deniedRequest.riskLevel,
      request: toPublicPermissionRequest(deniedRequest)
    });

    return this.denyPreparedToolInvocation(this.prepareToolInvocationFromPermission(deniedRequest), deniedRequest);
  }

  private prepareToolInvocation(sessionId: string, toolId: string, input: JsonObject, options: InvokeToolOptions): PreparedToolInvocation {
    const session = this.getSession(sessionId);
    const registeredTool = this.tools.get(toolId.trim());
    if (!registeredTool) {
      throw new KernelError("Tool not found", 404);
    }

    const toolSettings = this.getToolSettings();
    const executionCwd = this.getToolExecutionCwd(session);
    const validationContext = { cwd: executionCwd, workspaceRoot: executionCwd };
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
    const run = this.store.createRun({
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
      riskLevel: permission.riskLevel,
      invocation
    });
    this.emit(run, "assistant_message_created", { message: this.store.getMessage(assistantMessage.id)! });

    const writer = new RunWriter({
      store: this.store,
      eventBus: this.eventBus,
      run,
      assistantMessageId: assistantMessage.id
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
      caller,
      permission,
      run,
      assistantMessage,
      invocation,
      writer,
      toolCallPart,
      commandOutputPart,
      createdAt: now
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

    const permission = permissionEvaluationFromRequest(request, this.getToolExecutionCwd(this.getSession(request.sessionId)));
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

    return {
      registeredTool,
      executionInput: request.executionInput,
      publicInput: request.publicInput,
      caller: request.caller,
      permission,
      run,
      assistantMessage,
      invocation,
      writer: new RunWriter({ store: this.store, eventBus: this.eventBus, run, assistantMessageId: assistantMessage.id }),
      toolCallPart,
      commandOutputPart,
      createdAt: request.createdAt
    };
  }

  private createPendingPermissionResponse(prepared: PreparedToolInvocation): InvokeToolResponse {
    const now = new Date().toISOString();
    const executionCwd = this.getToolExecutionCwd(this.getSession(prepared.invocation.sessionId));
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
        policy: permissionPolicySummary(prepared.permission)
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

    return {
      state: "pending_permission",
      invocation: { ...prepared.invocation, status: "pending_permission", updatedAt: now },
      permissionRequest: toPublicPermissionRequest(permissionRequest),
      run: this.store.getRun(prepared.run.id)!,
      message: this.store.getMessage(prepared.assistantMessage.id)!,
      toolCallPartId: toolCallPart.id,
      commandOutputPartId: prepared.commandOutputPart.id
    };
  }

  private async executePreparedToolInvocation(
    prepared: PreparedToolInvocation,
    responseOptions: { state: "executed"; permissionRequest?: PermissionRequest }
  ): Promise<InvokeToolResponse> {
    const { registeredTool, executionInput, caller, permission, run, assistantMessage, invocation, writer } = prepared;
    const executionCwd = this.getToolExecutionCwd(this.getSession(invocation.sessionId));
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
        workspaceRoot: executionCwd,
        signal: new AbortController().signal,
        emit: onToolEvent
      });
      const completedAt = new Date().toISOString();
      result = buildToolExecutionResult(invocation, registeredTool.definition.id, output, startedAt, completedAt);
    } catch (error) {
      const completedAt = new Date().toISOString();
      const toolError = toError(error);
      result = {
        invocationId: invocation.id,
        toolId: registeredTool.definition.id,
        status: "failed",
        output: {},
        error: toolError.message,
        startedAt,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        metadata: {
          failedBeforeResult: true
        }
      };
    }

    const completedAt = result.completedAt;
    const finalInvocation: ToolInvocation = { ...invocation, status: result.status, updatedAt: completedAt };
    commandOutputPart = this.updateCommandOutputPart(commandOutputPart, commandOutputText, completedAt, commandOutputMetadataFromResult(result, commandOutputTruncated));
    toolCallPart = this.updateToolCallStatus(toolCallPart, result.status, completedAt);
    this.emit(run, result.status === "completed" ? "tool.completed" : "tool.failed", {
      messageId: assistantMessage.id,
      partId: toolCallPart.id,
      part: toolCallPart,
      outputPartId: commandOutputPart.id,
      outputPart: commandOutputPart,
      callId: invocation.id,
      toolId: registeredTool.definition.id,
      toolName: registeredTool.definition.name,
      status: result.status,
      error: result.error,
      durationMs: result.durationMs
    });
    const toolResultPart = writer.recordToolResult({
      callId: invocation.id,
      toolId: registeredTool.definition.id,
      toolName: registeredTool.definition.name,
      status: result.status,
      outputSummary: summarizeToolResult(result),
      error: result.error ?? undefined,
      metadata: {
        durationMs: result.durationMs,
        permissionDecision: permission.decision,
        permissionAction: permission.action,
        permissionRuleId: permission.ruleId,
        riskLevel: permission.riskLevel,
        ...(result.metadata ?? {})
      }
    });

    if (result.status === "completed") {
      writer.complete();
    } else if (result.status === "cancelled") {
      writer.cancel();
    } else {
      writer.fail(new Error(result.error ?? "Tool execution failed."));
    }

    return {
      state: responseOptions.state,
      invocation: finalInvocation,
      result,
      permissionRequest: responseOptions.permissionRequest,
      run: this.store.getRun(run.id)!,
      message: this.store.getMessage(assistantMessage.id)!,
      toolCallPartId: toolCallPart.id,
      commandOutputPartId: commandOutputPart.id,
      toolResultPartId: toolResultPart.id
    };
  }

  private denyPreparedToolInvocation(prepared: PreparedToolInvocation, request: StoredPermissionRequest | null): InvokeToolResponse {
    const now = new Date().toISOString();
    const executionCwd = this.getToolExecutionCwd(this.getSession(prepared.invocation.sessionId));
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
        policy: permissionPolicySummary(prepared.permission)
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
        permissionRequestId: permissionRequest.id
      }
    });
    prepared.writer.fail(new Error(result.error ?? "Tool execution denied by permission policy."));

    return {
      state: "denied",
      invocation: { ...prepared.invocation, status: result.status, updatedAt: completedAt },
      result,
      permissionRequest: toPublicPermissionRequest(permissionRequest),
      run: this.store.getRun(prepared.run.id)!,
      message: this.store.getMessage(prepared.assistantMessage.id)!,
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

  private getToolSettings(): ToolSettings {
    return normalizeToolSettings(this.store.listSettings()[toolSettingsSettingKey]);
  }

  private getToolExecutionCwd(_session: Session): string {
    return this.toolExecutionCwd;
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
    controller: AbortController,
    writer: RunWriter
  ): Promise<void> {
    try {
      await provider.run(input, {
        signal: controller.signal,
        writer
      });

      if (controller.signal.aborted) {
        writer.cancel();
      } else {
        writer.complete();
      }
    } catch (error) {
      if (controller.signal.aborted || isAbortLike(error)) {
        writer.cancel();
      } else {
        const runError = toError(error);
        console.error("Provider run failed", {
          runId: run.id,
          provider: provider.id,
          error: runError.message
        });
        writer.fail(runError);
      }
    } finally {
      this.controllers.delete(run.id);
    }
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

function buildToolRunMetadata(
  tool: ToolDefinition,
  input: JsonObject,
  caller: ToolInvocationCaller,
  permission: ToolPermissionEvaluation,
  executionCwd: string
): JsonObject {
  return {
    kind: "tool_invocation",
    toolId: tool.id,
    toolName: tool.name,
    toolSource: tool.source,
    caller,
    permissionDecision: permission.decision,
    permissionAction: permission.action,
    permissionRuleId: permission.ruleId,
    permissionRiskLevel: permission.riskLevel,
    permissionReason: permission.reason,
    input,
    executionCwd,
    permissionPolicy: permissionPolicySummary(permission)
  };
}

function buildToolMessageMetadata(
  tool: ToolDefinition,
  input: JsonObject,
  caller: ToolInvocationCaller,
  permission: ToolPermissionEvaluation
): JsonObject {
  return {
    kind: "tool_invocation",
    toolId: tool.id,
    toolName: tool.name,
    toolSource: tool.source,
    caller,
    permissionDecision: permission.decision,
    permissionAction: permission.action,
    permissionRuleId: permission.ruleId,
    permissionRiskLevel: permission.riskLevel,
    input
  };
}

function commandOutputMaxCharsForTool(toolId: string, settings: ToolSettings): number {
  if (toolId !== "shell.exec") {
    return defaultCommandOutputMaxChars;
  }
  return normalizeShellToolSettings(settings.shell).maxOutputChars * 2;
}

function toolProviderForPart(toolId: string): "shell" | "internal" {
  return toolId === "shell.exec" ? "shell" : "internal";
}

function toPublicPermissionRequest(request: StoredPermissionRequest): PermissionRequest {
  return {
    id: request.id,
    sessionId: request.sessionId,
    runId: request.runId,
    invocationId: request.invocationId,
    toolName: request.toolName,
    toolId: request.toolId,
    inputSummary: request.inputSummary,
    input: request.publicInput,
    riskLevel: request.riskLevel,
    reason: request.reason,
    status: request.status,
    createdAt: request.createdAt,
    resolvedAt: request.resolvedAt
  };
}

function permissionEvaluationFromRequest(request: StoredPermissionRequest, executionCwd: string): ToolPermissionEvaluation {
  const action = request.permissionDecision === "allowed" ? "allow" : request.permissionDecision === "denied" ? "deny" : "ask";
  const ruleId = stringField(request.metadata, "permissionRuleId") || "permission.request";
  return {
    action,
    decision: request.permissionDecision,
    riskLevel: request.riskLevel,
    reason: request.reason,
    ruleId,
    policy: {
      id: "user.tool-settings",
      version: 1,
      experimental: true,
      defaultAction: action,
      executionCwd,
      shell: {
        defaultAction: action,
        rules: []
      }
    }
  };
}

function permissionPolicySummary(permission: ToolPermissionEvaluation): JsonObject {
  return {
    id: permission.policy.id,
    version: permission.policy.version,
    experimental: permission.policy.experimental,
    executionCwd: permission.policy.executionCwd,
    defaultAction: permission.policy.shell.defaultAction,
    ruleId: permission.ruleId,
    action: permission.action,
    riskLevel: permission.riskLevel,
    ...(permission.matchedPattern
      ? {
          matchedPattern: {
            field: permission.matchedPattern.field,
            lineNumber: permission.matchedPattern.lineNumber,
            pattern: permission.matchedPattern.pattern,
            action: permission.matchedPattern.action
          }
        }
      : {})
  };
}

function summarizeToolInput(toolId: string, input: JsonObject): string {
  if (toolId === "shell.exec") {
    const command = stringField(input, "command");
    const cwd = stringField(input, "cwd");
    const timeoutMs = numberField(input, "timeoutMs");
    return [command ? `$ ${command}` : "shell.exec", cwd ? `cwd: ${cwd}` : "", timeoutMs !== null ? `timeout: ${timeoutMs}ms` : ""]
      .filter(Boolean)
      .join("\n");
  }
  return `Tool call: ${toolId}`;
}

function buildPermissionBlockedResult(
  invocation: ToolInvocation,
  toolId: string,
  permissionDecision: ToolPermissionDecision,
  reason: string,
  startedAt: string,
  completedAt: string
): ToolExecutionResult {
  return {
    invocationId: invocation.id,
    toolId,
    status: "failed",
    output: {},
    error:
      permissionDecision === "requires_approval"
        ? `Tool execution requires approval: ${reason}`
        : `Tool execution denied by permission policy: ${reason}`,
    startedAt,
    completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    metadata: { permissionDecision, reason }
  };
}

function buildToolExecutionResult(
  invocation: ToolInvocation,
  toolId: string,
  output: JsonObject,
  startedAt: string,
  completedAt: string
): ToolExecutionResult {
  const status = inferToolResultStatus(output);
  const durationMs = numberField(output, "durationMs") ?? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
  return {
    invocationId: invocation.id,
    toolId,
    status,
    output,
    error: inferToolResultError(output, status),
    startedAt,
    completedAt,
    durationMs,
    metadata: {
      exitCode: nullableNumberField(output, "exitCode"),
      timedOut: booleanField(output, "timedOut"),
      stdoutTruncated: booleanField(output, "stdoutTruncated"),
      stderrTruncated: booleanField(output, "stderrTruncated")
    }
  };
}

function inferToolResultStatus(output: JsonObject): ToolResultStatus {
  const timedOut = booleanField(output, "timedOut") === true;
  if (timedOut) {
    return "failed";
  }
  if (Object.prototype.hasOwnProperty.call(output, "exitCode")) {
    return numberField(output, "exitCode") === 0 ? "completed" : "failed";
  }
  return "completed";
}

function inferToolResultError(output: JsonObject, status: ToolResultStatus): string | null {
  if (status === "completed") {
    return null;
  }
  const timeoutMs = numberField(output, "durationMs");
  if (booleanField(output, "timedOut") === true) {
    return `Command timed out${timeoutMs !== null ? ` after ${timeoutMs}ms` : ""}.`;
  }
  const exitCode = nullableNumberField(output, "exitCode");
  if (exitCode !== null) {
    return `Command exited with code ${exitCode}.`;
  }
  if (Object.prototype.hasOwnProperty.call(output, "exitCode")) {
    return "Command ended without an exit code.";
  }
  return "Tool execution failed.";
}

function commandOutputMetadataFromResult(result: ToolExecutionResult, commandOutputTruncated: boolean): JsonObject {
  const metadata: JsonObject = {
    durationMs: result.durationMs,
    truncated: commandOutputTruncated,
    status: result.status
  };
  const exitCode = nullableNumberField(result.output, "exitCode");
  if (exitCode !== null) {
    metadata.exitCode = exitCode;
  }
  const cwd = stringField(result.output, "cwd");
  if (cwd) {
    metadata.cwd = cwd;
  }
  const timedOut = booleanField(result.output, "timedOut");
  if (timedOut !== null) {
    metadata.timedOut = timedOut;
  }
  const stdoutTruncated = booleanField(result.output, "stdoutTruncated");
  if (stdoutTruncated !== null) {
    metadata.stdoutTruncated = stdoutTruncated;
    metadata.truncated = commandOutputTruncated || stdoutTruncated === true;
  }
  const stderrTruncated = booleanField(result.output, "stderrTruncated");
  if (stderrTruncated !== null) {
    metadata.stderrTruncated = stderrTruncated;
    metadata.truncated = commandOutputTruncated || stdoutTruncated === true || stderrTruncated === true;
  }
  return metadata;
}

function summarizeToolResult(result: ToolExecutionResult): string {
  const exitCode = nullableNumberField(result.output, "exitCode");
  const parts = [
    result.status,
    exitCode !== null ? `exit ${exitCode}` : "",
    `${result.durationMs}ms`,
    booleanField(result.output, "timedOut") === true ? "timed out" : "",
    booleanField(result.output, "stdoutTruncated") === true || booleanField(result.output, "stderrTruncated") === true ? "output truncated" : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function appendLimitedText(
  current: string,
  truncated: boolean,
  delta: string,
  maxChars: number,
  label: string
): { text: string; truncated: boolean } {
  if (truncated || delta.length === 0) {
    return { text: current, truncated };
  }
  const remaining = maxChars - current.length;
  if (delta.length <= remaining) {
    return { text: current + delta, truncated: false };
  }
  const marker = `\n[${label} truncated after ${maxChars} characters]\n`;
  const sliceLength = Math.max(0, remaining - marker.length);
  return {
    text: `${current}${delta.slice(0, sliceLength)}${marker.slice(0, remaining - sliceLength)}`,
    truncated: true
  };
}

function stringField(object: JsonObject, key: string): string {
  const value = object[key];
  return typeof value === "string" ? value : "";
}

function partString(part: MessagePart, key: string): string {
  const value = part.content[key];
  return typeof value === "string" ? value : "";
}

function numberField(object: JsonObject, key: string): number | null {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableNumberField(object: JsonObject, key: string): number | null {
  return object[key] === null ? null : numberField(object, key);
}

function booleanField(object: JsonObject, key: string): boolean | null {
  const value = object[key];
  return typeof value === "boolean" ? value : null;
}

function buildRunOptionPlan(profile: ProviderProfile, requested: RunOptions): RunOptionPlan {
  const requestedRunOptions = cleanRunOptions(requested);
  const runOptions: RunOptions = {};
  const unsupportedRunOptions: string[] = [];
  const defaultModel = profile.defaultRunOptions?.model?.trim() || profile.model?.trim();

  if (profile.type === "openai-compatible") {
    const model = requestedRunOptions.model ?? defaultModel;
    if (model) {
      runOptions.model = model;
    }
    if (requestedRunOptions.temperature !== undefined) {
      runOptions.temperature = requestedRunOptions.temperature;
    }
    if (requestedRunOptions.reasoningEffort) {
      unsupportedRunOptions.push("reasoningEffort");
    }
    return { requestedRunOptions, runOptions, unsupportedRunOptions };
  }

  if (profile.type === "openai-chatgpt") {
    const model = requestedRunOptions.model ?? defaultModel;
    if (model) {
      runOptions.model = model;
    }
    if (requestedRunOptions.temperature !== undefined) {
      unsupportedRunOptions.push("temperature");
    }
    if (requestedRunOptions.reasoningEffort) {
      unsupportedRunOptions.push("reasoningEffort");
    }
    return { requestedRunOptions, runOptions, unsupportedRunOptions };
  }

  if (requestedRunOptions.model) {
    unsupportedRunOptions.push("model");
  }
  if (requestedRunOptions.temperature !== undefined) {
    unsupportedRunOptions.push("temperature");
  }
  if (requestedRunOptions.reasoningEffort) {
    unsupportedRunOptions.push("reasoningEffort");
  }
  return { requestedRunOptions, runOptions, unsupportedRunOptions };
}

function mergeRunOptions(agentDefaults: RunOptions | null | undefined, runOptions: RunOptions | null | undefined): RunOptions {
  return cleanRunOptions({ ...(agentDefaults ?? {}), ...(runOptions ?? {}) });
}

function cleanRunOptions(options: RunOptions): RunOptions {
  const output: RunOptions = {};
  const model = options.model?.trim();
  if (model) {
    output.model = model;
  }
  if (options.reasoningEffort) {
    output.reasoningEffort = options.reasoningEffort;
  }
  if (typeof options.temperature === "number" && Number.isFinite(options.temperature)) {
    output.temperature = options.temperature;
  }
  return output;
}

function buildRunMetadata(
  providerResolution: ProviderResolution,
  optionPlan: RunOptionPlan,
  agent: AgentDefinition,
  userRunOptions: RunOptions
): JsonObject {
  const metadata: JsonObject = {
    agentId: agent.id,
    agentName: agent.name,
    agent: agentToJson(agent),
    providerProfileId: providerResolution.providerProfileId,
    providerProfileName: providerResolution.providerProfileName,
    providerType: providerResolution.providerType,
    requestedProvider: providerResolution.requestedProvider,
    requestedProviderProfileId: providerResolution.requestedProviderProfileId,
    providerResolution: providerResolutionToJson(providerResolution),
    runOptions: runOptionsToJson(optionPlan.runOptions),
    agentDefaultRunOptions: runOptionsToJson(agent.defaultRunOptions ?? {}),
    userRunOptions: runOptionsToJson(userRunOptions),
    requestedRunOptions: runOptionsToJson(optionPlan.requestedRunOptions),
    unsupportedRunOptions: optionPlan.unsupportedRunOptions
  };

  if (providerResolution.model) {
    metadata.model = providerResolution.model;
  }
  if (optionPlan.unsupportedRunOptions.length > 0) {
    metadata.optionSupportNote = "Unsupported run options are recorded as metadata only and are not sent to the provider.";
  }
  return metadata;
}

function providerResolutionToJson(resolution: ProviderResolution): JsonObject {
  const output: JsonObject = {
    requestedProvider: resolution.requestedProvider,
    requestedProviderProfileId: resolution.requestedProviderProfileId,
    providerProfileId: resolution.providerProfileId,
    providerProfileName: resolution.providerProfileName,
    providerType: resolution.providerType,
    fallback: resolution.fallback ? fallbackToJson(resolution.fallback) : null
  };
  if (resolution.model) {
    output.model = resolution.model;
  }
  if (resolution.baseUrl) {
    output.baseUrl = resolution.baseUrl;
  }
  if (resolution.credentialRef) {
    output.credentialRef = resolution.credentialRef;
  }
  return output;
}

function fallbackToJson(fallback: NonNullable<ProviderResolution["fallback"]>): JsonObject {
  return {
    fromProviderProfileId: fallback.fromProviderProfileId,
    toProviderProfileId: fallback.toProviderProfileId,
    reason: fallback.reason,
    message: fallback.message
  };
}

function runOptionsToJson(options: RunOptions): JsonObject {
  const output: JsonObject = {};
  if (options.model) {
    output.model = options.model;
  }
  if (options.reasoningEffort) {
    output.reasoningEffort = options.reasoningEffort;
  }
  if (typeof options.temperature === "number" && Number.isFinite(options.temperature)) {
    output.temperature = options.temperature;
  }
  return output;
}

function buildContextRunMetadata(context: BuiltContext, warnings: string[], skippedMessageIds: string[]): JsonObject {
  const metadata: JsonObject = {
    contextSnapshot: builtContextToJson(context),
    contextBuilder: contextSummaryToJson(context, warnings, skippedMessageIds)
  };
  if (warnings.length > 0) {
    metadata.contextWarnings = warnings;
  }
  if (skippedMessageIds.length > 0) {
    metadata.skippedContextMessageIds = skippedMessageIds;
  }
  return metadata;
}

function contextSummaryToJson(context: BuiltContext, warnings: string[], skippedMessageIds: string[]): JsonObject {
  return {
    kind: "provider-neutral-context",
    agentId: context.agent.id,
    agentName: context.agent.name,
    providerProfileId: context.providerProfileId ?? null,
    systemPromptLength: context.systemPrompt.length,
    messageCount: context.messages.length,
    runOptions: runOptionsToJson(context.runOptions),
    warningCount: warnings.length,
    skippedMessageIds
  };
}

function builtContextToJson(context: BuiltContext): JsonObject {
  const output: JsonObject = {
    agent: agentToJson(context.agent),
    systemPrompt: context.systemPrompt,
    messages: context.messages.map((message) => contextMessageToJson(message)),
    runOptions: runOptionsToJson(context.runOptions),
    metadata: context.metadata
  };
  if (context.providerProfileId) {
    output.providerProfileId = context.providerProfileId;
  }
  if (context.skillIds) {
    output.skillIds = context.skillIds;
  }
  if (context.toolIds) {
    output.toolIds = context.toolIds;
  }
  return output;
}

function contextMessageToJson(message: BuiltContext["messages"][number]): JsonObject {
  const output: JsonObject = {
    role: message.role,
    content: message.content
  };
  if (message.source) {
    output.source = message.source;
  }
  if (message.messageId) {
    output.messageId = message.messageId;
  }
  if (message.parts) {
    output.parts = message.parts.map((part) => {
      const partOutput: JsonObject = {
        type: part.type,
        text: part.text
      };
      if (part.sourcePartId) {
        partOutput.sourcePartId = part.sourcePartId;
      }
      if (part.metadata) {
        partOutput.metadata = part.metadata;
      }
      return partOutput;
    });
  }
  if (message.metadata) {
    output.metadata = message.metadata;
  }
  return output;
}

function agentToJson(agent: AgentDefinition): JsonObject {
  const output: JsonObject = {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    modelProfileId: agent.modelProfileId,
    defaultRunOptions: runOptionsToJson(agent.defaultRunOptions ?? {}),
    skillIds: agent.skillIds,
    toolIds: agent.toolIds,
    metadata: agent.metadata,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  };
  return output;
}

function toProviderMessages(context: BuiltContext): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  const systemPrompt = context.systemPrompt.trim();
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  for (const message of context.messages) {
    const content = message.content.trim();
    if (!content) {
      continue;
    }
    messages.push({ role: message.role, content });
  }
  return messages;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
