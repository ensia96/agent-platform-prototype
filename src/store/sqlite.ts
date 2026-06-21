import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AddMessagePartInput,
  AppendEventInput,
  CreatePermissionRequestInput,
  CreateMessageInput,
  CreateRunInput,
  CreateSessionInput,
  ListPermissionRequestsFilter,
  StoreAdapter,
  StoredPermissionRequest,
  UpdateAgentDefinitionInput,
  UpdateMessagePartInput,
  UpsertMessageTextPartInput
} from "./types";
import type {
  AgentDefinition,
  JsonObject,
  JsonValue,
  Message,
  MessagePart,
  MessagePartType,
  MessageRole,
  MessageStatus,
  PermissionRequestStatus,
  PermissionRiskLevel,
  Run,
  RunEvent,
  RunEventType,
  RunOptions,
  RunStatus,
  RunUsage,
  Session,
  ToolInvocationCaller,
  ToolPermissionDecision
} from "../shared/types";

type SessionRow = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type RunRow = {
  id: string;
  session_id: string;
  provider: string;
  status: RunStatus;
  created_at: string;
  updated_at: string;
  error: string | null;
  metadata_json: string;
};

type MessageRow = {
  id: string;
  session_id: string;
  run_id: string | null;
  role: MessageRole;
  status: MessageStatus;
  created_at: string;
  updated_at: string;
  metadata_json: string;
  run_error: string | null;
};

type MessagePartRow = {
  id: string;
  message_id: string;
  seq: number;
  type: MessagePartType;
  text: string;
  content_json: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  id: string;
  run_id: string;
  session_id: string;
  seq: number;
  type: RunEventType;
  created_at: string;
  payload_json: string;
};

type SettingRow = {
  key: string;
  value_json: string;
  updated_at: string;
};

