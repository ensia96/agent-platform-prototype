import type {
  ActiveRunStatus,
  AgentDefinition,
  JsonObject,
  JsonValue,
  ISODateString,
  Message,
  MessagePart,
  MessagePartType,
  MessageRole,
  MessageStatus,
  PermissionRequest,
  PermissionRequestStatus,
  PermissionRiskLevel,
  Run,
  RunEvent,
  RunEventType,
  RunOptions,
  RunStatus,
  Session,
  TerminalRunEventType,
  TerminalRunStatus,
  ToolInvocationCaller,
  ToolPermissionDecision
} from "../shared/types";

export interface CreateSessionInput {
  id: string;
  title: string;
  workingDirectory: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface CreateRunInput {
  id: string;
  sessionId: string;
  provider: string;
  status: "running";
  createdAt: ISODateString;
  updatedAt: ISODateString;
  error?: string | null;
  metadata?: JsonObject;
}

export class ActiveRunExistsStoreError extends Error {
  constructor(readonly activeRun: Run) {
    super(`Session '${activeRun.sessionId}' already has active run '${activeRun.id}'.`);
    this.name = "ActiveRunExistsStoreError";
  }
}

export interface CreateMessageInput {
  id: string;
  sessionId: string;
  runId?: string | null;
  role: MessageRole;
  status: MessageStatus;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  metadata?: JsonObject;
}

export interface AddMessagePartInput {
  id: string;
  messageId: string;
  seq: number;
  type?: MessagePartType;
  text: string;
  content?: JsonObject;
  metadata?: JsonObject;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface UpsertMessageTextPartInput {
  id: string;
  messageId: string;
  text: string;
  updatedAt: ISODateString;
}

export interface UpdateMessagePartInput {
  id: string;
  text: string;
  content?: JsonObject;
  metadata?: JsonObject;
  updatedAt: ISODateString;
}

export interface AppendEventInput {
  id: string;
  runId: string;
  sessionId: string;
  type: RunEventType;
  createdAt: ISODateString;
  payload: unknown;
}

export interface UpdateAgentDefinitionInput {
  id: string;
  name?: string;
  description?: string | null;
  systemPrompt?: string;
  modelProfileId?: string | null;
  defaultRunOptions?: RunOptions | null;
  skillIds?: string[];
  toolIds?: string[];
  metadata?: JsonObject;
  updatedAt: ISODateString;
}

export interface CreatePermissionRequestInput {
  id: string;
  sessionId: string;
  runId: string;
  messageId: string;
  invocationId: string;
  toolId: string;
  toolName: string;
  caller: ToolInvocationCaller;
  permissionDecision: ToolPermissionDecision;
  inputSummary: string;
  publicInput: JsonObject;
  executionInput: JsonObject;
  riskLevel: PermissionRiskLevel;
  reason: string;
  status: PermissionRequestStatus;
  toolCallPartId: string;
  commandOutputPartId?: string | null;
  metadata?: JsonObject;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  resolvedAt?: ISODateString | null;
}

export interface StoredPermissionRequest extends PermissionRequest {
  runId: string;
  messageId: string;
  invocationId: string;
  toolId: string;
  caller: ToolInvocationCaller;
  permissionDecision: ToolPermissionDecision;
  publicInput: JsonObject;
  executionInput: JsonObject;
  toolCallPartId: string;
  commandOutputPartId: string | null;
  metadata: JsonObject;
  updatedAt: ISODateString;
}

export interface ListPermissionRequestsFilter {
  status?: PermissionRequestStatus;
  sessionId?: string;
}

export interface ListRunsFilter {
  sessionId?: string;
  statuses?: readonly RunStatus[];
}

export interface DaemonLeaseRecord {
  ownerId: string;
  pid: number;
  acquiredAt: ISODateString;
  heartbeatAt: ISODateString;
}

export interface RunCancellationResult {
  run: Run;
  expiredPermissionRequests: StoredPermissionRequest[];
  event: RunEvent | null;
}

export interface RequestRunCancellationInput {
  runId: string;
  updatedAt: ISODateString;
  event: Pick<AppendEventInput, "id" | "payload"> & { type: "run_cancelling" };
}

export interface FinalizeRunInput {
  runId: string;
  expectedStatuses: readonly RunStatus[];
  status: TerminalRunStatus;
  error: string | null;
  updatedAt: ISODateString;
  event: Pick<AppendEventInput, "id" | "payload"> & { type: TerminalRunEventType };
}

export interface FinalizeRunResult {
  run: Run;
  event: RunEvent;
}

export interface StoreAdapter {
  listSessions(): Session[];
  getSession(id: string): Session | null;
  createSession(input: CreateSessionInput): Session;
  updateSessionWorkingDirectory(id: string, workingDirectory: string, updatedAt: ISODateString): Session | null;
  touchSession(id: string, updatedAt: ISODateString): void;

