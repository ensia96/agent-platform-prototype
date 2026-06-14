import type { Message, Session } from "../shared/types";

export interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderRunInput {
  session: Session;
  messages: ProviderMessage[];
  sourceMessages: Message[];
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
  available(): boolean;
  run(input: ProviderRunInput, context: ProviderRunContext): Promise<void>;
}
