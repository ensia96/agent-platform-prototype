export type ISODateString = string;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;

export type MessageRole = "system" | "user" | "assistant";
export type MessagePartType = "text";
export type MessageStatus = "completed" | "streaming" | "cancelled" | "failed";
export type RunStatus = "running" | "completed" | "cancelled" | "failed";
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
  error: string | null;
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
  providerProfileId?: string;
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

export interface CreateRunResponse {
  run: Run;
  provider: string;
  providerProfileId: string;
  providerResolution: ProviderResolution;
  assistantMessageId: string;
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
