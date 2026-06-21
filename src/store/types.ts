import type {
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
  ToolInvocationCaller,
  ToolPermissionDecision
} from "../shared/types";

export interface CreateSessionInput {
  id: string;
  title: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface CreateRunInput {
  id: string;
  sessionId: string;
  provider: string;
  status: RunStatus;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  error?: string | null;
  metadata?: JsonObject;
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

export interface StoreAdapter {
  listSessions(): Session[];
  getSession(id: string): Session | null;
  createSession(input: CreateSessionInput): Session;
  touchSession(id: string, updatedAt: ISODateString): void;

  createRun(input: CreateRunInput): Run;
  getRun(id: string): Run | null;
  updateRunStatus(id: string, status: RunStatus, error: string | null, updatedAt: ISODateString): void;
  mergeRunMetadata(id: string, metadata: JsonObject, updatedAt: ISODateString): void;

  listMessages(sessionId: string): Message[];
  getMessage(id: string): Message | null;
  getAssistantMessageForRun(runId: string): Message | null;
  createMessage(input: CreateMessageInput): Message;
  addMessagePart(input: AddMessagePartInput): MessagePart;
  upsertMessageTextPart(input: UpsertMessageTextPartInput): void;
  updateMessagePart(input: UpdateMessagePartInput): MessagePart | null;
  updateMessageStatus(id: string, status: MessageStatus, updatedAt: ISODateString, error?: string | null): void;
  mergeMessageMetadata(id: string, metadata: JsonObject, updatedAt: ISODateString): void;

  appendEvent(input: AppendEventInput): RunEvent;
  listEvents(runId: string): RunEvent[];

  listAgentDefinitions(): AgentDefinition[];
  getAgentDefinition(id: string): AgentDefinition | null;
  updateAgentDefinition(input: UpdateAgentDefinitionInput): AgentDefinition | null;

  createPermissionRequest(input: CreatePermissionRequestInput): StoredPermissionRequest;
  getPermissionRequest(id: string): StoredPermissionRequest | null;
  listPermissionRequests(filter?: ListPermissionRequestsFilter): StoredPermissionRequest[];
  resolvePermissionRequest(id: string, status: Exclude<PermissionRequestStatus, "pending">, resolvedAt: ISODateString): StoredPermissionRequest | null;

  listSettings(): JsonObject;
  setSetting(key: string, value: JsonValue, updatedAt: ISODateString): void;
}
