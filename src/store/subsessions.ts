import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { JsonObject, SubsessionDelegation } from "../shared/types";
import { childProgressSummary } from "../shared/child-progress";

export interface SubsessionAdmission {
  parentRunId: string;
  invocationId: string;
  agentId: string;
  agentRevision: number;
  title: string;
  cwd: string;
  task: string;
  agentSnapshot: JsonObject;
}

export const activeChildLimit = 4;

export class SubsessionAdmissionError extends Error {
  constructor(readonly code: "subsession_root_only" | "subsession_capacity_exhausted" | "subsession_parent_changed",
    message: string, readonly details: JsonObject = {}) {
    super(message);
    this.name = "SubsessionAdmissionError";
  }
}

/** Admission and delivery are separate durable transactions, never an in-memory job queue. */
export class SubsessionStore {
  constructor(private readonly db: Database.Database) {
    const migrate = db.transaction(() => {
      if (db.prepare("SELECT 1 FROM schema_migrations WHERE name = 'subsessions-v1'").get()) return;
      db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id)");
      db.exec(`CREATE TABLE subsession_delegations (
        id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL REFERENCES sessions(id),
        parent_run_id TEXT NOT NULL REFERENCES runs(id), invocation_id TEXT NOT NULL,
        child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id), child_run_id TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL, agent_revision INTEGER NOT NULL,
        status TEXT NOT NULL, result TEXT, delivered_part_id TEXT UNIQUE,
        acknowledged INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        UNIQUE(parent_run_id, invocation_id)
      ); CREATE INDEX idx_subsessions_parent ON subsession_delegations(parent_run_id);`);
      db.prepare("INSERT INTO schema_migrations VALUES ('subsessions-v1', ?)").run(new Date().toISOString());
    });
    migrate.immediate();
    db.transaction(() => {
      const name = "subsessions-root-only-schema-v3";
      if (db.prepare("SELECT 1 FROM schema_migrations WHERE name=?").get(name)) return;
      const columns = new Set((db.prepare("PRAGMA table_info(subsession_delegations)").all() as {name:string}[]).map((row) => row.name));
      if (!columns.has("root_run_id")) db.exec("ALTER TABLE subsession_delegations ADD COLUMN root_run_id TEXT");
      if (!columns.has("task")) db.exec("ALTER TABLE subsession_delegations ADD COLUMN task TEXT NOT NULL DEFAULT ''");
      db.exec("UPDATE subsession_delegations SET root_run_id=parent_run_id WHERE root_run_id IS NULL");
      db.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(name,new Date().toISOString());
    }).immediate();
  }

  /** Destructive lifecycle reconciliation runs only from startup after the daemon lease. */
  private interruptLegacyWork(): void {
    const db = this.db;
    db.transaction(() => {
      const name = "subsessions-root-only-v3";
      if (db.prepare("SELECT 1 FROM schema_migrations WHERE name=?").get(name)) return;
      // Development queue-v2 data is audit-only now. Never dispatch its queued approvals/tasks.
      // Preserve all relations, messages and old events (including any existing subsession_work table).
      const legacy = db.prepare(`SELECT r.id,r.session_id FROM runs r JOIN sessions s ON s.id=r.session_id
        LEFT JOIN sessions p ON p.id=s.parent_session_id
        WHERE r.status='queued' OR (p.parent_session_id IS NOT NULL AND r.status IN ('running','waiting_permission','waiting_children','cancelling'))`).all() as {id:string;session_id:string}[];
      const now = new Date().toISOString();
      const error = "Legacy queued or nested Sub-session work was interrupted by the root-only upgrade; no work was replayed.";
      for (const run of legacy) {
        db.prepare("UPDATE runs SET status='interrupted',error=?,updated_at=? WHERE id=?").run(error,now,run.id);
        db.prepare("UPDATE messages SET status='interrupted',updated_at=? WHERE run_id=? AND status='streaming'").run(now,run.id);
        db.prepare("UPDATE permission_requests SET status='expired',resolved_at=?,updated_at=? WHERE run_id=? AND status='pending'").run(now,now,run.id);
        db.prepare(`UPDATE message_parts SET content_json=json_set(content_json,'$.status','cancelled'),updated_at=?
          WHERE type='tool_call' AND message_id IN (SELECT id FROM messages WHERE run_id=?)
          AND json_extract(content_json,'$.status') IN ('created','pending','pending_permission','running')`).run(now,run.id);
        const seq = (db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events WHERE run_id=?").get(run.id) as {seq:number}).seq;
        db.prepare("INSERT INTO events(id,run_id,session_id,seq,type,created_at,payload_json) VALUES (?,?,?,?,'run_interrupted',?,?)")
          .run(randomUUID(),run.id,run.session_id,seq,now,JSON.stringify({runId:run.id,error}));
      }
      this.reconcile();
      db.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(name,now);
    }).immediate();
  }

  list(parentRunId?: string): SubsessionDelegation[] {
    const rows = parentRunId
      ? this.db.prepare("SELECT * FROM subsession_delegations WHERE parent_run_id = ? ORDER BY created_at, id").all(parentRunId)
      : this.db.prepare("SELECT * FROM subsession_delegations ORDER BY created_at, id").all();
    return (rows as Record<string, unknown>[]).map(delegationFromRow);
  }

  admit(input: SubsessionAdmission): SubsessionDelegation {
    return this.db.transaction(() => {
      const parent = this.db.prepare(`SELECT r.session_id,r.segment_id,r.status,s.parent_session_id,s.active_segment_id FROM runs r
        JOIN sessions s ON s.id = r.session_id WHERE r.id = ?`).get(input.parentRunId) as
        { session_id:string; segment_id:string; status:string; parent_session_id:string|null; active_segment_id:string } | undefined;
      if (parent?.parent_session_id) throw new SubsessionAdmissionError("subsession_root_only","Only a root Session may start a child. Child re-delegation is not allowed.");
      const existing = this.list(input.parentRunId).find((item) => item.invocationId === input.invocationId);
      if (existing) return existing;
      if (!parent || parent.status !== "running" || parent.segment_id !== parent.active_segment_id ||
        !this.db.prepare("SELECT 1 FROM context_segments WHERE id=? AND session_id=? AND status='active'").get(parent.segment_id,parent.session_id)) {
        throw new SubsessionAdmissionError("subsession_parent_changed","Delegation parent is no longer running in its active segment.");
      }
      const rootRunId = input.parentRunId;
      const agent = this.db.prepare("SELECT revision FROM agent_definitions WHERE id = ?").get(input.agentId) as { revision: number } | undefined;
      if (agent?.revision !== input.agentRevision) throw new Error("Target Agent changed after delegation approval; request approval again.");
      const capacity = this.capacity(input.parentRunId);
      if (capacity.available === 0) throw new SubsessionAdmissionError("subsession_capacity_exhausted",
        "Four owned child tasks are still unfinished. Wait for a child to reach terminal state before requesting another; no execution queue is created.",capacity);
      const id = randomUUID(), childSessionId = randomUUID(), childRunId = randomUUID(), segmentId = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO sessions (id,title,working_directory,agent_id,active_segment_id,parent_session_id,created_at,updated_at,metadata_json)
        VALUES (?,?,?,?,?,?,?,?,'{}')`).run(childSessionId, input.title, input.cwd, input.agentId, segmentId, parent.session_id, now, now);
      this.db.prepare(`INSERT INTO context_segments (id,session_id,ordinal,status,created_at) VALUES (?, ?, 0, 'active', ?)`)
        .run(segmentId, childSessionId, now);
      this.db.prepare(`INSERT INTO subsession_delegations
        (id,parent_session_id,parent_run_id,invocation_id,child_session_id,child_run_id,agent_id,agent_revision,status,created_at,root_run_id,task)
        VALUES (?,?,?,?,?,?,?,?,'starting',?,?,?)`).run(id,parent.session_id,input.parentRunId,input.invocationId,childSessionId,childRunId,input.agentId,input.agentRevision,now,rootRunId,input.task);
      this.db.prepare(`INSERT INTO runs(id,session_id,segment_id,provider,status,created_at,updated_at,metadata_json)
        VALUES (?,?,?,?,'running',?,?,?)`).run(childRunId,childSessionId,segmentId,
          String(input.agentSnapshot.modelProfileId ?? "pending"),now,now,JSON.stringify({agentSnapshot:input.agentSnapshot,workingDirectory:input.cwd,admissionPending:true}));
      return this.list(input.parentRunId).find((item) => item.id === id)!;
    }).immediate();
  }

  failStart(id: string): void {
    this.db.prepare(`UPDATE subsession_delegations SET status='interrupted', result='Child admission interrupted before execution.'
      WHERE id=? AND status='starting' AND NOT EXISTS (SELECT 1 FROM runs WHERE id=child_run_id)`).run(id);
  }

  /** Also called within terminal Run transaction: a committed child result cannot be lost. */
  reconcile(startup = false): void {
    if (startup) this.interruptLegacyWork();
    this.db.transaction(() => {
      for (const item of this.list()) {
        if (item.result !== null) continue;
        const run = this.db.prepare("SELECT status FROM runs WHERE id=?").get(item.childRunId) as { status: string } | undefined;
        if (!run) { if (startup) this.failStart(item.id); continue; }
        if (["running", "waiting_permission", "waiting_children", "cancelling"].includes(run.status)) {
          this.db.prepare("UPDATE subsession_delegations SET status=? WHERE id=?").run(run.status,item.id);
          continue;
        }
        const parts = this.db.prepare(`SELECT p.id,p.message_id,p.type,p.text,p.content_json FROM message_parts p JOIN messages m ON m.id=p.message_id
          WHERE m.run_id=? AND m.role='assistant' AND p.type IN ('text','tool_call','tool_result','command_output')
          ORDER BY m.created_at, m.id, p.seq`).all(item.childRunId) as {id:string;message_id:string;type:string;text:string;content_json:string}[];
        const result = childProgressSummary(item.childRunId,run.status,parts.map((p) => ({id:p.id,messageId:p.message_id,type:p.type,text:p.text,content:JSON.parse(p.content_json)})));
        this.db.prepare("UPDATE subsession_delegations SET status=?, result=? WHERE id=? AND result IS NULL").run(run.status,result,item.id);
      }
    })();
  }

  /** Canonical handoff is a single persisted tool_result part; safe on retry after crash. */
  deliver(parentRunId: string, messageId: string): boolean {
    return this.db.transaction(() => {
      const run = this.db.prepare("SELECT status FROM runs WHERE id=?").get(parentRunId) as { status: string } | undefined;
      if (run?.status !== "running") return false;
      if (!this.db.prepare("SELECT 1 FROM messages WHERE id=? AND run_id=? AND role='assistant'").get(messageId,parentRunId)) {
        throw new Error("Handoff delivery message must belong to the owning parent run.");
      }
      let delivered = false;
      for (const item of this.list(parentRunId)) {
        if (item.result === null || item.deliveredPartId) continue;
        const id = `handoff:${item.id}`;
        const content = { callId: id, toolId: "subsession.start", status: "completed", outputSummary: JSON.stringify({
          delegationId: item.id, childSessionId: item.childSessionId, childRunId: item.childRunId, status: item.status, result: item.result,
          capacity: this.capacity(parentRunId)
        }) };
        // seq 0 belongs exclusively to RunWriter's streaming text upsert.
        const seq = (this.db.prepare("SELECT MAX(1, COALESCE(MAX(seq),0)+1) AS seq FROM message_parts WHERE message_id=?").get(messageId) as { seq: number }).seq;
        const now = new Date().toISOString();
        this.db.prepare(`INSERT INTO message_parts (id,message_id,seq,type,text,content_json,metadata_json,created_at,updated_at)
          VALUES (?,?,?,'tool_result',?,?,'{"subsessionHandoff":true}',?,?)`).run(id,messageId,seq,content.outputSummary,JSON.stringify(content),now,now);
        this.db.prepare("UPDATE subsession_delegations SET delivered_part_id=? WHERE id=? AND delivered_part_id IS NULL").run(id,item.id);
        delivered = true;
      }
      return delivered;
    }).immediate();
  }

  wake(parentRunId: string): boolean {
    return this.db.transaction(() => {
      if (!this.list(parentRunId).some((item) => item.result !== null && !item.acknowledged)) return false;
      return this.db.prepare(`UPDATE runs SET status='running', metadata_json=json_set(metadata_json,'$.childWakePending',1), updated_at=?
        WHERE id=? AND status='waiting_children'`).run(new Date().toISOString(),parentRunId).changes === 1;
    }).immediate();
  }

  forRun(runId: string): SubsessionDelegation | null {
    const row = this.db.prepare("SELECT * FROM subsession_delegations WHERE child_run_id=?").get(runId) as Record<string,unknown> | undefined;
    return row ? delegationFromRow(row) : null;
  }

  task(runId: string): string {
    return (this.db.prepare("SELECT task FROM subsession_delegations WHERE child_run_id=?").get(runId) as { task: string }).task;
  }

  capacity(parentRunId: string): JsonObject & { limit: number; active: number; available: number } {
    const children = this.db.prepare(`SELECT d.id,d.child_session_id,d.child_run_id,COALESCE(r.status,d.status) AS status
      FROM subsession_delegations d LEFT JOIN runs r ON r.id=d.child_run_id
      WHERE d.parent_run_id=? AND (r.status IN ('running','waiting_permission','waiting_children','cancelling')
        OR (r.id IS NULL AND d.result IS NULL)) ORDER BY d.created_at,d.id`).all(parentRunId) as
      {id:string;child_session_id:string;child_run_id:string;status:string}[];
    return {limit:activeChildLimit,active:children.length,available:Math.max(0,activeChildLimit-children.length),
      activeChildren:children.map((item) => ({delegationId:item.id,childSessionId:item.child_session_id,childRunId:item.child_run_id,status:item.status}))};
  }

  acknowledge(parentRunId: string, ids: string[]): void {
    const update = this.db.prepare("UPDATE subsession_delegations SET acknowledged=1 WHERE id=? AND delivered_part_id IS NOT NULL");
    this.db.transaction(() => {
      for (const id of ids) update.run(id);
      this.db.prepare("UPDATE runs SET metadata_json=json_set(metadata_json,'$.childWakePending',0) WHERE id=? AND json_extract(metadata_json,'$.childWakePending')=1").run(parentRunId);
    })();
  }
}

function delegationFromRow(row: Record<string, unknown>): SubsessionDelegation {
  return { id: String(row.id), rootRunId: String(row.root_run_id), parentSessionId: String(row.parent_session_id), parentRunId: String(row.parent_run_id),
    invocationId: String(row.invocation_id), childSessionId: String(row.child_session_id), childRunId: String(row.child_run_id),
    agentId: String(row.agent_id), agentRevision: Number(row.agent_revision), status: row.status as SubsessionDelegation["status"],
    result: row.result as string | null, deliveredPartId: row.delivered_part_id as string | null,
    acknowledged: row.acknowledged === 1, createdAt: String(row.created_at) };
}
