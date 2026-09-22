export type ISODateString = string;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;

export type MessageRole = "system" | "user" | "assistant";
export type MessagePartType =
  | "text"
  | "error"
  | "reasoning_summary"
  | "reasoning_detail"
  | "tool_call"
  | "tool_result"
  | "command_output"
  | "file_ref";
export type MessageStatus = "completed" | "streaming" | "cancelled" | "failed" | "interrupted";
export type RunStatus = "running" | "waiting_permission" | "cancelling" | "completed" | "cancelled" | "failed" | "interrupted";
export type ActiveRunStatus = Extract<RunStatus, "running" | "waiting_permission" | "cancelling">;
export type TerminalRunStatus = Extract<RunStatus, "completed" | "cancelled" | "failed" | "interrupted">;

export const ACTIVE_RUN_STATUSES: readonly ActiveRunStatus[] = ["running", "waiting_permission", "cancelling"];
export const TERMINAL_RUN_STATUSES: readonly TerminalRunStatus[] = ["completed", "cancelled", "failed", "interrupted"];

export function isActiveRunStatus(status: RunStatus): status is ActiveRunStatus {
  return (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

export function isTerminalRunStatus(status: RunStatus): status is TerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  if (isTerminalRunStatus(from) || from === to) {
    return false;
  }
  if (from === "running") {
    return to === "waiting_permission" || to === "cancelling" || isTerminalRunStatus(to);
  }
  if (from === "waiting_permission") {
    return to === "running" || to === "cancelling" || to === "failed" || to === "cancelled" || to === "interrupted";
  }
  return from === "cancelling" && (to === "cancelled" || to === "interrupted");
}

/** Provider-defined opaque value, validated at runtime before persistence or use. */
export type ReasoningEffort = string;
export type ProviderProfileType = "openai-compatible" | "openai-chatgpt" | "mock";
export type ProviderProfileSource = "env" | "builtin" | "user";
export type ProviderCredentialStatus = "present" | "missing" | "expired" | "not_required";
export type ProviderStatusState =
  | "available"
  | "configured"
  | "connected"
  | "needs_auth"
  | "expired"
  | "missing_credential"
  | "disabled"
  | "error";
export type ProviderVendor = "openai" | "local";
export type ProviderRuntime = "openai-compatible" | "chatgpt-codex" | "mock";
export type ProviderAuthMode = "env-api-key" | "oauth-device" | "oauth-browser" | "none";
export type ProviderBillingSource = "platform-api" | "consumer-subscription" | "local" | "third-party" | "unknown";
export type RunOptionSupport = "supported" | "metadata-only" | "unsupported" | "provider-reported" | "unknown";
export type ToolSource = "builtin" | "custom" | "mcp";
export type ToolInvocationCaller = "manual" | "model" | "system";
export type ToolInvocationStatus = "created" | "pending_permission" | "running" | "completed" | "failed" | "cancelled";
export type ToolResultStatus = "completed" | "failed" | "cancelled";
export type ToolPermissionDecision = "allowed" | "requires_approval" | "denied";
export type PermissionRequestStatus = "pending" | "approved" | "denied" | "expired";
export type PermissionRiskLevel = "low" | "medium" | "high" | "critical";
export type PermissionPolicyAction = "allow" | "ask" | "deny";
export type ToolSettingsPatternField = "denyPatternsText" | "askPatternsText" | "allowPatternsText";

export interface ShellToolSettings {
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputChars?: number;
}

export type ToolSettingsShellField = "shell" | "shell.defaultTimeoutMs" | "shell.maxTimeoutMs" | "shell.maxOutputChars";
export type ToolSettingsValidationField = "defaultAction" | ToolSettingsPatternField | ToolSettingsShellField;

export interface ToolSettings {
  defaultAction: PermissionPolicyAction;
  denyPatternsText: string;
  askPatternsText: string;
  allowPatternsText: string;
  shell: ShellToolSettings;
}

export interface RunOptions {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  temperature?: number;
}

export type ContextWindowSource = "provider" | "adapter" | "user" | "assumed";

export interface ModelContextCapability {
  windowTokens: number;
  source: ContextWindowSource;
  /** True when a last-good provider catalog value outlived its normal TTL. */
  stale?: boolean;
}

export interface ProviderContextPlanningProfile {
  requiredInstructions: Array<{ id: string; content: string }>;
  fixedWrapperTokens: number;
  perMessageTokens: number;
  toolEnvelopeTokens: number;
}

export interface AgentContextPolicy {
  contextWindowTokensOverride?: number;
  reservedOutputTokens?: number;
  safetyMarginRatio?: number;
  automaticCompaction?: boolean;
}

export interface AgentDefinition {
  id: string;
  revision: number;
  name: string;
  description: string | null;
  systemPrompt: string;
  modelProfileId: string | null;
  defaultRunOptions: RunOptions | null;
  contextPolicy: AgentContextPolicy | null;
  skillIds: string[];
  toolIds: string[];
  metadata: JsonObject;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface ContextMessage {
  role: MessageRole;
  content: string;
  source?: "session" | "current" | "synthetic" | "compaction";
  messageId?: string;
  parts?: ContextMessagePart[];
  metadata?: JsonObject;
}

export interface ContextMessagePart {
  type: MessagePartType;
  text: string;
  sourcePartId?: string;
  metadata?: JsonObject;
}

export interface BuiltContext {
  agent: AgentDefinition;
  systemPrompt: string;
  workingDirectory: string;
  messages: ContextMessage[];
  availableTools: ModelToolDefinition[];
  runOptions: RunOptions;
  providerProfileId?: string;
  skillIds?: string[];
  toolIds?: string[];
  metadata: JsonObject;
  plan: ContextPlan;
}

export type ContextCandidateKind =
  | "system"
  | "message_turn"
  | "tool_schema"
  | "tool_result"
  | "current_input"
  | "compaction_summary"
  | "skill"
  | "file"
  | "subsession_handoff";

export type ContextCandidateRetention = "required" | "recent" | "compressible" | "discardable";

export interface ContextCandidate {
  kind: ContextCandidateKind;
  sourceIds: string[];
  estimatedTokens: number;
  retention: ContextCandidateRetention;
}

export interface ContextPlanItem extends ContextCandidate {
  reason?: string;
}

export interface ContextPlan {
  windowTokens: number;
  windowSource: ContextWindowSource;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  inputBudgetTokens: number;
  estimatedInputTokens: number;
  providerNeutralTokens: number;
  nativeOverheadTokens: number;
  capabilityStale: boolean;
  historyWatermark: string | null;
  historyThroughMessageId: string | null;
  selectedHistoryFromMessageId: string | null;
  selectedHistoryThroughMessageId: string | null;
  activeSegmentId: string | null;
  inheritedArtifactId: string | null;
  preTrimEstimatedInputTokens: number;
  compactionRecommended: boolean;
  compactionReason: "budget_threshold" | "trimming_applied" | null;
  included: ContextPlanItem[];
  omitted: ContextPlanItem[];
  trimmingApplied: boolean;
  estimatorVersion: string;
}

export interface ContextPlanRecord {
  planId: string;
  providerTurn: number;
  toolIteration: number;
  createdAt: ISODateString;
  plan: ContextPlan;
}

export interface ContextBuildResult {
  context: BuiltContext;
  plan: ContextPlan;
  warnings: string[];
  skippedMessageIds: string[];
}

export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  source: ToolSource;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  metadata: JsonObject;
}

export interface ModelToolDefinition {
  id: string;
  providerName: string;
  name: string;
  description: string;
  inputSchema: JsonObject;
  metadata: JsonObject;
}

export interface PermissionPolicyRule {
  id: string;
  action: PermissionPolicyAction;
  riskLevel: PermissionRiskLevel;
  description: string;
  patterns?: string[];
}

export interface PermissionPolicy {
  id: string;
  version: number;
  experimental: boolean;
  defaultAction: PermissionPolicyAction;
  executionCwd: string;
  shell: {
    defaultAction: PermissionPolicyAction;
    rules: PermissionPolicyRule[];
  };
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  runId?: string;
  invocationId?: string;
  toolName: string;
  toolId?: string;
  inputSummary: string;
  /** Sanitized public input only. Raw command text is kept server-side for approved execution. */
  input?: JsonObject;
  riskLevel: PermissionRiskLevel;
  reason: string;
  status: PermissionRequestStatus;
  createdAt: ISODateString;
  resolvedAt?: ISODateString | null;
}

export interface ToolInvocation {
  id: string;
  toolId: string;
  toolName: string;
  sessionId: string;
  runId: string;
  messageId: string;
  caller: ToolInvocationCaller;
  status: ToolInvocationStatus;
  permissionDecision: ToolPermissionDecision;
  /** Sanitized public input only. Never persist credentials, tokens, or secret env values. */
  input: JsonObject;
  metadata: JsonObject;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface ToolExecutionResult {
  invocationId: string;
  toolId: string;
  status: ToolResultStatus;
  output: JsonObject;
  error: string | null;
  startedAt: ISODateString;
  completedAt: ISODateString;
  durationMs: number;
  metadata: JsonObject;
}

export type PublicToolInvocation = Omit<ToolInvocation, "input" | "metadata">;
export type PublicToolExecutionResult = Omit<ToolExecutionResult, "metadata">;

export interface ProviderRunOptionSupport {
  model: RunOptionSupport;
  reasoningEffort: RunOptionSupport;
  temperature: RunOptionSupport;
  usage: RunOptionSupport;
}

export type ProviderModelCatalogStatus = "available" | "configured-only" | "unavailable";
export type ProviderModelCatalogSource = "provider" | "configured" | "builtin";
export type ProviderModelReasoningSupport = "supported" | "unsupported" | "unknown";

export interface ProviderReasoningEffortOption {
  value: ReasoningEffort;
  description?: string;
}

export interface ProviderModelReasoningCapabilities {
  support: ProviderModelReasoningSupport;
  efforts: ProviderReasoningEffortOption[];
  defaultEffort?: ReasoningEffort;
}

export interface ProviderModelCatalogItem {
  id: string;
  displayName?: string;
  description?: string;
  owner?: string;
  created?: number;
  reasoning: ProviderModelReasoningCapabilities;
  context?: ModelContextCapability;
}

export interface ProviderModelCatalog {
  providerProfileId: string;
  status: ProviderModelCatalogStatus;
  source: ProviderModelCatalogSource;
  stale: boolean;
  fetchedAt: ISODateString;
  warning?: string;
  customModelAllowed: boolean;
  models: ProviderModelCatalogItem[];
}

export interface Session {
  id: string;
  title: string;
  workingDirectory: string;
  agentId: string;
  activeSegmentId: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface CreateSessionRequest {
  title?: string;
  workingDirectory?: string;
  agentId?: string;
}

export interface UpdateSessionRequest {
  workingDirectory?: string;
  agentId?: string;
}

export interface MessagePart {
  id: string;
  messageId: string;
  seq: number;
  type: MessagePartType;
  /**
   * Provider/UI-safe fallback text. Structured parts keep their full public payload in
   * `content`; never store API keys, OAuth tokens, or raw chain-of-thought here.
   */
  text: string;
  content: MessagePartContent;
  metadata: JsonObject;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export type MessagePartContent = JsonObject;
export type TextMessagePartContent = JsonObject & { text: string };
export type ErrorMessagePartContent = JsonObject & {
  message: string;
  code?: string;
  source?: "provider" | "runtime" | "tool" | "system";
  retryable?: boolean;
};
export type ReasoningSummaryMessagePartContent = JsonObject & {
  summary?: string;
  usage?: JsonObject;
};
export type ReasoningDetailMessagePartContent = JsonObject & {
  detail?: string;
  usage?: JsonObject;
};
export type ToolCallMessagePartContent = JsonObject & {
  callId: string;
  toolId: string;
  toolName?: string;
  provider?: "native" | "shell" | "mcp" | "skill" | "subagent" | "internal";
  status?: "created" | "pending" | "pending_permission" | "running" | "completed" | "failed" | "cancelled";
  /** Sanitized public tool input only. Never persist credentials, tokens, or secret env values. */
  input?: JsonObject;
  inputSummary?: string;
};
export type ToolResultMessagePartContent = JsonObject & {
  callId: string;
  toolId?: string;
  toolName?: string;
  status: "completed" | "failed" | "cancelled";
  output?: string;
  outputSummary?: string;
  error?: string;
};
export type CommandOutputMessagePartContent = JsonObject & {
  commandId?: string;
  callId?: string;
  stream?: "stdout" | "stderr" | "combined";
  /** Sanitized display text only; redact secrets before storing command output. */
  text?: string;
  exitCode?: number;
  cwd?: string;
  truncated?: boolean;
};
export type FileRefMessagePartContent = JsonObject & {
  path?: string;
  uri?: string;
  name?: string;
  mimeType?: string;
  lineStart?: number;
  lineEnd?: number;
  sizeBytes?: number;
};

export interface Message {
  id: string;
  sessionId: string;
  runId: string | null;
  segmentId: string;
  role: MessageRole;
  status: MessageStatus;
  error: string | null;
  metadata: JsonObject;
  model: string | null;
  runOptions: RunOptions | null;
  usage: RunUsage | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  parts: MessagePart[];
}

export interface Run {
  id: string;
  sessionId: string;
  provider: string;
  status: RunStatus;
  segmentId: string;
  metadata: JsonObject;
  model: string | null;
  runOptions: RunOptions | null;
  usage: RunUsage | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  error: string | null;
}

export type ContextSegmentStatus = "active" | "sealed";

export interface ContextSegment {
  id: string;
  sessionId: string;
  ordinal: number;
  previousSegmentId: string | null;
  status: ContextSegmentStatus;
  firstMessageId: string | null;
  lastMessageId: string | null;
  inheritedArtifactId: string | null;
  messageCount: number;
  createdAt: ISODateString;
  sealedAt: ISODateString | null;
}

export interface ContextArtifact {
  id: string;
  kind: "compaction";
  sessionId: string;
  sourceSegmentId: string;
  targetSegmentId: string | null;
  previousArtifactId: string | null;
  sourceMessageIds: string[];
  sourceCategories: ContextArtifactSourceCategory[];
  sourceFirstMessageId: string | null;
  sourceLastMessageId: string | null;
  summary: string;
  strategyVersion: string;
  estimatorVersion: string;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  resolvedWindowTokens: number;
  windowSource: ContextWindowSource;
  status: "completed" | "failed";
  providerProfileId: string | null;
  model: string | null;
  usage: RunUsage | null;
  error: string | null;
  createdAt: ISODateString;
}

export interface ContextArtifactSourceCategory {
  category: "completed_turn" | "unsuccessful_turn" | "standalone_tool" | "orphan_record" | "summary_recovery";
  messageIds: string[];
  runId: string | null;
  status: string;
}

export interface ContextSegmentDetail extends ContextSegment {
  artifact: ContextArtifact | null;
  recentFailure: ContextArtifact | null;
}

export interface CompactContextResponse {
  state: "completed" | "failed" | "noop";
  segment: ContextSegment;
  artifact: ContextArtifact | null;
  message?: string;
}

export type PublicRunPhase = "running" | "provider" | "tool" | "compacting_context" | "waiting_permission" | "cancelling";

export interface PublicRunSummary {
  id: string;
  sessionId: string;
  provider: string;
  status: RunStatus;
  model: string | null;
  runOptions: RunOptions | null;
  usage: RunUsage | null;
  currentPhase: PublicRunPhase | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  error: string | null;
  context: {
    planId: string;
    providerTurn: number;
    toolIteration: number;
    inputBudgetTokens: number;
    estimatedInputTokens: number;
    providerNeutralTokens: number;
    nativeOverheadTokens: number;
    trimmingApplied: boolean;
    windowSource: ContextWindowSource;
    capabilityStale: boolean;
  } | null;
}

export const CORE_RUN_EVENT_TYPES = [
  "run_started",
  "user_message_created",
  "assistant_message_created",
  "assistant_message_updated",
  "delta",
  "run_waiting_permission",
  "run_cancelling",
  "run_completed",
  "run_cancelled",
  "run_failed",
  "run_interrupted",
  "context_compaction_started",
  "context_compaction_completed",
  "context_compaction_failed",
  "context_compaction_skipped",
  "segment_rotated"
] as const;

export const TOOL_RUN_EVENT_TYPES = [
  "tool_call.created",
  "tool_call.updated",
  "tool_call.delta",
  "tool.started",
  "tool.stdout.delta",
  "tool.stderr.delta",
  "tool.completed",
  "tool.failed",
  "tool_result.created"
] as const;

export const PERMISSION_RUN_EVENT_TYPES = ["permission.requested", "permission.approved", "permission.denied"] as const;

export const RUN_EVENT_TYPES = [...CORE_RUN_EVENT_TYPES, ...TOOL_RUN_EVENT_TYPES, ...PERMISSION_RUN_EVENT_TYPES] as const;

export type CoreRunEventType = (typeof CORE_RUN_EVENT_TYPES)[number];
export type ToolRunEventType = (typeof TOOL_RUN_EVENT_TYPES)[number];
export type PermissionRunEventType = (typeof PERMISSION_RUN_EVENT_TYPES)[number];
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];
export type TerminalRunEventType = Extract<RunEventType, "run_completed" | "run_cancelled" | "run_failed" | "run_interrupted">;

export function isRunEventType(type: string): type is RunEventType {
  return (RUN_EVENT_TYPES as readonly string[]).includes(type);
}

export function isToolRunEventType(type: string): type is ToolRunEventType {
  return (TOOL_RUN_EVENT_TYPES as readonly string[]).includes(type);
}

export function isPermissionRunEventType(type: string): type is PermissionRunEventType {
  return (PERMISSION_RUN_EVENT_TYPES as readonly string[]).includes(type);
}

export function isTerminalRunEventType(type: string): type is TerminalRunEventType {
  return type === "run_completed" || type === "run_cancelled" || type === "run_failed" || type === "run_interrupted";
}

export type ToolRunEventPayload = JsonObject & {
  messageId?: string;
  partId?: string;
  callId?: string;
  toolId?: string;
  toolName?: string;
  status?: string;
  stream?: "stdout" | "stderr" | "combined";
  text?: string;
  error?: string;
};

export type PermissionRunEventPayload = JsonObject & {
  requestId?: string;
  scope?: string;
  reason?: string;
  status?: "requested" | "approved" | "denied";
};

export interface ToolExecutionEvent<TPayload extends JsonObject = JsonObject> {
  invocationId: string;
  toolId: string;
  type: ToolRunEventType;
  createdAt: ISODateString;
  payload: TPayload;
}

export interface RunEvent<TPayload = unknown> {
  id: string;
  runId: string;
  sessionId: string;
  seq: number;
  type: RunEventType;
  createdAt: ISODateString;
  payload: TPayload;
}

export interface CreateRunRequest {
  text: string;
  agentId?: string;
  provider?: string;
  providerProfileId?: string;
  options?: RunOptions;
  runOptions?: RunOptions;
}

export type ShellExecRequest = JsonObject & {
  command: string;
  cwd?: string;
  timeoutMs?: number;
};

export type ShellExecOutput = JsonObject & {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export interface AgentListResponse {
  agents: AgentDefinition[];
  defaultAgentId: string;
}

export interface CreateAgentDefinitionRequest {
  name: string;
  description?: string | null;
  systemPrompt: string;
  modelProfileId?: string | null;
  defaultRunOptions?: RunOptions | null;
  contextPolicy?: AgentContextPolicy | null;
  skillIds?: string[];
  toolIds?: string[];
  metadata?: JsonObject;
}

export interface AgentDefinitionUsage {
  sessionCount: number;
  sessions: Array<Pick<Session, "id" | "title">>;
}

export interface ToolListResponse {
  tools: ToolDefinition[];
}

export interface ContextPreviewRequest {
  sessionId?: string;
  agentId?: string;
  provider?: string;
  providerProfileId?: string;
  text?: string;
  options?: RunOptions;
  runOptions?: RunOptions;
}

export interface ProviderFallbackInfo {
  fromProviderProfileId: string | null;
  toProviderProfileId: string;
  reason: "missing_credential" | "disabled" | "unavailable" | "unknown_profile";
  message: string;
}

export interface ProviderResolution {
  requestedProvider: string | null;
  requestedProviderProfileId: string | null;
  providerProfileId: string;
  providerProfileName: string;
  providerType: ProviderProfileType;
  model?: string;
  baseUrl?: string;
  credentialRef?: string;
  fallback: ProviderFallbackInfo | null;
}

export type PublicProviderResolution = Omit<ProviderResolution, "baseUrl" | "credentialRef">;

export interface CreateRunResponse {
  run: PublicRunSummary;
  agentId: string;
  agentName: string;
  provider: string;
  providerProfileId: string;
  providerResolution: PublicProviderResolution;
  model: string | null;
  runOptions: RunOptions;
  requestedRunOptions: RunOptions;
  unsupportedRunOptions: string[];
  usage: RunUsage | null;
  assistantMessageId: string;
}

export type InvokeToolResponseState = "running" | "executed" | "pending_permission" | "denied";

export interface InvokeToolResponse {
  state: InvokeToolResponseState;
  invocation: PublicToolInvocation;
  result?: PublicToolExecutionResult;
  permissionRequest?: PermissionRequest;
  run: PublicRunSummary;
  message: Message;
  toolCallPartId: string;
  commandOutputPartId?: string;
  toolResultPartId?: string;
}

export interface PermissionListResponse {
  permissions: PermissionRequest[];
}

export interface ContextPreviewResponse extends ContextBuildResult {
  providerResolution: PublicProviderResolution;
  requestedRunOptions: RunOptions;
  unsupportedRunOptions: string[];
}

export interface DaemonStatus {
  status: "ok";
  version: string;
  pid: number;
  startedAt: ISODateString;
  uptimeSeconds: number;
  mode: string;
  port: number;
  dbPath: string;
}

export interface ProviderStatus {
  state: ProviderStatusState;
  message: string;
  credentialStatus: ProviderCredentialStatus;
  checkedAt?: ISODateString;
  errorCode?: string;
}

export interface ProviderProfile {
  id: string;
  name: string;
  type: ProviderProfileType;
  vendor: ProviderVendor;
  runtime: ProviderRuntime;
  authMode: ProviderAuthMode;
  billingSource: ProviderBillingSource;
  source: ProviderProfileSource;
  enabled: boolean;
  baseUrl?: string;
  endpoint?: string;
  model?: string;
  defaultRunOptions?: RunOptions;
  runOptionSupport?: ProviderRunOptionSupport;
  credentialRef?: string;
  experimental?: boolean;
  status: ProviderStatus;
}

export type ProviderProfileSummary = ProviderProfile;

export interface ProviderListResponse {
  providers: ProviderProfile[];
  defaultProviderProfileId: string;
}

export interface ProviderTestResponse {
  ok: boolean;
  profile: ProviderProfile;
  status: ProviderStatus;
  code?:
    | "missing_credential"
    | "auth_required"
    | "credential_expired"
    | "refresh_failed"
    | "connection_failed"
    | "unsupported_profile"
    | "unknown_profile";
  message: string;
  checkedAt: ISODateString;
  latencyMs?: number;
  details?: JsonObject;
}

export interface OpenAIChatGPTAuthStartResponse {
  providerProfileId: string;
  method: "device";
  attemptId: string;
  verificationUrl: string;
  userCode: string;
  instruction: string;
  intervalSeconds: number;
  expiresAt: ISODateString;
}

export interface OpenAIChatGPTAuthPollResponse {
  providerProfileId: string;
  status: "pending" | "connected" | "expired" | "failed";
  message: string;
  retryAfterMs?: number;
  profile?: ProviderProfile;
}

export interface OpenAIChatGPTLogoutResponse {
  providerProfileId: string;
  ok: boolean;
  profile: ProviderProfile;
}

export interface AdapterRegistryItem {
  id: "opencode" | "claude-code" | "codex" | "gemini-cli";
  name: string;
  status: "planned" | "not-installed" | "installed";
  description: string;
}

export interface AppSettingsResponse {
  settings: JsonObject;
  providerProfiles: ProviderProfileSummary[];
  adapters: AdapterRegistryItem[];
}

export interface ToolSettingsResponse {
  settings: ToolSettings;
}
