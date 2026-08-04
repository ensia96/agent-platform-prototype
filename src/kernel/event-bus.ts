import type { RunEvent } from "../shared/types";

export type RunEventListener = (event: RunEvent) => void;

export class RunEventBus {
  private readonly listeners = new Map<string, Set<RunEventListener>>();

  publish(event: RunEvent): void {
    const listeners = this.listeners.get(event.runId);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Run event listener failed", {
          runId: event.runId,
          eventType: event.type,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  subscribe(runId: string, listener: RunEventListener): () => void {
    const listeners = this.listeners.get(runId) ?? new Set<RunEventListener>();
    listeners.add(listener);
    this.listeners.set(runId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(runId);
      }
    };
  }
}