  createRun(input: CreateRunInput): Run;
  getRun(id: string): Run | null;
  listRuns(filter?: ListRunsFilter): Run[];
  transitionRunStatus(
    id: string,
    expectedStatuses: readonly RunStatus[],
    status: ActiveRunStatus,
    error: string | null,
    updatedAt: ISODateString
  ): Run | null;
  requestRunCancellation(input: RequestRunCancellationInput): RunCancellationResult | null;
  finalizeRun(input: FinalizeRunInput): FinalizeRunResult | null;
  expirePendingPermissionsForTerminalRuns(updatedAt: ISODateString): number;
  mergeRunMetadata(id: string, metadata: JsonObject, updatedAt: ISODateString): void;

  listMessages(sessionId: string): Message[];
  getMessage(id: string): Message | null;
  getAssistantMessageForRun(runId: string): Message | null;
  createMessage(input: CreateMessageInput): Message;
  addMessagePart(input: AddMessagePartInput): MessagePart;
  upsertMessageTextPart(input: UpsertMessageTextPartInput): void;
  updateMessagePart(input: UpdateMessagePartInput): MessagePart | null;
  transitionMessageStatus(
    id: string,
    expectedStatuses: readonly MessageStatus[],
    status: MessageStatus,
    updatedAt: ISODateString,
    error?: string | null
  ): Message | null;
  mergeMessageMetadata(id: string, metadata: JsonObject, updatedAt: ISODateString): void;

  appendEvent(input: AppendEventInput): RunEvent;
  listEvents(runId: string, after?: number): RunEvent[];
  getLatestEventSeq(runId: string): number;

  listAgentDefinitions(): AgentDefinition[];
  getAgentDefinition(id: string): AgentDefinition | null;
  updateAgentDefinition(input: UpdateAgentDefinitionInput): AgentDefinition | null;

  createPermissionRequest(input: CreatePermissionRequestInput): StoredPermissionRequest;
  getPermissionRequest(id: string): StoredPermissionRequest | null;
  listPermissionRequests(filter?: ListPermissionRequestsFilter): StoredPermissionRequest[];
  /** Resolves only a pending request whose run is waiting, and atomically resumes that run. */
  resolvePermissionRequest(id: string, status: Exclude<PermissionRequestStatus, "pending">, resolvedAt: ISODateString): StoredPermissionRequest | null;

  getDaemonLease(): DaemonLeaseRecord | null;
  createDaemonLease(input: DaemonLeaseRecord): boolean;
  takeOverDaemonLease(expectedOwnerId: string, expectedHeartbeatAt: ISODateString, input: DaemonLeaseRecord): boolean;
  heartbeatDaemonLease(ownerId: string, pid: number, heartbeatAt: ISODateString): boolean;
  releaseDaemonLease(ownerId: string): boolean;

  listSettings(): JsonObject;
  setSetting(key: string, value: JsonValue, updatedAt: ISODateString): void;
}
