import { randomUUID } from "node:crypto";
import type { RunEventBus, RunEventListener } from "./event-bus";
import { RunWriter } from "./run-writer";
import type { ProviderAdapter, ProviderMessage, ProviderRunInput } from "../providers/types";
import type { ProviderRegistry } from "../providers/registry";
import type { StoreAdapter } from "../store/types";
import type { CreateRunResponse, Message, Run, RunEvent, RunEventType, Session } from "../shared/types";

export interface StartRunOptions {
  provider?: string;
  providerProfileId?: string;
}

export class KernelError extends Error {
  constructor(message: string, readonly statusCode = 500) {
    super(message);
    this.name = "KernelError";
  }
}

export interface KernelOptions {
  store: StoreAdapter;
  providers: ProviderRegistry;
  eventBus: RunEventBus;
}

export class Kernel {
  private readonly store: StoreAdapter;
  private readonly providers: ProviderRegistry;
  private readonly eventBus: RunEventBus;
  private readonly controllers = new Map<string, AbortController>();

  constructor(options: KernelOptions) {
    this.store = options.store;
    this.providers = options.providers;
    this.eventBus = options.eventBus;
  }

  listSessions(): Session[] {
    return this.store.listSessions();
  }

  createSession(title?: string): Session {
    const now = new Date().toISOString();
    return this.store.createSession({
      id: randomUUID(),
      title: title?.trim() || "New session",
      createdAt: now,
      updatedAt: now
    });
  }

  getSession(id: string): Session {
    const session = this.store.getSession(id);
    if (!session) {
      throw new KernelError("Session not found", 404);
    }
    return session;
  }

  listMessages(sessionId: string): Message[] {
    this.getSession(sessionId);
    return this.store.listMessages(sessionId);
  }

  getRun(runId: string): Run {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new KernelError("Run not found", 404);
    }
    return run;
  }

  startRun(sessionId: string, text: string, options: StartRunOptions = {}): CreateRunResponse {
    const session = this.getSession(sessionId);
    const prompt = text.trim();
    if (!prompt) {
      throw new KernelError("Run text is required", 400);
    }

    const resolvedProvider = this.providers.resolveRun(options);
    const now = new Date().toISOString();
    const run = this.store.createRun({
      id: randomUUID(),
      sessionId,
      provider: resolvedProvider.profile.id,
      status: "running",
      createdAt: now,
      updatedAt: now
    });
    this.store.touchSession(sessionId, now);

    const userMessage = this.store.createMessage({
      id: randomUUID(),
      sessionId,
      runId: run.id,
      role: "user",
      status: "completed",
      createdAt: now,
      updatedAt: now
    });
    this.store.addMessagePart({
      id: randomUUID(),
      messageId: userMessage.id,
      seq: 0,
      text: prompt,
      createdAt: now,
      updatedAt: now
    });

    const assistantCreatedAt = new Date(Date.parse(now) + 1).toISOString();
    const assistantMessage = this.store.createMessage({
      id: randomUUID(),
      sessionId,
      runId: run.id,
      role: "assistant",
      status: "streaming",
      createdAt: assistantCreatedAt,
      updatedAt: assistantCreatedAt
    });

    const userMessageWithParts = this.store.getMessage(userMessage.id)!;
    const assistantMessageWithParts = this.store.getMessage(assistantMessage.id)!;

    this.emit(run, "run_started", {
      runId: run.id,
      sessionId,
      provider: resolvedProvider.adapter.id,
      providerProfileId: resolvedProvider.profile.id,
      requestedProvider: options.provider ?? null,
      requestedProviderProfileId: options.providerProfileId ?? null,
      providerResolution: resolvedProvider.providerResolution
    });
    this.emit(run, "user_message_created", { message: userMessageWithParts });
    this.emit(run, "assistant_message_created", { message: assistantMessageWithParts });

    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const writer = new RunWriter({
      store: this.store,
      eventBus: this.eventBus,
      run,
      assistantMessageId: assistantMessage.id
    });

    const providerInput: ProviderRunInput = {
      session,
      sourceMessages: this.store.listMessages(sessionId).filter((message) => message.id !== assistantMessage.id),
      messages: toProviderMessages(this.store.listMessages(sessionId).filter((message) => message.id !== assistantMessage.id)),
      profile: resolvedProvider.profile,
      credential: resolvedProvider.credential
    };

    queueMicrotask(() => {
      void this.executeRun(run, resolvedProvider.adapter, providerInput, controller, writer);
    });

    return {
      run,
      provider: resolvedProvider.adapter.id,
      providerProfileId: resolvedProvider.profile.id,
      providerResolution: resolvedProvider.providerResolution,
      assistantMessageId: assistantMessage.id
    };
  }

  cancelRun(runId: string): Run {
    const run = this.getRun(runId);
    if (run.status !== "running") {
      return run;
    }

    const controller = this.controllers.get(runId);
    if (controller) {
      controller.abort();
      return run;
    }

    const assistantMessage = this.store.getAssistantMessageForRun(runId);
    if (!assistantMessage) {
      throw new KernelError("Assistant message for run not found", 404);
    }

    const writer = new RunWriter({
      store: this.store,
      eventBus: this.eventBus,
      run,
      assistantMessageId: assistantMessage.id
    });
    writer.cancel();
    return this.getRun(runId);
  }

  listRunEvents(runId: string): RunEvent[] {
    this.getRun(runId);
    return this.store.listEvents(runId);
  }

  subscribeRunEvents(runId: string, listener: RunEventListener): () => void {
    this.getRun(runId);
    return this.eventBus.subscribe(runId, listener);
  }

  private async executeRun(
    run: Run,
    provider: ProviderAdapter,
    input: ProviderRunInput,
    controller: AbortController,
    writer: RunWriter
  ): Promise<void> {
    try {
      await provider.run(input, {
        signal: controller.signal,
        writer
      });

      if (controller.signal.aborted) {
        writer.cancel();
      } else {
        writer.complete();
      }
    } catch (error) {
      if (controller.signal.aborted || isAbortLike(error)) {
        writer.cancel();
      } else {
        const runError = toError(error);
        console.error("Provider run failed", {
          runId: run.id,
          provider: provider.id,
          error: runError.message
        });
        writer.fail(runError);
      }
    } finally {
      this.controllers.delete(run.id);
    }
  }

  private emit(run: Run, type: RunEventType, payload: unknown): RunEvent {
    const event = this.store.appendEvent({
      id: randomUUID(),
      runId: run.id,
      sessionId: run.sessionId,
      type,
      createdAt: new Date().toISOString(),
      payload
    });
    this.eventBus.publish(event);
    return event;
  }
}

function toProviderMessages(messages: Message[]): ProviderMessage[] {
  return messages
    .map((message) => ({
      role: message.role,
      content: message.parts.map((part) => part.text).join("")
    }))
    .filter((message): message is ProviderMessage =>
      (message.role === "system" || message.role === "user" || message.role === "assistant") && message.content.length > 0
    );
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
