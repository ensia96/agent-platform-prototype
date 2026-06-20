import type { Message, ProviderProfile, ProviderTestResponse, Session } from "../shared/types";

export interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderRunInput {
  session: Session;
  messages: ProviderMessage[];
  sourceMessages: Message[];
  profile: ProviderProfile;
  credential: ProviderCredential;
}

export interface ProviderCredential {
  apiKey?: string;
}

export interface ProviderRunWriter {
  writeDelta(text: string): void | Promise<void>;
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
