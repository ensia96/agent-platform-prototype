import { RunType } from "@/run/type";
import { MessageType } from "@/message/type";
import type {
  AgentDefinition,
  ContextArtifact,
  ContextSegment,
  JsonObject,
  JsonValue,
  ISODateString,
  Message,
  MessagePart,
  MessagePartType,
  MessageRole,
  PermissionRequest,
  PermissionRequestStatus,
  PermissionRiskLevel,
  Run,
  RunEvent,
  RunEventType,
  RunOptions,
  Session,
  TerminalRunEventType,
  ToolInvocationCaller,
  ToolPermissionDecision
} from "../shared/types";
import type { SubsessionStore } from "./subsessions";

export interface CreateSessionInput {
  id: string;
  title: string;
  workingDirectory: string;
  agentId?: string;
  activeSegmentId?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface UpdateSessionInput {
  workingDirectory?: string;
  agentId?: string;
  updatedAt: ISODateString;
}

export interface CreateRunInput {
  id: string;
  sessionId: string;
  provider: string;
  status: "running";
  segmentId?: string;
  expectedActiveSegmentId?: string;
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
  segmentId?: string;
  role: MessageRole;
  status: MessageType.Status;
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
  expectedRevision: number;
  name?: string;
  description?: string | null;
  systemPrompt?: string;
  modelProfileId?: string | null;
  defaultRunOptions?: RunOptions | null;
  contextPolicy?: AgentDefinition["contextPolicy"];
  skillIds?: string[];
  toolIds?: string[];
  metadata?: JsonObject;
  updatedAt: ISODateString;
}

export type UpdateAgentDefinitionResult =
  | { status: "updated" | "unchanged"; agent: AgentDefinition }
  | { status: "revision_conflict"; agent: AgentDefinition }
  | { status: "not_found" };

export type DeleteAgentDefinitionResult =
  | { status: "deleted" }
  | { status: "in_use"; agent: AgentDefinition; sessions: Session[] }
  | { status: "revision_conflict"; agent: AgentDefinition }
  | { status: "not_found" };

export interface CreateAgentDefinitionInput {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  modelProfileId: string | null;
  defaultRunOptions: RunOptions | null;
  contextPolicy: AgentDefinition["contextPolicy"];
  skillIds: string[];
  toolIds: string[];
  metadata?: JsonObject;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface CloneAgentDefinitionInput extends CreateAgentDefinitionInput {
  sourceId: string;
  expectedSourceRevision: number;
}

export type CloneAgentDefinitionResult =
  | { status: "created"; agent: AgentDefinition }
  | { status: "revision_conflict"; agent: AgentDefinition }
  | { status: "not_found" };

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
  statuses?: readonly RunType.Status[];
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
  expectedStatuses: readonly RunType.Status[];
  status: RunType.TerminalStatus;
  error: string | null;
  updatedAt: ISODateString;
  event: Pick<AppendEventInput, "id" | "payload"> & { type: TerminalRunEventType };
}

export interface FinalizeRunResult {
  run: Run;
  event: RunEvent;
}

export interface CreateContextArtifactInput extends Omit<ContextArtifact, "targetSegmentId"> {
  targetSegmentId?: string | null;
}

export interface RotateContextSegmentInput {
  sessionId: string;
  expectedActiveSegmentId: string;
  newSegmentId: string;
  preservedMessageIds: string[];
  sourceRunIds: string[];
  preservedRunIds: string[];
  artifact: ContextArtifact;
  allowedActiveRunId?: string;
  rotatedAt: ISODateString;
}

export interface ReplaceInheritedContextArtifactInput {
  sessionId: string;
  expectedActiveSegmentId: string;
  expectedArtifactId: string;
  artifact: ContextArtifact;
  updatedAt: ISODateString;
}

export class ContextSegmentChangedStoreError extends Error {
  readonly code = "context_segment_changed";
  constructor(readonly sessionId: string, readonly expectedSegmentId: string, readonly activeSegmentId: string | null) {
    super(`Session '${sessionId}' active context segment changed during run creation.`);
    this.name = "ContextSegmentChangedStoreError";
  }
}

export interface StoreAdapter {
  readonly subsessions: SubsessionStore;
  listSessions(): Session[];
  getSession(id: string): Session | null;
  createSession(input: CreateSessionInput): Session;
  updateSession(id: string, input: UpdateSessionInput): Session | null;
  updateSessionWorkingDirectory(id: string, workingDirectory: string, updatedAt: ISODateString): Session | null;
  listSessionsByAgentId(agentId: string): Session[];
  touchSession(id: string, updatedAt: ISODateString): void;
  listContextSegments(sessionId: string): ContextSegment[];
  getContextSegment(id: string): ContextSegment | null;
  listContextArtifacts(sessionId: string): ContextArtifact[];
  getContextArtifact(id: string): ContextArtifact | null;
  createContextArtifact(input: CreateContextArtifactInput): ContextArtifact;
  rotateContextSegment(input: RotateContextSegmentInput): { segment: ContextSegment; artifact: ContextArtifact } | null;
  replaceInheritedContextArtifact(input: ReplaceInheritedContextArtifactInput): { segment: ContextSegment; artifact: ContextArtifact } | null;
  listMessagesBySegment(segmentId: string): Message[];

  createRun(input: CreateRunInput): Run;
  getRun(id: string): Run | null;
  listRuns(filter?: ListRunsFilter): Run[];
  transitionRunStatus(
    id: string,
    expectedStatuses: readonly RunType.Status[],
    status: RunType.ActiveStatus,
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
    expectedStatuses: readonly MessageType.Status[],
    status: MessageType.Status,
    updatedAt: ISODateString,
    error?: string | null
  ): Message | null;
  mergeMessageMetadata(id: string, metadata: JsonObject, updatedAt: ISODateString): void;

  appendEvent(input: AppendEventInput): RunEvent;
  listEvents(runId: string, after?: number): RunEvent[];
  getLatestEventSeq(runId: string): number;

  listAgentDefinitions(): AgentDefinition[];
  getAgentDefinition(id: string): AgentDefinition | null;
  createAgentDefinition(input: CreateAgentDefinitionInput): AgentDefinition;
  cloneAgentDefinition(input: CloneAgentDefinitionInput): CloneAgentDefinitionResult;
  updateAgentDefinition(input: UpdateAgentDefinitionInput): UpdateAgentDefinitionResult;
  deleteAgentDefinitionIfUnused(id: string, expectedRevision: number): DeleteAgentDefinitionResult;

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
