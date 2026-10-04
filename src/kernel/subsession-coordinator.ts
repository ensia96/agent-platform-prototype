import type { StoreAdapter } from "../store/types";
import type { AgentDefinition, JsonObject, SubsessionDelegation } from "../shared/types";
import type { RegisteredTool } from "../tools/types";
import { ToolInputError } from "../tools/types";
import { agentRunSnapshotToJson } from "./kernel-metadata";

export const subsessionToolId = "subsession.start";

interface SubsessionHost {
  agent(id: string): AgentDefinition;
  execute(runId: string): Promise<void>;
  fail(runId: string, error: unknown): void;
  wake(parentRunId: string): void;
  cancel(runId: string): void;
}

/** No execution queue: SQLite reserves unfinished child tasks; only result wakeups coalesce. */
export class SubsessionCoordinator {
  private readonly pendingWakes = new Set<string>();
  private stopped = false;
  private cascading = false;
  private reconciling = false;
  private readonly starts = new Map<string, Promise<void>>();
  constructor(private readonly store: StoreAdapter, private readonly host: SubsessionHost) {}

  tool(): RegisteredTool {
    return {
      definition: {
        id: subsessionToolId, name: "Start child session", source: "builtin",
        description: "Root Sessions only: start an independent child task and return its handle immediately. At most four unfinished children per owning root Run, including approval waits and cancelling tasks. No execution queue: when full, wait for a terminal child and retry. Results include current capacity/active handles. Child re-delegation is forbidden regardless of profile tools. Explicit target/tool approval is required.",
        inputSchema: { type: "object", properties: { agentId: { type: "string" }, task: { type: "string" }, title: { type: "string" } }, required: ["agentId", "task"], additionalProperties: false },
        outputSchema: { type: "object" }, metadata: {}
      },
      executor: {
        validateInput: (input) => {
          if (typeof input.agentId !== "string" || typeof input.task !== "string" || !input.task.trim() || input.task.length > 12000) {
            throw new ToolInputError("subsession.start requires agentId and a task of 1–12000 characters.");
          }
          const agent = this.host.agent(input.agentId);
          return { agentId: agent.id, agentRevision: agent.revision, targetTools: agent.toolIds.filter((id) => id !== subsessionToolId),
            task: input.task.trim(), title: typeof input.title === "string" ? input.title.slice(0,160) : `Child: ${agent.name}` };
        },
        execute: async (input, context) => {
          if (context.signal.aborted) throw new Error("Delegation cancelled.");
          const existing = this.store.subsessions.list(context.invocation.runId).find((item) => item.invocationId === context.invocation.id);
          const child = this.store.subsessions.admit({ parentRunId: context.invocation.runId,
            invocationId: context.invocation.id, agentId: String(input.agentId), agentRevision: Number(input.agentRevision),
            cwd: context.cwd, title: String(input.title), task: String(input.task),
            agentSnapshot: agentRunSnapshotToJson(this.host.agent(String(input.agentId)),new Date().toISOString()) });
          if (existing) return { ...handle(child),capacity:this.store.subsessions.capacity(context.invocation.runId) };
          const promise = Promise.resolve().then(() => this.host.execute(child.childRunId))
            .catch((error) => this.host.fail(child.childRunId,error))
            .finally(() => { this.starts.delete(child.childRunId); this.changed(); });
          this.starts.set(child.childRunId,promise);
          return { ...handle(child),capacity:this.store.subsessions.capacity(context.invocation.runId) };
        }
      }
    };
  }

  changed(): void {
    if (this.reconciling || this.cascading) return;
    this.reconciling = true;
    try {
      this.store.subsessions.reconcile();
      if (this.stopped) return;
      for (const item of this.store.subsessions.list()) {
        const parent = this.store.getRun(item.parentRunId);
        if (parent && ["completed", "failed", "cancelled", "interrupted", "cancelling"].includes(parent.status)) {
          const child = this.store.getRun(item.childRunId);
          if (child && ["running", "waiting_permission", "waiting_children"].includes(child.status)) this.cancelOwned(item.parentRunId);
          if (!child) this.store.subsessions.failStart(item.id);
          continue;
        }
        if (item.result === null || item.acknowledged) continue;
        this.requestWake(item.parentRunId);
      }
    } finally { this.reconciling = false; }
  }

  requestWake(parentRunId: string): void {
    if (this.stopped || this.pendingWakes.has(parentRunId)) return;
    this.pendingWakes.add(parentRunId);
    setImmediate(() => {
      this.pendingWakes.delete(parentRunId);
      if (!this.stopped) this.host.wake(parentRunId);
    });
  }

  cancelOwned(parentRunId: string): void {
    if (this.cascading) return;
    this.cascading = true;
    // Read-only traversal is retained solely to clean up legacy nested ownership safely.
    // New child admissions are root-only; this does not enable recursive execution.
    const pending = [parentRunId];
    const visited = new Set<string>();
    try {
      while (pending.length) {
        const id = pending.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        for (const item of this.store.subsessions.list(id)) {
          const run = this.store.getRun(item.childRunId);
          pending.push(item.childRunId);
          if (run && ["running", "waiting_permission", "waiting_children", "cancelling"].includes(run.status)) this.host.cancel(run.id);
          if (!run) this.store.subsessions.failStart(item.id);
        }
      }
    } finally { this.cascading = false; }
    this.changed();
  }

  stop(): void { this.stopped = true; }

  activePromises(): Promise<void>[] { return [...this.starts.values()]; }
}

function handle(child: SubsessionDelegation): JsonObject {
  return { delegationId: child.id, rootRunId: child.rootRunId, childSessionId: child.childSessionId, childRunId: child.childRunId, status: child.status };
}
