import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AddMessagePartInput,
  AppendEventInput,
  CreateMessageInput,
  CreateRunInput,
  CreateSessionInput,
  StoreAdapter,
  UpsertMessageTextPartInput
} from "./types";
import type {
  JsonObject,
  JsonValue,
  Message,
  MessagePart,
  MessagePartType,
  MessageRole,
  MessageStatus,
  Run,
  RunEvent,
  RunEventType,
  RunStatus,
  Session
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
         VALUES (@id, @sessionId, @provider, @status, @createdAt, @updatedAt, @error, '{}')`
      )
      .run({ ...input, error: input.error ?? null });
    return this.getRun(input.id)!;
  }

  getRun(id: string): Run | null {
    const row = this.db
      .prepare("SELECT id, session_id, provider, status, created_at, updated_at, error FROM runs WHERE id = ?")
      .get(id) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  updateRunStatus(id: string, status: RunStatus, error: string | null, updatedAt: string): void {
    this.db
      .prepare("UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, error, updatedAt, id);
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
         VALUES (@id, @sessionId, @runId, @role, @status, @createdAt, @updatedAt, '{}')`
      )
      .run({ ...input, runId: input.runId ?? null });
    return this.getMessage(input.id)!;
  }

  addMessagePart(input: AddMessagePartInput): void {
    this.db
      .prepare(
        `INSERT INTO message_parts (id, message_id, seq, type, text, created_at, updated_at, metadata_json)
         VALUES (@id, @messageId, @seq, 'text', @text, @createdAt, @updatedAt, '{}')`
      )
      .run(input);
  }

  upsertMessageTextPart(input: UpsertMessageTextPartInput): void {
    this.db
      .prepare(
        `INSERT INTO message_parts (id, message_id, seq, type, text, created_at, updated_at, metadata_json)
         VALUES (@id, @messageId, 0, 'text', @text, @updatedAt, @updatedAt, '{}')
         ON CONFLICT(message_id, seq) DO UPDATE SET
           text = excluded.text,
           updated_at = excluded.updated_at`
      )
      .run(input);
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

      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
      CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_message_parts_message ON message_parts(message_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_app_settings_updated_at ON app_settings(updated_at);
      CREATE INDEX IF NOT EXISTS idx_provider_profiles_source ON provider_profiles(source, updated_at);
    `);
  }

  private getPartsByMessageIds(messageIds: string[]): Map<string, MessagePart[]> {
    if (messageIds.length === 0) {
      return new Map();
    }

    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, message_id, seq, type, text, created_at, updated_at
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
  return {
    id: row.id,
    sessionId: row.session_id,
    provider: row.provider,
    status: row.status,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parts
  };
}

function rowToMessagePart(row: MessagePartRow): MessagePart {
  return {
    id: row.id,
    messageId: row.message_id,
    seq: row.seq,
    type: row.type,
    text: row.text,
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

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
