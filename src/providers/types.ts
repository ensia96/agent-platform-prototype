import type {
  BuiltContext,
  JsonObject,
  Message,
  MessagePart,
  MessagePartType,
  ProviderModelCatalog,
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
  /**
   * Provider-neutral context built by the kernel. Adapters are responsible for
   * translating its messages, run options, and availableTools into the
   * provider-specific request shape.
   */
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
  writeReasoningSummary?(summary: ProviderReasoningSummaryRecord): MessagePart | null | Promise<MessagePart | null>;
  writeReasoningDetail?(detail: ProviderReasoningDetailRecord): MessagePart | null | Promise<MessagePart | null>;
  appendMessagePart?(part: ProviderMessagePartInput): MessagePart | Promise<MessagePart>;
  recordToolCall?(toolCall: ProviderToolCallRecord): MessagePart | Promise<MessagePart>;
  recordToolResult?(toolResult: ProviderToolResultRecord): MessagePart | Promise<MessagePart>;
}

export interface ProviderReasoningSummaryRecord {
  summary?: string;
  usage?: RunUsage;
  provenance: ProviderReasoningProvenance;
}

export interface ProviderReasoningDetailRecord {
  detail?: string;
  usage?: RunUsage;
  provenance: ProviderReasoningProvenance;
}

export interface ProviderReasoningProvenance {
  provider: string;
  nativeEventType?: string;
  itemId?: string;
  outputIndex?: number;
  summaryIndexes?: number[];
  contentIndexes?: number[];
  authoritative?: boolean;
}

export interface ProviderMessagePartInput {
  /** Reasoning parts must use their explicit writer methods so provenance is sanitized. */
  type: Exclude<MessagePartType, "reasoning_summary" | "reasoning_detail">;
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

export interface ProviderToolCall {
  id: string;
  /** Provider-native function/tool name, e.g. shell_exec. Runtime maps this to a canonical tool id. */
  name: string;
  /** Parsed JSON object arguments supplied by the model. */
  arguments: JsonObject;
  /** Raw argument JSON text when provided by a streaming API. */
  argumentsText?: string;
  metadata?: JsonObject;
}

export interface ProviderRunResult {
  toolCalls: ProviderToolCall[];
  metadata?: JsonObject;
}

export interface ProviderAdapter {
  id: string;
  label: string;
  test(profile: ProviderProfile, credential: ProviderCredential): Promise<ProviderTestResponse>;
  listModels?(profile: ProviderProfile, credential: ProviderCredential): Promise<ProviderModelCatalog>;
  /**
   * Execute one provider turn. If the provider emits native tool/function calls,
   * convert them into canonical ProviderToolCall records; the kernel will handle
   * permission gates, execution, result persistence, and follow-up turns.
   */
  run(input: ProviderRunInput, context: ProviderRunContext): Promise<ProviderRunResult>;
}