type AgentDefinitionRow = {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  model_profile_id: string | null;
  default_run_options_json: string;
  skill_ids_json: string;
  tool_ids_json: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

type PermissionRequestRow = {
  id: string;
  session_id: string;
  run_id: string;
  message_id: string;
  invocation_id: string;
  tool_id: string;
  tool_name: string;
  caller: ToolInvocationCaller;
  permission_decision: ToolPermissionDecision;
  input_summary: string;
  public_input_json: string;
  execution_input_json: string;
  risk_level: PermissionRiskLevel;
  reason: string;
  status: PermissionRequestStatus;
  tool_call_part_id: string;
  command_output_part_id: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

export interface SQLiteStoreOptions {
  dbPath: string;
}

export class SQLiteStore implements StoreAdapter {
  private readonly db: Database.Database;

  constructor(options: SQLiteStoreOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.ensureSchema();
  }

  listSessions(): Session[] {
    const rows = this.db
      .prepare("SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC, created_at DESC")
      .all() as SessionRow[];
    return rows.map(rowToSession);
  }

  getSession(id: string): Session | null {
    const row = this.db
      .prepare("SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  createSession(input: CreateSessionInput): Session {
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, created_at, updated_at, metadata_json)
         VALUES (@id, @title, @createdAt, @updatedAt, '{}')`
      )
      .run(input);
    return this.getSession(input.id)!;
  }

  touchSession(id: string, updatedAt: string): void {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(updatedAt, id);
  }

  createRun(input: CreateRunInput): Run {
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, provider, status, created_at, updated_at, error, metadata_json)
         VALUES (@id, @sessionId, @provider, @status, @createdAt, @updatedAt, @error, @metadataJson)`
      )
      .run({ ...input, error: input.error ?? null, metadataJson: JSON.stringify(input.metadata ?? {}) });
    return this.getRun(input.id)!;
  }

  getRun(id: string): Run | null {
    const row = this.db
      .prepare("SELECT id, session_id, provider, status, created_at, updated_at, error, metadata_json FROM runs WHERE id = ?")
      .get(id) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  updateRunStatus(id: string, status: RunStatus, error: string | null, updatedAt: string): void {
    this.db
      .prepare("UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, error, updatedAt, id);
  }

  mergeRunMetadata(id: string, metadata: JsonObject, updatedAt: string): void {
    const row = this.db.prepare("SELECT metadata_json FROM runs WHERE id = ?").get(id) as { metadata_json: string } | undefined;
    const nextMetadata = { ...parseJsonObject(row?.metadata_json), ...metadata };
    this.db.prepare("UPDATE runs SET metadata_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(nextMetadata), updatedAt, id);
  }

  listMessages(sessionId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.session_id, m.run_id, m.role, m.status, m.created_at, m.updated_at, m.metadata_json,
            r.error AS run_error
         FROM messages m
         LEFT JOIN runs r ON r.id = m.run_id
         WHERE m.session_id = ?
         ORDER BY m.created_at ASC,
           CASE m.role WHEN 'system' THEN 0 WHEN 'user' THEN 1 WHEN 'assistant' THEN 2 ELSE 3 END,
           m.id ASC`
      )
      .all(sessionId) as MessageRow[];

    if (rows.length === 0) {
      return [];
    }

    const partsByMessage = this.getPartsByMessageIds(rows.map((row) => row.id));
    return rows.map((row) => rowToMessage(row, partsByMessage.get(row.id) ?? []));
  }

  getMessage(id: string): Message | null {
    const row = this.db
      .prepare(
        `SELECT m.id, m.session_id, m.run_id, m.role, m.status, m.created_at, m.updated_at, m.metadata_json,
            r.error AS run_error
         FROM messages m
         LEFT JOIN runs r ON r.id = m.run_id
         WHERE m.id = ?`
      )
      .get(id) as MessageRow | undefined;

    if (!row) {
      return null;
    }

    const parts = this.getPartsByMessageIds([id]).get(id) ?? [];
    return rowToMessage(row, parts);
  }

  getAssistantMessageForRun(runId: string): Message | null {
    const row = this.db
      .prepare(
        `SELECT m.id, m.session_id, m.run_id, m.role, m.status, m.created_at, m.updated_at, m.metadata_json,
            r.error AS run_error
         FROM messages m
         LEFT JOIN runs r ON r.id = m.run_id
         WHERE m.run_id = ? AND m.role = 'assistant'
          ORDER BY m.created_at ASC
          LIMIT 1`
      )
      .get(runId) as MessageRow | undefined;

    if (!row) {
      return null;
    }

    const parts = this.getPartsByMessageIds([row.id]).get(row.id) ?? [];
    return rowToMessage(row, parts);
  }

  createMessage(input: CreateMessageInput): Message {
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, run_id, role, status, created_at, updated_at, metadata_json)
         VALUES (@id, @sessionId, @runId, @role, @status, @createdAt, @updatedAt, @metadataJson)`
      )
      .run({ ...input, runId: input.runId ?? null, metadataJson: JSON.stringify(input.metadata ?? {}) });
    return this.getMessage(input.id)!;
  }

  addMessagePart(input: AddMessagePartInput): MessagePart {
    this.db
      .prepare(
        `INSERT INTO message_parts (id, message_id, seq, type, text, content_json, metadata_json, created_at, updated_at)
         VALUES (@id, @messageId, @seq, @type, @text, @contentJson, @metadataJson, @createdAt, @updatedAt)`
      )
      .run({
        ...input,
        type: input.type ?? "text",
        contentJson: JSON.stringify(input.content ?? textPartContent(input.text)),
        metadataJson: JSON.stringify(input.metadata ?? {})
      });
    return this.getPartsByMessageIds([input.messageId]).get(input.messageId)?.find((part) => part.id === input.id)!;
  }

  upsertMessageTextPart(input: UpsertMessageTextPartInput): void {
    this.db
      .prepare(
        `INSERT INTO message_parts (id, message_id, seq, type, text, content_json, metadata_json, created_at, updated_at)
         VALUES (@id, @messageId, 0, 'text', @text, @contentJson, '{}', @updatedAt, @updatedAt)
          ON CONFLICT(message_id, seq) DO UPDATE SET
            type = 'text',
            text = excluded.text,
            content_json = excluded.content_json,
            updated_at = excluded.updated_at`
      )
      .run({ ...input, contentJson: JSON.stringify(textPartContent(input.text)) });
  }

  updateMessagePart(input: UpdateMessagePartInput): MessagePart | null {
    const current = this.db
      .prepare("SELECT id, message_id, seq, type, text, content_json, metadata_json, created_at, updated_at FROM message_parts WHERE id = ?")
      .get(input.id) as MessagePartRow | undefined;
    if (!current) {
      return null;
    }

    const content = input.content ?? parseJsonObject(current.content_json);
    const metadata = input.metadata ?? parseJsonObject(current.metadata_json);
    this.db
      .prepare(
        `UPDATE message_parts
         SET text = @text,
             content_json = @contentJson,
             metadata_json = @metadataJson,
             updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({
        id: input.id,
        text: input.text,
        contentJson: JSON.stringify(content),
        metadataJson: JSON.stringify(metadata),
        updatedAt: input.updatedAt
      });

    return this.getPartsByMessageIds([current.message_id]).get(current.message_id)?.find((part) => part.id === input.id) ?? null;
  }

  updateMessageStatus(id: string, status: MessageStatus, updatedAt: string, error?: string | null): void {
    if (error !== undefined) {
      const row = this.db.prepare("SELECT metadata_json FROM messages WHERE id = ?").get(id) as { metadata_json: string } | undefined;
      const metadata = parseJsonObject(row?.metadata_json);
      if (error) {
        metadata.error = error;
      } else {
        delete metadata.error;
      }
      this.db
        .prepare("UPDATE messages SET status = ?, updated_at = ?, metadata_json = ? WHERE id = ?")
        .run(status, updatedAt, JSON.stringify(metadata), id);
      return;
    }

    this.db.prepare("UPDATE messages SET status = ?, updated_at = ? WHERE id = ?").run(status, updatedAt, id);
  }

  mergeMessageMetadata(id: string, metadata: JsonObject, updatedAt: string): void {
    const row = this.db.prepare("SELECT metadata_json FROM messages WHERE id = ?").get(id) as { metadata_json: string } | undefined;
    const nextMetadata = { ...parseJsonObject(row?.metadata_json), ...metadata };
    this.db.prepare("UPDATE messages SET metadata_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(nextMetadata), updatedAt, id);
  }

  appendEvent(input: AppendEventInput): RunEvent {
    const append = this.db.transaction(() => {
      const nextSeqRow = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE run_id = ?").get(input.runId) as {
        seq: number;
      };

      this.db
        .prepare(
          `INSERT INTO events (id, run_id, session_id, seq, type, created_at, payload_json)
           VALUES (@id, @runId, @sessionId, @seq, @type, @createdAt, @payloadJson)`
        )
        .run({
          id: input.id,
          runId: input.runId,
          sessionId: input.sessionId,
          seq: nextSeqRow.seq,
          type: input.type,
          createdAt: input.createdAt,
          payloadJson: JSON.stringify(input.payload ?? {})
        });

      const row = this.db
        .prepare(
          `SELECT id, run_id, session_id, seq, type, created_at, payload_json
           FROM events
           WHERE id = ?`
        )
        .get(input.id) as EventRow;
      return rowToEvent(row);
    });

    return append();
  }

  listEvents(runId: string): RunEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, session_id, seq, type, created_at, payload_json
         FROM events
         WHERE run_id = ?
         ORDER BY seq ASC`
      )
      .all(runId) as EventRow[];
    return rows.map(rowToEvent);
  }

  listAgentDefinitions(): AgentDefinition[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, description, system_prompt, model_profile_id, default_run_options_json,
                skill_ids_json, tool_ids_json, metadata_json, created_at, updated_at
         FROM agent_definitions
         ORDER BY CASE id WHEN 'main' THEN 0 ELSE 1 END, name ASC, id ASC`
      )
      .all() as AgentDefinitionRow[];
    return rows.map(rowToAgentDefinition);
  }

  getAgentDefinition(id: string): AgentDefinition | null {
    const row = this.db
      .prepare(
        `SELECT id, name, description, system_prompt, model_profile_id, default_run_options_json,
                skill_ids_json, tool_ids_json, metadata_json, created_at, updated_at
         FROM agent_definitions
         WHERE id = ?`
      )
      .get(id) as AgentDefinitionRow | undefined;
    return row ? rowToAgentDefinition(row) : null;
  }

  updateAgentDefinition(input: UpdateAgentDefinitionInput): AgentDefinition | null {
    const current = this.getAgentDefinition(input.id);
    if (!current) {
      return null;
    }

    const next: AgentDefinition = {
      ...current,
      name: input.name ?? current.name,
      description: input.description !== undefined ? input.description : current.description,
      systemPrompt: input.systemPrompt ?? current.systemPrompt,
      modelProfileId: input.modelProfileId !== undefined ? input.modelProfileId : current.modelProfileId,
      defaultRunOptions: input.defaultRunOptions !== undefined ? input.defaultRunOptions : current.defaultRunOptions,
      skillIds: input.skillIds ?? current.skillIds,
      toolIds: input.toolIds ?? current.toolIds,
      metadata: input.metadata ?? current.metadata,
      updatedAt: input.updatedAt
    };

    this.db
      .prepare(
        `UPDATE agent_definitions
         SET name = @name,
             description = @description,
             system_prompt = @systemPrompt,
             model_profile_id = @modelProfileId,
             default_run_options_json = @defaultRunOptionsJson,
             skill_ids_json = @skillIdsJson,
             tool_ids_json = @toolIdsJson,
             metadata_json = @metadataJson,
             updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({
        id: next.id,
        name: next.name,
        description: next.description,
        systemPrompt: next.systemPrompt,
        modelProfileId: next.modelProfileId,
        defaultRunOptionsJson: JSON.stringify(runOptionsToJsonObject(next.defaultRunOptions ?? {})),
        skillIdsJson: JSON.stringify(next.skillIds),
        toolIdsJson: JSON.stringify(next.toolIds),
        metadataJson: JSON.stringify(next.metadata),
        updatedAt: next.updatedAt
      });

    return this.getAgentDefinition(input.id);
  }

  createPermissionRequest(input: CreatePermissionRequestInput): StoredPermissionRequest {
    this.db
      .prepare(
        `INSERT INTO permission_requests (
           id, session_id, run_id, message_id, invocation_id, tool_id, tool_name, caller, permission_decision,
           input_summary, public_input_json, execution_input_json, risk_level, reason, status,
           tool_call_part_id, command_output_part_id, metadata_json, created_at, updated_at, resolved_at
         ) VALUES (
           @id, @sessionId, @runId, @messageId, @invocationId, @toolId, @toolName, @caller, @permissionDecision,
           @inputSummary, @publicInputJson, @executionInputJson, @riskLevel, @reason, @status,
           @toolCallPartId, @commandOutputPartId, @metadataJson, @createdAt, @updatedAt, @resolvedAt
         )`
      )
      .run({
        ...input,
        publicInputJson: JSON.stringify(input.publicInput),
        executionInputJson: JSON.stringify(input.executionInput),
        commandOutputPartId: input.commandOutputPartId ?? null,
        metadataJson: JSON.stringify(input.metadata ?? {}),
        resolvedAt: input.resolvedAt ?? null
      });
    return this.getPermissionRequest(input.id)!;
  }

  getPermissionRequest(id: string): StoredPermissionRequest | null {
    const row = this.db
      .prepare(
        `SELECT id, session_id, run_id, message_id, invocation_id, tool_id, tool_name, caller, permission_decision,
                input_summary, public_input_json, execution_input_json, risk_level, reason, status,
                tool_call_part_id, command_output_part_id, metadata_json, created_at, updated_at, resolved_at
         FROM permission_requests
         WHERE id = ?`
      )
      .get(id) as PermissionRequestRow | undefined;
    return row ? rowToPermissionRequest(row) : null;
  }

  listPermissionRequests(filter: ListPermissionRequestsFilter = {}): StoredPermissionRequest[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.sessionId) {
      clauses.push("session_id = ?");
      params.push(filter.sessionId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, session_id, run_id, message_id, invocation_id, tool_id, tool_name, caller, permission_decision,
                input_summary, public_input_json, execution_input_json, risk_level, reason, status,
                tool_call_part_id, command_output_part_id, metadata_json, created_at, updated_at, resolved_at
         FROM permission_requests
         ${where}
         ORDER BY created_at DESC, id DESC`
      )
      .all(...params) as PermissionRequestRow[];
    return rows.map(rowToPermissionRequest);
  }

  resolvePermissionRequest(
    id: string,
    status: Exclude<PermissionRequestStatus, "pending">,
    resolvedAt: string
  ): StoredPermissionRequest | null {
    this.db
      .prepare("UPDATE permission_requests SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?")
      .run(status, resolvedAt, resolvedAt, id);
    return this.getPermissionRequest(id);
  }

  listSettings(): JsonObject {
    const rows = this.db
      .prepare("SELECT key, value_json, updated_at FROM app_settings ORDER BY key ASC")
      .all() as SettingRow[];
    const settings: JsonObject = {};
    for (const row of rows) {
      settings[row.key] = JSON.parse(row.value_json) as JsonValue;
    }
    return settings;
  }

  setSetting(key: string, value: JsonValue, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value_json, updated_at)
         VALUES (@key, @valueJson, @updatedAt)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .run({ key, valueJson: JSON.stringify(value), updatedAt });
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS message_parts (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        content_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(message_id, seq),
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(run_id, seq),
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS permission_requests (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        caller TEXT NOT NULL,
        permission_decision TEXT NOT NULL,
        input_summary TEXT NOT NULL,
        public_input_json TEXT NOT NULL,
        execution_input_json TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        tool_call_part_id TEXT NOT NULL,
        command_output_part_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        vendor TEXT,
        runtime TEXT,
        auth_mode TEXT,
        billing_source TEXT,
        base_url TEXT,
        endpoint TEXT,
        model TEXT,
        credential_ref TEXT,
        experimental INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS agent_definitions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        system_prompt TEXT NOT NULL,
        model_profile_id TEXT,
        default_run_options_json TEXT NOT NULL DEFAULT '{}',
        skill_ids_json TEXT NOT NULL DEFAULT '[]',
        tool_ids_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
      CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_message_parts_message ON message_parts(message_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_permission_requests_status ON permission_requests(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_permission_requests_session ON permission_requests(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_permission_requests_run ON permission_requests(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_app_settings_updated_at ON app_settings(updated_at);
      CREATE INDEX IF NOT EXISTS idx_provider_profiles_source ON provider_profiles(source, updated_at);
      CREATE INDEX IF NOT EXISTS idx_agent_definitions_updated_at ON agent_definitions(updated_at);
    `);
    this.ensureMessagePartStructuredColumns();
    this.seedDefaultAgents();
  }

  private ensureMessagePartStructuredColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(message_parts)").all() as Array<{ name: string }>).map((column) => column.name)
    );

    if (!columns.has("content_json")) {
      this.db.exec("ALTER TABLE message_parts ADD COLUMN content_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!columns.has("metadata_json")) {
      this.db.exec("ALTER TABLE message_parts ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
    }
  }

  private seedDefaultAgents(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_definitions (
           id, name, description, system_prompt, model_profile_id, default_run_options_json,
           skill_ids_json, tool_ids_json, metadata_json, created_at, updated_at
         )
         VALUES (@id, @name, @description, @systemPrompt, NULL, '{}', '[]', '[]', @metadataJson, @createdAt, @updatedAt)
         ON CONFLICT(id) DO NOTHING`
      )
      .run({
        id: "main",
        name: "Mango",
        description: "Default main assistant agent.",
        systemPrompt: "You are Mango, a helpful local assistant. Be concise, safe, and ask clarifying questions when requirements are unclear.",
        metadataJson: JSON.stringify({ builtin: true, version: 1 }),
        createdAt: now,
        updatedAt: now
      });
  }

  private getPartsByMessageIds(messageIds: string[]): Map<string, MessagePart[]> {
    if (messageIds.length === 0) {
      return new Map();
    }

    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, message_id, seq, type, text, content_json, metadata_json, created_at, updated_at
         FROM message_parts
         WHERE message_id IN (${placeholders})
         ORDER BY message_id ASC, seq ASC`
      )
      .all(...messageIds) as MessagePartRow[];

    const partsByMessage = new Map<string, MessagePart[]>();
    for (const row of rows) {
      const parts = partsByMessage.get(row.message_id) ?? [];
      parts.push(rowToMessagePart(row));
      partsByMessage.set(row.message_id, parts);
    }
    return partsByMessage;
  }
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToRun(row: RunRow): Run {
  const metadata = parseJsonObject(row.metadata_json);
  return {
    id: row.id,
    sessionId: row.session_id,
    provider: row.provider,
    status: row.status,
    metadata,
    model: modelFromMetadata(metadata),
    runOptions: runOptionsFromMetadata(metadata),
    usage: usageFromMetadata(metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error
  };
}

function rowToMessage(row: MessageRow, parts: MessagePart[]): Message {
  const metadata = parseJsonObject(row.metadata_json);
  const metadataError = typeof metadata.error === "string" && metadata.error.trim() ? metadata.error : null;
  const error = row.status === "failed" ? metadataError ?? row.run_error ?? null : metadataError;
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    role: row.role,
    status: row.status,
    error,
    metadata,
    model: modelFromMetadata(metadata),
    runOptions: runOptionsFromMetadata(metadata),
    usage: usageFromMetadata(metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parts
  };
}

function rowToMessagePart(row: MessagePartRow): MessagePart {
  const content = parseJsonObject(row.content_json);
  return {
    id: row.id,
    messageId: row.message_id,
    seq: row.seq,
    type: row.type,
    text: row.text,
    content: Object.keys(content).length > 0 ? content : textPartContent(row.text),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToEvent(row: EventRow): RunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    sessionId: row.session_id,
    seq: row.seq,
    type: row.type,
    createdAt: row.created_at,
    payload: JSON.parse(row.payload_json) as unknown
  };
}

function rowToAgentDefinition(row: AgentDefinitionRow): AgentDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    modelProfileId: row.model_profile_id,
    defaultRunOptions: runOptionsFromJsonObject(parseJsonObject(row.default_run_options_json)),
    skillIds: parseStringArray(row.skill_ids_json),
    toolIds: parseStringArray(row.tool_ids_json),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToPermissionRequest(row: PermissionRequestRow): StoredPermissionRequest {
  const publicInput = parseJsonObject(row.public_input_json);
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    messageId: row.message_id,
    invocationId: row.invocation_id,
    toolId: row.tool_id,
    toolName: row.tool_name,
    caller: row.caller,
    permissionDecision: row.permission_decision,
    inputSummary: row.input_summary,
    input: publicInput,
    publicInput,
    executionInput: parseJsonObject(row.execution_input_json),
    riskLevel: row.risk_level,
    reason: row.reason,
    status: row.status,
    toolCallPartId: row.tool_call_part_id,
    commandOutputPartId: row.command_output_part_id,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at
  };
}

function parseJsonObject(value: string | null | undefined): JsonObject {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function textPartContent(text: string): JsonObject {
  return { text };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelFromMetadata(metadata: JsonObject): string | null {
  return typeof metadata.model === "string" && metadata.model.trim() ? metadata.model : null;
}

function runOptionsFromMetadata(metadata: JsonObject): RunOptions | null {
  const value = metadata.runOptions;
  if (!isJsonObject(value)) {
    return null;
  }

  return runOptionsFromJsonObject(value);
}

function runOptionsFromJsonObject(value: JsonObject): RunOptions | null {
  const runOptions: RunOptions = {};
  if (typeof value.model === "string" && value.model.trim()) {
    runOptions.model = value.model;
  }
  if (isReasoningEffort(value.reasoningEffort)) {
    runOptions.reasoningEffort = value.reasoningEffort;
  }
  if (typeof value.temperature === "number" && Number.isFinite(value.temperature)) {
    runOptions.temperature = value.temperature;
  }

  return Object.keys(runOptions).length > 0 ? runOptions : null;
}

function runOptionsToJsonObject(options: RunOptions): JsonObject {
  const output: JsonObject = {};
  if (options.model) {
    output.model = options.model;
  }
  if (options.reasoningEffort) {
    output.reasoningEffort = options.reasoningEffort;
  }
  if (typeof options.temperature === "number" && Number.isFinite(options.temperature)) {
    output.temperature = options.temperature;
  }
  return output;
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function usageFromMetadata(metadata: JsonObject): RunUsage | null {
  const value = metadata.usage;
  if (!isJsonObject(value)) {
    return null;
  }

  const usage: RunUsage = {};
  if (typeof value.inputTokens === "number" && Number.isFinite(value.inputTokens)) {
    usage.inputTokens = value.inputTokens;
  }
  if (typeof value.outputTokens === "number" && Number.isFinite(value.outputTokens)) {
    usage.outputTokens = value.outputTokens;
  }
  if (typeof value.reasoningTokens === "number" && Number.isFinite(value.reasoningTokens)) {
    usage.reasoningTokens = value.reasoningTokens;
  }
  if (typeof value.totalTokens === "number" && Number.isFinite(value.totalTokens)) {
    usage.totalTokens = value.totalTokens;
  }

  return Object.keys(usage).length > 0 ? usage : null;
}

function isReasoningEffort(value: unknown): value is RunOptions["reasoningEffort"] {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}
