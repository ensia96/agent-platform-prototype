import type {
  BuiltContext,
  JsonObject,
  Message,
  MessagePart,
  MessagePartType,
  ProviderProfile,
  ProviderTestResponse,
  RunOptions,
  RunUsage,
  Session
} from "../shared/types";

export interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderRunInput {
  session: Session;
  context: BuiltContext;
  messages: ProviderMessage[];
  sourceMessages: Message[];
  profile: ProviderProfile;
  credential: ProviderCredential;
  requestedRunOptions: RunOptions;
  runOptions: RunOptions;
  unsupportedRunOptions: string[];
}

export interface ProviderCredential {
  apiKey?: string;
  oauth?: ProviderOAuthCredential;
}

export interface ProviderOAuthCredential {
  type: "oauth";
  access: string;
  refresh?: string;
  expiresAt?: number;
  accountId?: string;
  scope?: string;
  credentialRef?: string;
}

export interface ProviderRunWriter {
  writeDelta(text: string): void | Promise<void>;
  writeUsage(usage: RunUsage): void | Promise<void>;
  writeMetadata(metadata: JsonObject): void | Promise<void>;
  writeReasoningSummary?(summary: ProviderReasoningSummaryRecord): MessagePart | Promise<MessagePart>;
  appendMessagePart?(part: ProviderMessagePartInput): MessagePart | Promise<MessagePart>;
  recordToolCall?(toolCall: ProviderToolCallRecord): MessagePart | Promise<MessagePart>;
  recordToolResult?(toolResult: ProviderToolResultRecord): MessagePart | Promise<MessagePart>;
}

export interface ProviderReasoningSummaryRecord {
  summary?: string;
  usage?: RunUsage;
  metadata?: JsonObject;
}

export interface ProviderMessagePartInput {
  type: MessagePartType;
  text?: string;
  content?: JsonObject;
  metadata?: JsonObject;
}

export interface ProviderToolCallRecord {
  callId?: string;
  toolId: string;
  toolName?: string;
  provider?: string;
  /** Sanitized public tool input only; never pass credential or token values here. */
  input?: JsonObject;
  inputSummary?: string;
  metadata?: JsonObject;
}

export interface ProviderToolResultRecord {
  callId: string;
  toolId?: string;
  toolName?: string;
  status?: "completed" | "failed" | "cancelled";
  output?: string;
  outputSummary?: string;
  error?: string;
  metadata?: JsonObject;
}

export interface ProviderRunContext {
  signal: AbortSignal;
  writer: ProviderRunWriter;
}

export interface ProviderAdapter {
  id: string;
  label: string;
  test(profile: ProviderProfile, credential: ProviderCredential): Promise<ProviderTestResponse>;
  run(input: ProviderRunInput, context: ProviderRunContext): Promise<void>;
}
