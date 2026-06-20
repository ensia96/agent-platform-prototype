import type { BuiltContext, JsonObject, Message, ProviderProfile, ProviderTestResponse, RunOptions, RunUsage, Session } from "../shared/types";

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
