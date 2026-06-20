import type {
  JsonObject,
  JsonValue,
  ISODateString,
  Message,
  MessageRole,
  MessageStatus,
  Run,
  RunEvent,
  RunEventType,
  RunStatus,
  Session
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
  text: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface UpsertMessageTextPartInput {
  id: string;
  messageId: string;
  text: string;
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
  addMessagePart(input: AddMessagePartInput): void;
  upsertMessageTextPart(input: UpsertMessageTextPartInput): void;
  updateMessageStatus(id: string, status: MessageStatus, updatedAt: ISODateString, error?: string | null): void;
  mergeMessageMetadata(id: string, metadata: JsonObject, updatedAt: ISODateString): void;

  appendEvent(input: AppendEventInput): RunEvent;
  listEvents(runId: string): RunEvent[];

  listSettings(): JsonObject;
  setSetting(key: string, value: JsonValue, updatedAt: ISODateString): void;
}
