export type ISODateString = string;

export type MessageRole = "system" | "user" | "assistant";
export type MessagePartType = "text";
export type MessageStatus = "completed" | "streaming" | "cancelled" | "failed";
export type RunStatus = "running" | "completed" | "cancelled" | "failed";

export interface Session {
  id: string;
  title: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface MessagePart {
  id: string;
  messageId: string;
  seq: number;
  type: MessagePartType;
  text: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface Message {
  id: string;
  sessionId: string;
  runId: string | null;
  role: MessageRole;
  status: MessageStatus;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  parts: MessagePart[];
}

export interface Run {
  id: string;
  sessionId: string;
  provider: string;
  status: RunStatus;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  error: string | null;
}

export type RunEventType =
  | "run_started"
  | "user_message_created"
  | "assistant_message_created"
  | "delta"
  | "run_completed"
  | "run_cancelled"
  | "run_failed";

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
  provider?: string;
}

export interface CreateRunResponse {
  run: Run;
  provider: string;
  assistantMessageId: string;
}
