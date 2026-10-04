import type { RunEvent } from "../shared/types";

export type RunEventListener = (event: RunEvent) => void;

export class RunEventBus {
  private readonly observers = new Set<RunEventListener>();
  observe(listener: RunEventListener): () => void {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }
  private readonly listeners = new Map<string, Set<RunEventListener>>();

  publish(event: RunEvent): void {
    for (const observer of this.observers) {
      try { observer(event); } catch { console.error("Run lifecycle observer failed; durable state will be reconciled on restart."); }
    }
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
