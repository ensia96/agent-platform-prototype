import Database from "better-sqlite3";
import { SubsessionStore } from "./subsessions";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  AddMessagePartInput,
  AppendEventInput,
  CloneAgentDefinitionInput,
  CloneAgentDefinitionResult,
  CreateAgentDefinitionInput,
  CreatePermissionRequestInput,
  CreateMessageInput,
  CreateRunInput,
  CreateSessionInput,
  CreateContextArtifactInput,
  DaemonLeaseRecord,
  FinalizeRunInput,
  FinalizeRunResult,
  ListPermissionRequestsFilter,
  ListRunsFilter,
  RunCancellationResult,
  RequestRunCancellationInput,
  RotateContextSegmentInput,
  ReplaceInheritedContextArtifactInput,
  StoreAdapter,
  StoredPermissionRequest,
  DeleteAgentDefinitionResult,
  UpdateAgentDefinitionInput,
  UpdateAgentDefinitionResult,
  UpdateSessionInput,
  UpdateMessagePartInput,
  UpsertMessageTextPartInput
} from "./types";
import { ActiveRunExistsStoreError, ContextSegmentChangedStoreError } from "./types";
import type {
  AgentDefinition,
  ContextArtifact,
  ContextArtifactSourceCategory,
  ContextSegment,
  JsonObject,
  JsonValue,
  Message,
  MessagePart,
  MessagePartType,
  MessageRole,
  PermissionRiskLevel,
  Run,
  RunEvent,
  RunEventType,
  RunOptions,
  RunUsage,
  Session,
  ToolInvocationCaller,
  ToolPermissionDecision
} from "../shared/types";
import { isTerminalRunEventType } from "../shared/types";
import { RunType } from "@/run/type";
import { RunVO } from "@/run/vo";
import { MessageType } from "@/message/type";
import { MessageVO } from "@/message/vo";
import { PermissionRequestType } from "@/permission-request/type";
import { PermissionRequestVO } from "@/permission-request/vo";
import { defaultMainAgentToolIds } from "../shared/model-tools";
import { normalizeReasoningEffort } from "../shared/run-options";

type SessionRow = {
  parent_session_id?: string | null;
  id: string;
  title: string;
  working_directory: string | null;
  agent_id: string;
  active_segment_id: string;
  created_at: string;
  updated_at: string;
};

type RunRow = {
  id: string;
  session_id: string;
  provider: string;
  status: RunType.Status;
  segment_id: string;
  created_at: string;
  updated_at: string;
  error: string | null;
  metadata_json: string;
};

type MessageRow = {
  id: string;
  session_id: string;
  run_id: string | null;
  segment_id: string;
  role: MessageRole;
  status: MessageType.Status;
  created_at: string;
  updated_at: string;
  metadata_json: string;
  run_error: string | null;
};

type ContextSegmentRow = {
  id: string;
  session_id: string;
  ordinal: number;
  previous_segment_id: string | null;
  status: "active" | "sealed";
  first_message_id: string | null;
  last_message_id: string | null;
  inherited_artifact_id: string | null;
  created_at: string;
  sealed_at: string | null;
  message_count: number;
};

type ContextArtifactRow = {
  id: string;
  kind: "compaction";
  session_id: string;
  source_segment_id: string;
  target_segment_id: string | null;
  previous_artifact_id: string | null;
  source_message_ids_json: string;
  source_categories_json: string;
  source_first_message_id: string | null;
  source_last_message_id: string | null;
  summary: string;
  strategy_version: string;
  estimator_version: string;
  estimated_tokens_before: number;
  estimated_tokens_after: number;
  resolved_window_tokens: number;
  window_source: ContextArtifact["windowSource"];
  status: "completed" | "failed";
  provider_profile_id: string | null;
  model: string | null;
  usage_json: string;
  error: string | null;
  created_at: string;
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
  revision: number;
  name: string;
  description: string | null;
  system_prompt: string;
  model_profile_id: string | null;
  default_run_options_json: string;
  context_policy_json: string;
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
  status: PermissionRequestType.Status;
  tool_call_part_id: string;
  command_output_part_id: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

type DaemonLeaseRow = {
  owner_id: string;
  pid: number;
  acquired_at: string;
  heartbeat_at: string;
};

export interface SQLiteStoreOptions {
  dbPath: string;
  defaultWorkingDirectory?: string;
}

export class SQLiteStore implements StoreAdapter {
  readonly subsessions: SubsessionStore;
  private readonly db: Database.Database;
  private readonly defaultWorkingDirectory: string;

  constructor(options: SQLiteStoreOptions) {
    this.defaultWorkingDirectory = resolve(options.defaultWorkingDirectory ?? process.cwd());
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.ensureSchema();
    this.subsessions = new SubsessionStore(this.db);
  }

  listSessions(): Session[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC, created_at DESC")
      .all() as SessionRow[];
    return rows.map((row) => rowToSession(row, this.defaultWorkingDirectory));
  }

  getSession(id: string): Session | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    return row ? rowToSession(row, this.defaultWorkingDirectory) : null;
  }

  createSession(input: CreateSessionInput): Session {
    const activeSegmentId = input.activeSegmentId ?? `segment:${input.id}:0`;
    const create = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sessions (id, title, working_directory, agent_id, active_segment_id, created_at, updated_at, metadata_json)
           VALUES (@id, @title, @workingDirectory, @agentId, @activeSegmentId, @createdAt, @updatedAt, '{}')`
        )
        .run({ ...input, activeSegmentId, agentId: input.agentId ?? "main" });
      this.db
        .prepare(
          `INSERT INTO context_segments
             (id, session_id, ordinal, previous_segment_id, status, created_at)
           VALUES (?, ?, 0, NULL, 'active', ?)`
        )
        .run(activeSegmentId, input.id, input.createdAt);
    });
    create.immediate();
    return this.getSession(input.id)!;
  }

  updateSession(id: string, input: UpdateSessionInput): Session | null {
    if (input.workingDirectory === undefined && input.agentId === undefined) {
      return this.getSession(id);
    }
    if (input.workingDirectory !== undefined && input.agentId !== undefined) {
      this.db
        .prepare("UPDATE sessions SET working_directory = ?, agent_id = ?, updated_at = MAX(updated_at, ?) WHERE id = ?")
        .run(input.workingDirectory, input.agentId, input.updatedAt, id);
    } else if (input.workingDirectory !== undefined) {
      this.db
        .prepare("UPDATE sessions SET working_directory = ?, updated_at = MAX(updated_at, ?) WHERE id = ?")
        .run(input.workingDirectory, input.updatedAt, id);
    } else {
      this.db
        .prepare("UPDATE sessions SET agent_id = ?, updated_at = MAX(updated_at, ?) WHERE id = ?")
        .run(input.agentId, input.updatedAt, id);
    }
    return this.getSession(id);
  }

  updateSessionWorkingDirectory(id: string, workingDirectory: string, updatedAt: string): Session | null {
    return this.updateSession(id, { workingDirectory, updatedAt });
  }

  listSessionsByAgentId(agentId: string): Session[] {
    const rows = this.db
      .prepare(
         `SELECT id, title, working_directory, agent_id, active_segment_id, created_at, updated_at
         FROM sessions
         WHERE agent_id = ?
         ORDER BY updated_at DESC, created_at DESC, id ASC`
      )
      .all(agentId) as SessionRow[];
    return rows.map((row) => rowToSession(row, this.defaultWorkingDirectory));
  }

  touchSession(id: string, updatedAt: string): void {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(updatedAt, id);
  }

  listContextSegments(sessionId: string): ContextSegment[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.segment_id = s.id) AS message_count
         FROM context_segments s WHERE s.session_id = ? ORDER BY s.ordinal ASC`
      )
      .all(sessionId) as ContextSegmentRow[];
    return rows.map(rowToContextSegment);
  }

  getContextSegment(id: string): ContextSegment | null {
    const row = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.segment_id = s.id) AS message_count
         FROM context_segments s WHERE s.id = ?`
      )
      .get(id) as ContextSegmentRow | undefined;
    return row ? rowToContextSegment(row) : null;
  }

  listContextArtifacts(sessionId: string): ContextArtifact[] {
    const rows = this.db
      .prepare("SELECT * FROM context_artifacts WHERE session_id = ? ORDER BY created_at ASC, id ASC")
      .all(sessionId) as ContextArtifactRow[];
    return rows.map(rowToContextArtifact);
  }

  getContextArtifact(id: string): ContextArtifact | null {
    const row = this.db.prepare("SELECT * FROM context_artifacts WHERE id = ?").get(id) as ContextArtifactRow | undefined;
    return row ? rowToContextArtifact(row) : null;
  }

  createContextArtifact(input: CreateContextArtifactInput): ContextArtifact {
    const targetSegmentId = input.targetSegmentId ?? null;
    const source = this.getContextSegment(input.sourceSegmentId);
    const target = targetSegmentId ? this.getContextSegment(targetSegmentId) : null;
    const previous = input.previousArtifactId ? this.getContextArtifact(input.previousArtifactId) : null;
    if (
      !source ||
      source.sessionId !== input.sessionId ||
      (targetSegmentId && (!target || target.sessionId !== input.sessionId)) ||
      (input.previousArtifactId && (!previous || previous.sessionId !== input.sessionId || previous.status !== "completed"))
    ) {
      throw new Error("Context artifact session/source/lineage invariant failed.");
    }
    this.insertContextArtifact({ ...input, targetSegmentId });
    return this.getContextArtifact(input.id)!;
  }

  rotateContextSegment(input: RotateContextSegmentInput): { segment: ContextSegment; artifact: ContextArtifact } | null {
    const rotate = this.db.transaction(() => {
      const session = this.db
        .prepare("SELECT active_segment_id FROM sessions WHERE id = ?")
        .get(input.sessionId) as { active_segment_id: string | null } | undefined;
      if (session?.active_segment_id !== input.expectedActiveSegmentId) {
        return null;
      }
      const activeRun = this.db
        .prepare(
          `SELECT id FROM runs WHERE session_id = ? AND status IN ('running', 'waiting_permission', 'waiting_children', 'cancelling')
           AND (? IS NULL OR id <> ?) LIMIT 1`
        )
        .get(input.sessionId, input.allowedActiveRunId ?? null, input.allowedActiveRunId ?? null) as { id: string } | undefined;
      if (activeRun) {
        return null;
      }
      const source = this.getContextSegment(input.expectedActiveSegmentId);
      if (!source || source.status !== "active" || source.sessionId !== input.sessionId) {
        return null;
      }
      if (
        input.artifact.sessionId !== input.sessionId ||
        input.artifact.sourceSegmentId !== source.id ||
        input.artifact.status !== "completed" ||
        input.artifact.previousArtifactId !== source.inheritedArtifactId ||
        input.artifact.targetSegmentId !== null
      ) {
        return null;
      }
      const sourceIds = input.artifact.sourceMessageIds;
      if (sourceIds.length === 0) {
        return null;
      }
      const categorizedSourceIds = input.artifact.sourceCategories.flatMap((category) => category.messageIds);
      if (
        !sameStringSet(sourceIds, categorizedSourceIds) ||
        input.artifact.sourceFirstMessageId !== sourceIds[0] ||
        input.artifact.sourceLastMessageId !== sourceIds[sourceIds.length - 1]
      ) return null;
      const placeholders = sourceIds.map(() => "?").join(", ");
      const sourceCount = (this.db
        .prepare(`SELECT COUNT(*) AS count FROM messages WHERE segment_id = ? AND id IN (${placeholders})`)
        .get(input.expectedActiveSegmentId, ...sourceIds) as { count: number }).count;
      if (sourceCount !== sourceIds.length) {
        return null;
      }
      const expectedMessageIds = [...sourceIds, ...input.preservedMessageIds];
      const currentMessageRows = this.db
        .prepare("SELECT id, run_id FROM messages WHERE session_id = ? AND segment_id = ?")
        .all(input.sessionId, input.expectedActiveSegmentId) as Array<{ id: string; run_id: string | null }>;
      if (
        new Set(expectedMessageIds).size !== expectedMessageIds.length ||
        !sameStringSet(expectedMessageIds, currentMessageRows.map((row) => row.id))
      ) {
        return null;
      }
      const expectedRunIds = [...input.sourceRunIds, ...input.preservedRunIds];
      const currentRunRows = this.db
        .prepare("SELECT id FROM runs WHERE session_id = ? AND segment_id = ?")
        .all(input.sessionId, input.expectedActiveSegmentId) as Array<{ id: string }>;
      if (
        new Set(expectedRunIds).size !== expectedRunIds.length ||
        !sameStringSet(expectedRunIds, currentRunRows.map((row) => row.id))
      ) {
        return null;
      }
      const sourceMessageSet = new Set(sourceIds);
      const preservedMessageSet = new Set(input.preservedMessageIds);
      const sourceRunSet = new Set(input.sourceRunIds);
      const preservedRunSet = new Set(input.preservedRunIds);
      for (const runId of expectedRunIds) {
        const runMessages = currentMessageRows.filter((row) => row.run_id === runId);
        if (runMessages.length === 0) {
          if (!preservedRunSet.has(runId)) return null;
          continue;
        }
        const hasSource = runMessages.some((row) => sourceMessageSet.has(row.id));
        const hasPreserved = runMessages.some((row) => preservedMessageSet.has(row.id));
        if (hasSource && hasPreserved) return null;
        if (hasSource !== sourceRunSet.has(runId) || hasPreserved !== preservedRunSet.has(runId)) return null;
      }
      this.db
        .prepare(
          `UPDATE context_segments SET status = 'sealed', first_message_id = ?, last_message_id = ?, sealed_at = ?
           WHERE id = ? AND status = 'active'`
        )
        .run(sourceIds[0], sourceIds[sourceIds.length - 1], input.rotatedAt, input.expectedActiveSegmentId);
      this.db
        .prepare(
          `INSERT INTO context_segments
             (id, session_id, ordinal, previous_segment_id, status, inherited_artifact_id, created_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)`
        )
        .run(
          input.newSegmentId,
          input.sessionId,
          source.ordinal + 1,
          source.id,
          input.artifact.id,
          input.rotatedAt
        );
      this.insertContextArtifact({ ...input.artifact, targetSegmentId: input.newSegmentId });
      if (input.preservedMessageIds.length > 0) {
        this.db
          .prepare(`UPDATE messages SET segment_id = ? WHERE id IN (${input.preservedMessageIds.map(() => "?").join(", ")})`)
          .run(input.newSegmentId, ...input.preservedMessageIds);
      }
      if (input.preservedRunIds.length > 0) {
        this.db
          .prepare(`UPDATE runs SET segment_id = ? WHERE id IN (${input.preservedRunIds.map(() => "?").join(", ")})`)
          .run(input.newSegmentId, ...input.preservedRunIds);
      }
      const updated = this.db
        .prepare("UPDATE sessions SET active_segment_id = ?, updated_at = ? WHERE id = ? AND active_segment_id = ?")
        .run(input.newSegmentId, input.rotatedAt, input.sessionId, input.expectedActiveSegmentId);
      if (updated.changes !== 1) {
        throw new Error("Context segment rotation lost its session CAS.");
      }
      return { segment: this.getContextSegment(input.newSegmentId)!, artifact: this.getContextArtifact(input.artifact.id)! };
    });
    return rotate.immediate();
  }

  replaceInheritedContextArtifact(
    input: ReplaceInheritedContextArtifactInput
  ): { segment: ContextSegment; artifact: ContextArtifact } | null {
    const replace = this.db.transaction(() => {
      const session = this.db.prepare("SELECT active_segment_id FROM sessions WHERE id = ?").get(input.sessionId) as
        | { active_segment_id: string | null }
        | undefined;
      const segment = this.getContextSegment(input.expectedActiveSegmentId);
      const previous = this.getContextArtifact(input.expectedArtifactId);
      if (
        session?.active_segment_id !== input.expectedActiveSegmentId ||
        !segment ||
        segment.sessionId !== input.sessionId ||
        segment.status !== "active" ||
        segment.inheritedArtifactId !== input.expectedArtifactId ||
        !previous ||
        previous.status !== "completed" ||
        previous.targetSegmentId !== segment.id
      ) return null;
      if (
        input.artifact.sessionId !== input.sessionId ||
        input.artifact.status !== "completed" ||
        input.artifact.previousArtifactId !== previous.id ||
        input.artifact.sourceSegmentId !== previous.sourceSegmentId ||
        input.artifact.targetSegmentId !== segment.id ||
        !sameStringSet(input.artifact.sourceMessageIds, previous.sourceMessageIds) ||
        input.artifact.sourceFirstMessageId !== previous.sourceFirstMessageId ||
        input.artifact.sourceLastMessageId !== previous.sourceLastMessageId ||
        input.artifact.sourceCategories.length !== 1 ||
        input.artifact.sourceCategories[0]?.category !== "summary_recovery" ||
        !sameStringSet(input.artifact.sourceCategories[0].messageIds, previous.sourceMessageIds)
      ) return null;
      this.insertContextArtifact(input.artifact);
      const updated = this.db
        .prepare(
          `UPDATE context_segments SET inherited_artifact_id = ?
           WHERE id = ? AND session_id = ? AND status = 'active' AND inherited_artifact_id = ?`
        )
        .run(input.artifact.id, segment.id, input.sessionId, previous.id);
      if (updated.changes !== 1) throw new Error("Inherited context artifact CAS was lost.");
      this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ? AND active_segment_id = ?")
        .run(input.updatedAt, input.sessionId, segment.id);
      return { segment: this.getContextSegment(segment.id)!, artifact: this.getContextArtifact(input.artifact.id)! };
    });
    return replace.immediate();
  }

  listMessagesBySegment(segmentId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.session_id, m.run_id, m.segment_id, m.role, m.status, m.created_at, m.updated_at, m.metadata_json,
            r.error AS run_error
         FROM messages m
         LEFT JOIN runs r ON r.id = m.run_id
         WHERE m.segment_id = ?
         ORDER BY m.created_at ASC,
           CASE m.role WHEN 'system' THEN 0 WHEN 'user' THEN 1 WHEN 'assistant' THEN 2 ELSE 3 END,
           m.id ASC`
      )
      .all(segmentId) as MessageRow[];
    if (rows.length === 0) {
      return [];
    }
    const partsByMessage = this.getPartsByMessageIds(rows.map((row) => row.id));
    return rows.map((row) => rowToMessage(row, partsByMessage.get(row.id) ?? []));
  }

  private insertContextArtifact(input: ContextArtifact): void {
    this.db
      .prepare(
        `INSERT INTO context_artifacts (
           id, kind, session_id, source_segment_id, target_segment_id, previous_artifact_id,
           source_message_ids_json, source_categories_json, source_first_message_id, source_last_message_id, summary,
           strategy_version, estimator_version, estimated_tokens_before, estimated_tokens_after,
           resolved_window_tokens, window_source, status, provider_profile_id, model, usage_json, error, created_at
         ) VALUES (
           @id, @kind, @sessionId, @sourceSegmentId, @targetSegmentId, @previousArtifactId,
           @sourceMessageIdsJson, @sourceCategoriesJson, @sourceFirstMessageId, @sourceLastMessageId, @summary,
           @strategyVersion, @estimatorVersion, @estimatedTokensBefore, @estimatedTokensAfter,
           @resolvedWindowTokens, @windowSource, @status, @providerProfileId, @model, @usageJson, @error, @createdAt
         )`
      )
      .run({
        ...input,
        sourceMessageIdsJson: JSON.stringify(input.sourceMessageIds),
        sourceCategoriesJson: JSON.stringify(input.sourceCategories),
        usageJson: JSON.stringify(input.usage ?? {})
      });
  }

  createRun(input: CreateRunInput): Run {
    if (input.status !== "running") {
      throw new Error("Runs must be created in the running state.");
    }
    const segmentId = input.segmentId ?? this.getSession(input.sessionId)?.activeSegmentId;
    if (!segmentId) {
      throw new Error(`Session '${input.sessionId}' has no active context segment.`);
    }
    const create = this.db.transaction(() => {
      const sessionRow = this.db
        .prepare("SELECT active_segment_id FROM sessions WHERE id = ?")
        .get(input.sessionId) as { active_segment_id: string | null } | undefined;
      const expectedSegmentId = input.expectedActiveSegmentId ?? segmentId;
      const segmentRow = this.db
        .prepare("SELECT session_id, status FROM context_segments WHERE id = ?")
        .get(expectedSegmentId) as { session_id: string; status: string } | undefined;
      if (
        sessionRow?.active_segment_id !== expectedSegmentId ||
        !segmentRow ||
        segmentRow.session_id !== input.sessionId ||
        segmentRow.status !== "active"
      ) {
        throw new ContextSegmentChangedStoreError(input.sessionId, expectedSegmentId, sessionRow?.active_segment_id ?? null);
      }
      const delegation = this.subsessions.forRun(input.id);
      if (delegation) {
        const parent = this.getRun(delegation.parentRunId);
        if (delegation.childSessionId !== input.sessionId || !parent || !(parent.status === "running" || new RunVO.Status(parent.status).isWaiting())) {
          throw new Error('Child admission lost its owning parent run.');
        }
        const admitted = this.getRun(input.id);
        if (admitted?.status !== "running" || admitted.metadata.admissionPending !== true) {
          throw new Error("Child admission was cancelled or already executed.");
        }
        this.db.prepare("UPDATE runs SET provider=?,metadata_json=?,updated_at=? WHERE id=? AND status='running'")
          .run(input.provider,JSON.stringify(input.metadata ?? {}),input.updatedAt,input.id);
        return;
      }
      const activeRow = this.db
        .prepare(
          `SELECT id, session_id, segment_id, provider, status, created_at, updated_at, error, metadata_json
           FROM runs
           WHERE session_id = ? AND status IN ('running', 'waiting_permission', 'waiting_children', 'cancelling')
           ORDER BY updated_at DESC, created_at DESC, id DESC
           LIMIT 1`
        )
        .get(input.sessionId) as RunRow | undefined;
      if (activeRow) {
        throw new ActiveRunExistsStoreError(rowToRun(activeRow));
      }

      this.db
        .prepare(
          `INSERT INTO runs (id, session_id, segment_id, provider, status, created_at, updated_at, error, metadata_json)
           VALUES (@id, @sessionId, @segmentId, @provider, @status, @createdAt, @updatedAt, @error, @metadataJson)`
        )
        .run({ ...input, segmentId: expectedSegmentId, error: input.error ?? null, metadataJson: JSON.stringify(input.metadata ?? {}) });
    });
    create.immediate();
    return this.getRun(input.id)!;
  }

  getRun(id: string): Run | null {
    const row = this.db
      .prepare("SELECT id, session_id, segment_id, provider, status, created_at, updated_at, error, metadata_json FROM runs WHERE id = ?")
      .get(id) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  listRuns(filter: ListRunsFilter = {}): Run[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.sessionId) {
      clauses.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter.statuses) {
      if (filter.statuses.length === 0) {
        return [];
      }
      clauses.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      params.push(...filter.statuses);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, session_id, segment_id, provider, status, created_at, updated_at, error, metadata_json
         FROM runs
         ${where}
         ORDER BY created_at ASC, id ASC`
      )
      .all(...params) as RunRow[];
    return rows.map(rowToRun);
  }

  transitionRunStatus(
    id: string,
    expectedStatuses: readonly RunType.Status[],
    status: RunType.ActiveStatus,
    error: string | null,
    updatedAt: string
  ): Run | null {
    if (!new RunVO.Status(status).isActive()) {
      throw new Error(`Terminal run status '${status}' must be written through finalizeRun().`);
    }
    assertValidRunTransition(expectedStatuses, status);
    if (expectedStatuses.length === 0) {
      return null;
    }

    const placeholders = expectedStatuses.map(() => "?").join(", ");
    const result = this.db
      .prepare(`UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`)
      .run(status, error, updatedAt, id, ...expectedStatuses);
    return result.changes === 1 ? this.getRun(id) : null;
  }

  requestRunCancellation(input: RequestRunCancellationInput): RunCancellationResult | null {
    const requestCancellation = this.db.transaction((): RunCancellationResult | null => {
      const current = this.getRun(input.runId);
      if (!current || new RunVO.Status(current.status).isTerminal()) {
        return null;
      }

      let event: RunEvent | null = null;
      if (current.status !== "cancelling") {
        const transitioned = this.transitionRunStatus(input.runId, [current.status], "cancelling", null, input.updatedAt);
        if (!transitioned) {
          return null;
        }
        event = this.insertEvent({
          ...input.event,
          runId: input.runId,
          sessionId: current.sessionId,
          createdAt: input.updatedAt
        });
      }

      const expiredPermissionRequests = this.expirePendingPermissionsForRun(input.runId, input.updatedAt);
      this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(input.updatedAt, current.sessionId);

      return {
        run: this.getRun(input.runId)!,
        expiredPermissionRequests,
        event
      };
    });

    return requestCancellation();
  }

  finalizeRun(input: FinalizeRunInput): FinalizeRunResult | null {
    assertValidRunTransition(input.expectedStatuses, input.status);
    assertMatchingTerminalEvent(input.status, input.event.type);
    if (input.expectedStatuses.length === 0) {
      return null;
    }

    const finalize = this.db.transaction((): RunEvent | null => {
      if (input.status === "completed" && this.subsessions.list(input.runId).some((item) => item.result === null || !item.acknowledged)) return null;
      const placeholders = input.expectedStatuses.map(() => "?").join(", ");
      const runUpdate = this.db
        .prepare(`UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`)
        .run(input.status, input.error, input.updatedAt, input.runId, ...input.expectedStatuses);
      if (runUpdate.changes !== 1) {
        return null;
      }

      const run = this.getRun(input.runId)!;
      this.expirePendingPermissionsForRun(input.runId, input.updatedAt);
      this.cancelActiveToolCallPartsForRun(input.runId, input.updatedAt);
      const messageRows = this.db
        .prepare(
          `SELECT id, metadata_json
           FROM messages
           WHERE run_id = ? AND role = 'assistant' AND status = 'streaming'
           ORDER BY created_at ASC, id ASC`
        )
        .all(input.runId) as Array<{ id: string; metadata_json: string }>;
      for (const messageRow of messageRows) {
        const metadata = parseJsonObject(messageRow.metadata_json);
        if (input.error) {
          metadata.error = input.error;
        } else {
          delete metadata.error;
        }
        this.db
          .prepare("UPDATE messages SET status = ?, updated_at = ?, metadata_json = ? WHERE id = ? AND status = 'streaming'")
          .run(input.status, input.updatedAt, JSON.stringify(metadata), messageRow.id);
      }

      this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(input.updatedAt, run.sessionId);
      const event = this.insertEvent({
        ...input.event,
        runId: run.id,
        sessionId: run.sessionId,
        createdAt: input.updatedAt
      });
      this.subsessions.reconcile();
      return event;
    });

    const result = finalize();
    if (!result) {
      return null;
    }
    const run = this.getRun(input.runId)!;
    return {
      run,
      event: result
    };
  }

  expirePendingPermissionsForTerminalRuns(updatedAt: string): number {
    const expire = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT p.run_id
           FROM permission_requests p
           INNER JOIN runs r ON r.id = p.run_id
           WHERE p.status = 'pending' AND r.status IN ('completed', 'failed', 'cancelled', 'interrupted')`
        )
        .all() as Array<{ run_id: string }>;
      let expiredCount = 0;
      for (const row of rows) {
        expiredCount += this.expirePendingPermissionsForRun(row.run_id, updatedAt).length;
      }
      return expiredCount;
    });
    return expire();
  }

  mergeRunMetadata(id: string, metadata: JsonObject, updatedAt: string): void {
    const row = this.db.prepare("SELECT metadata_json FROM runs WHERE id = ?").get(id) as { metadata_json: string } | undefined;
    const nextMetadata = { ...parseJsonObject(row?.metadata_json), ...metadata };
    this.db.prepare("UPDATE runs SET metadata_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(nextMetadata), updatedAt, id);
  }

  listMessages(sessionId: string): Message[] {
    const rows = this.db
      .prepare(
         `SELECT m.id, m.session_id, m.run_id, m.segment_id, m.role, m.status, m.created_at, m.updated_at, m.metadata_json,
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
         `SELECT m.id, m.session_id, m.run_id, m.segment_id, m.role, m.status, m.created_at, m.updated_at, m.metadata_json,
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
         `SELECT m.id, m.session_id, m.run_id, m.segment_id, m.role, m.status, m.created_at, m.updated_at, m.metadata_json,
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
    const segmentId = input.segmentId ?? this.getSession(input.sessionId)?.activeSegmentId;
    if (!segmentId) {
      throw new Error(`Session '${input.sessionId}' has no active context segment.`);
    }
    const create = this.db.transaction(() => {
      const segment = this.db
        .prepare("SELECT session_id, status FROM context_segments WHERE id = ?")
        .get(segmentId) as { session_id: string; status: string } | undefined;
      const session = this.db.prepare("SELECT active_segment_id FROM sessions WHERE id = ?").get(input.sessionId) as
        | { active_segment_id: string | null }
        | undefined;
      const run = input.runId
        ? (this.db.prepare("SELECT session_id, segment_id FROM runs WHERE id = ?").get(input.runId) as
            | { session_id: string; segment_id: string }
            | undefined)
        : null;
      if (
        !segment ||
        segment.session_id !== input.sessionId ||
        segment.status !== "active" ||
        session?.active_segment_id !== segmentId ||
        (input.runId && (!run || run.session_id !== input.sessionId || run.segment_id !== segmentId))
      ) {
        throw new ContextSegmentChangedStoreError(input.sessionId, segmentId, session?.active_segment_id ?? null);
      }
      this.db
        .prepare(
          `INSERT INTO messages (id, session_id, run_id, segment_id, role, status, created_at, updated_at, metadata_json)
           VALUES (@id, @sessionId, @runId, @segmentId, @role, @status, @createdAt, @updatedAt, @metadataJson)`
        )
        .run({ ...input, segmentId, runId: input.runId ?? null, metadataJson: JSON.stringify(input.metadata ?? {}) });
    });
    create.immediate();
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

  transitionMessageStatus(
    id: string,
    expectedStatuses: readonly MessageType.Status[],
    status: MessageType.Status,
    updatedAt: string,
    error?: string | null
  ): Message | null {
    if (expectedStatuses.length === 0) {
      return null;
    }

    const placeholders = expectedStatuses.map(() => "?").join(", ");
    if (error !== undefined) {
      const row = this.db.prepare("SELECT metadata_json FROM messages WHERE id = ?").get(id) as { metadata_json: string } | undefined;
      const metadata = parseJsonObject(row?.metadata_json);
      if (error) {
        metadata.error = error;
      } else {
        delete metadata.error;
      }
      const result = this.db
        .prepare(`UPDATE messages SET status = ?, updated_at = ?, metadata_json = ? WHERE id = ? AND status IN (${placeholders})`)
        .run(status, updatedAt, JSON.stringify(metadata), id, ...expectedStatuses);
      return result.changes === 1 ? this.getMessage(id) : null;
    }

    const result = this.db
      .prepare(`UPDATE messages SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`)
      .run(status, updatedAt, id, ...expectedStatuses);
    return result.changes === 1 ? this.getMessage(id) : null;
  }

  mergeMessageMetadata(id: string, metadata: JsonObject, updatedAt: string): void {
    const row = this.db.prepare("SELECT metadata_json FROM messages WHERE id = ?").get(id) as { metadata_json: string } | undefined;
    const nextMetadata = { ...parseJsonObject(row?.metadata_json), ...metadata };
    this.db.prepare("UPDATE messages SET metadata_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(nextMetadata), updatedAt, id);
  }

  appendEvent(input: AppendEventInput): RunEvent {
    const append = this.db.transaction(() => {
      if (isTerminalRunEventType(input.type)) {
        throw new Error(`Terminal event '${input.type}' must be written through finalizeRun().`);
      }
      const run = this.getRun(input.runId);
      if (!run || !new RunVO.Status(run.status).isActive()) {
        throw new Error(`Cannot append non-terminal event '${input.type}' to inactive run '${input.runId}'.`);
      }
      return this.insertEvent(input);
    });

    return append();
  }

  listEvents(runId: string, after = 0): RunEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, session_id, seq, type, created_at, payload_json
         FROM events
         WHERE run_id = ? AND seq > ?
         ORDER BY seq ASC`
      )
      .all(runId, after) as EventRow[];
    return rows.map(rowToEvent);
  }

  getLatestEventSeq(runId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?").get(runId) as { seq: number };
    return row.seq;
  }

  listAgentDefinitions(): AgentDefinition[] {
    const rows = this.db
      .prepare(
        `SELECT id, revision, name, description, system_prompt, model_profile_id, default_run_options_json, context_policy_json,
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
        `SELECT id, revision, name, description, system_prompt, model_profile_id, default_run_options_json, context_policy_json,
                skill_ids_json, tool_ids_json, metadata_json, created_at, updated_at
         FROM agent_definitions
         WHERE id = ?`
      )
      .get(id) as AgentDefinitionRow | undefined;
    return row ? rowToAgentDefinition(row) : null;
  }

  createAgentDefinition(input: CreateAgentDefinitionInput): AgentDefinition {
    this.db
      .prepare(
        `INSERT INTO agent_definitions (
           id, revision, name, description, system_prompt, model_profile_id, default_run_options_json, context_policy_json,
           skill_ids_json, tool_ids_json, metadata_json, created_at, updated_at
         ) VALUES (
           @id, 1, @name, @description, @systemPrompt, @modelProfileId, @defaultRunOptionsJson, @contextPolicyJson,
           @skillIdsJson, @toolIdsJson, @metadataJson, @createdAt, @updatedAt
         )`
      )
      .run({
        ...input,
        defaultRunOptionsJson: JSON.stringify(runOptionsToJsonObject(input.defaultRunOptions ?? {})),
        contextPolicyJson: JSON.stringify(input.contextPolicy ?? {}),
        skillIdsJson: JSON.stringify(input.skillIds),
        toolIdsJson: JSON.stringify(input.toolIds),
        metadataJson: JSON.stringify(input.metadata ?? {})
      });
    return this.getAgentDefinition(input.id)!;
  }

  cloneAgentDefinition(input: CloneAgentDefinitionInput): CloneAgentDefinitionResult {
    const clone = this.db.transaction((): CloneAgentDefinitionResult => {
      const source = this.getAgentDefinition(input.sourceId);
      if (!source) {
        return { status: "not_found" };
      }
      if (source.revision !== input.expectedSourceRevision) {
        return { status: "revision_conflict", agent: source };
      }
      const { sourceId: _sourceId, expectedSourceRevision: _expectedSourceRevision, ...createInput } = input;
      return { status: "created", agent: this.createAgentDefinition(createInput) };
    });
    return clone.immediate();
  }

  updateAgentDefinition(input: UpdateAgentDefinitionInput): UpdateAgentDefinitionResult {
    const update = this.db.transaction((): UpdateAgentDefinitionResult => {
      const current = this.getAgentDefinition(input.id);
      if (!current) {
        return { status: "not_found" };
      }
      if (current.revision !== input.expectedRevision) {
        return { status: "revision_conflict", agent: current };
      }

      const next: AgentDefinition = {
        ...current,
        name: input.name ?? current.name,
        description: input.description !== undefined ? input.description : current.description,
        systemPrompt: input.systemPrompt ?? current.systemPrompt,
        modelProfileId: input.modelProfileId !== undefined ? input.modelProfileId : current.modelProfileId,
        defaultRunOptions: input.defaultRunOptions !== undefined ? input.defaultRunOptions : current.defaultRunOptions,
        contextPolicy: input.contextPolicy !== undefined ? input.contextPolicy : current.contextPolicy,
        skillIds: input.skillIds ?? current.skillIds,
        toolIds: input.toolIds ?? current.toolIds,
        metadata: input.metadata ?? current.metadata,
        revision: current.revision + 1,
        updatedAt: input.updatedAt
      };
      if (sameMutableAgentDefinition(current, next)) {
        return { status: "unchanged", agent: current };
      }

      const result = this.db
        .prepare(
          `UPDATE agent_definitions
           SET name = @name,
               revision = @revision,
               description = @description,
               system_prompt = @systemPrompt,
               model_profile_id = @modelProfileId,
               default_run_options_json = @defaultRunOptionsJson,
               context_policy_json = @contextPolicyJson,
               skill_ids_json = @skillIdsJson,
               tool_ids_json = @toolIdsJson,
               metadata_json = @metadataJson,
               updated_at = @updatedAt
           WHERE id = @id AND revision = @expectedRevision`
        )
        .run({
          id: next.id,
          expectedRevision: input.expectedRevision,
          revision: next.revision,
          name: next.name,
          description: next.description,
          systemPrompt: next.systemPrompt,
          modelProfileId: next.modelProfileId,
          defaultRunOptionsJson: JSON.stringify(runOptionsToJsonObject(next.defaultRunOptions ?? {})),
          contextPolicyJson: JSON.stringify(next.contextPolicy ?? {}),
          skillIdsJson: JSON.stringify(next.skillIds),
          toolIdsJson: JSON.stringify(next.toolIds),
          metadataJson: JSON.stringify(next.metadata),
          updatedAt: next.updatedAt
        });
      if (result.changes !== 1) {
        const latest = this.getAgentDefinition(input.id);
        return latest ? { status: "revision_conflict", agent: latest } : { status: "not_found" };
      }
      return { status: "updated", agent: this.getAgentDefinition(input.id)! };
    });
    return update.immediate();
  }

  deleteAgentDefinitionIfUnused(id: string, expectedRevision: number): DeleteAgentDefinitionResult {
    const remove = this.db.transaction((): DeleteAgentDefinitionResult => {
      const agent = this.getAgentDefinition(id);
      if (!agent) {
        return { status: "not_found" };
      }
      if (agent.revision !== expectedRevision) {
        return { status: "revision_conflict", agent };
      }
      const sessions = this.listSessionsByAgentId(id);
      if (sessions.length > 0) {
        return { status: "in_use", agent, sessions };
      }
      const result = this.db.prepare("DELETE FROM agent_definitions WHERE id = ? AND revision = ?").run(id, expectedRevision);
      if (result.changes !== 1) {
        const latest = this.getAgentDefinition(id);
        return latest ? { status: "revision_conflict", agent: latest } : { status: "not_found" };
      }
      return { status: "deleted" };
    });
    return remove.immediate();
  }

  createPermissionRequest(input: CreatePermissionRequestInput): StoredPermissionRequest {
    const create = this.db.transaction(() => {
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

      if (new PermissionRequestVO.Status(input.status).isPending()) {
        const runUpdate = this.db
          .prepare("UPDATE runs SET status = 'waiting_permission', error = NULL, updated_at = ? WHERE id = ? AND status = 'running'")
          .run(input.updatedAt, input.runId);
        if (runUpdate.changes !== 1) {
          throw new Error(`Cannot create pending permission for inactive run '${input.runId}'.`);
        }
      }
    });

    create();
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

    const rows = this.permissionRequestRows(clauses.join(" AND "), params);
    return rows.map(rowToPermissionRequest);
  }

  resolvePermissionRequest(
    id: string,
    status: PermissionRequestType.ResolvedStatus,
    resolvedAt: string
  ): StoredPermissionRequest | null {
    const resolveRequest = this.db.transaction((): StoredPermissionRequest | null => {
      const request = this.getPermissionRequest(id);
      if (!request || !new PermissionRequestVO.Status(request.status).isPending()) {
        return null;
      }

      const runUpdate = this.db
        .prepare("UPDATE runs SET status = 'running', error = NULL, updated_at = ? WHERE id = ? AND status = 'waiting_permission'")
        .run(resolvedAt, request.runId);
      if (runUpdate.changes !== 1) {
        return null;
      }

      const requestUpdate = this.db
        .prepare(
          `UPDATE permission_requests
           SET status = ?, resolved_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(status, resolvedAt, resolvedAt, id);
      if (requestUpdate.changes !== 1) {
        throw new Error(`Permission request '${id}' changed while it was being resolved.`);
      }
      return this.getPermissionRequest(id);
    });

    return resolveRequest();
  }

  getDaemonLease(): DaemonLeaseRecord | null {
    const row = this.db
      .prepare("SELECT owner_id, pid, acquired_at, heartbeat_at FROM daemon_lease WHERE lease_key = 1")
      .get() as DaemonLeaseRow | undefined;
    return row ? rowToDaemonLease(row) : null;
  }

  createDaemonLease(input: DaemonLeaseRecord): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO daemon_lease (lease_key, owner_id, pid, acquired_at, heartbeat_at)
         VALUES (1, @ownerId, @pid, @acquiredAt, @heartbeatAt)
         ON CONFLICT(lease_key) DO NOTHING`
      )
      .run(input);
    return result.changes === 1;
  }

  takeOverDaemonLease(expectedOwnerId: string, expectedHeartbeatAt: string, input: DaemonLeaseRecord): boolean {
    const result = this.db
      .prepare(
        `UPDATE daemon_lease
         SET owner_id = @ownerId, pid = @pid, acquired_at = @acquiredAt, heartbeat_at = @heartbeatAt
         WHERE lease_key = 1 AND owner_id = @expectedOwnerId AND heartbeat_at = @expectedHeartbeatAt`
      )
      .run({ ...input, expectedOwnerId, expectedHeartbeatAt });
    return result.changes === 1;
  }

  heartbeatDaemonLease(ownerId: string, pid: number, heartbeatAt: string): boolean {
    const result = this.db
      .prepare("UPDATE daemon_lease SET heartbeat_at = ? WHERE lease_key = 1 AND owner_id = ? AND pid = ?")
      .run(heartbeatAt, ownerId, pid);
    return result.changes === 1;
  }

  releaseDaemonLease(ownerId: string): boolean {
    return this.db.prepare("DELETE FROM daemon_lease WHERE lease_key = 1 AND owner_id = ?").run(ownerId).changes === 1;
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
        working_directory TEXT,
        agent_id TEXT NOT NULL DEFAULT 'main',
        active_segment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        segment_id TEXT,
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
        segment_id TEXT,
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

      CREATE TABLE IF NOT EXISTS context_segments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        previous_segment_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'sealed')),
        first_message_id TEXT,
        last_message_id TEXT,
        inherited_artifact_id TEXT,
        created_at TEXT NOT NULL,
        sealed_at TEXT,
        UNIQUE(session_id, ordinal),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (previous_segment_id) REFERENCES context_segments(id)
      );

      CREATE TABLE IF NOT EXISTS context_artifacts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind = 'compaction'),
        session_id TEXT NOT NULL,
        source_segment_id TEXT NOT NULL,
        target_segment_id TEXT,
        previous_artifact_id TEXT,
        source_message_ids_json TEXT NOT NULL,
        source_categories_json TEXT NOT NULL DEFAULT '[]',
        source_first_message_id TEXT,
        source_last_message_id TEXT,
        summary TEXT NOT NULL,
        strategy_version TEXT NOT NULL,
        estimator_version TEXT NOT NULL,
        estimated_tokens_before INTEGER NOT NULL,
        estimated_tokens_after INTEGER NOT NULL,
        resolved_window_tokens INTEGER NOT NULL,
        window_source TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
        provider_profile_id TEXT,
        model TEXT,
        usage_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (source_segment_id) REFERENCES context_segments(id),
        FOREIGN KEY (target_segment_id) REFERENCES context_segments(id),
        FOREIGN KEY (previous_artifact_id) REFERENCES context_artifacts(id)
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

      CREATE TABLE IF NOT EXISTS daemon_lease (
        lease_key INTEGER PRIMARY KEY CHECK (lease_key = 1),
        owner_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
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
        revision INTEGER NOT NULL DEFAULT 1,
        name TEXT NOT NULL,
        description TEXT,
        system_prompt TEXT NOT NULL,
        model_profile_id TEXT,
        default_run_options_json TEXT NOT NULL DEFAULT '{}',
        context_policy_json TEXT NOT NULL DEFAULT '{}',
        skill_ids_json TEXT NOT NULL DEFAULT '[]',
        tool_ids_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_context_segments_one_active ON context_segments(session_id) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_context_artifacts_session ON context_artifacts(session_id, created_at);
    `);
    this.ensureSessionWorkingDirectoryColumn();
    this.ensureSessionAgentIdColumn();
    this.ensureMessagePartStructuredColumns();
    this.ensureAgentRevisionColumn();
    this.ensureAgentContextPolicyColumn();
    this.ensureContextSegmentColumnsAndBackfill();
    this.ensureContextArtifactCategoryColumn();
    this.seedDefaultAgents();
    this.migrateMainAgentExplicitToolAllowlist();
    this.migrateMainDelegationDefault();
    this.ensureAgentReferenceTriggers();
  }

  private ensureContextSegmentColumnsAndBackfill(): void {
    const sessionColumns = new Set(
      (this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    if (!sessionColumns.has("active_segment_id")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN active_segment_id TEXT");
    }
    const messageColumns = new Set(
      (this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    if (!messageColumns.has("segment_id")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN segment_id TEXT");
    }
    const runColumns = new Set(
      (this.db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    if (!runColumns.has("segment_id")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN segment_id TEXT");
    }
    const backfill = this.db.transaction(() => {
      const sessions = this.db.prepare("SELECT id, created_at FROM sessions WHERE active_segment_id IS NULL OR trim(active_segment_id) = ''").all() as Array<{
        id: string;
        created_at: string;
      }>;
      for (const session of sessions) {
        const segmentId = `segment:${session.id}:0`;
        this.db
          .prepare(
            `INSERT OR IGNORE INTO context_segments (id, session_id, ordinal, status, created_at)
             VALUES (?, ?, 0, 'active', ?)`
          )
          .run(segmentId, session.id, session.created_at);
        this.db.prepare("UPDATE sessions SET active_segment_id = ? WHERE id = ?").run(segmentId, session.id);
      }
      this.db
        .prepare("UPDATE messages SET segment_id = (SELECT active_segment_id FROM sessions WHERE sessions.id = messages.session_id) WHERE segment_id IS NULL")
        .run();
      this.db
        .prepare("UPDATE runs SET segment_id = (SELECT active_segment_id FROM sessions WHERE sessions.id = runs.session_id) WHERE segment_id IS NULL")
        .run();
    });
    backfill.immediate();
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_messages_segment ON messages(segment_id, created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_runs_segment ON runs(segment_id, created_at)");
  }

  private ensureContextArtifactCategoryColumn(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(context_artifacts)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    if (!columns.has("source_categories_json")) {
      this.db.exec("ALTER TABLE context_artifacts ADD COLUMN source_categories_json TEXT NOT NULL DEFAULT '[]'");
    }
  }

  private ensureSessionAgentIdColumn(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("agent_id")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'");
    }
    this.db
      .prepare("UPDATE sessions SET agent_id = CASE WHEN agent_id IS NULL OR trim(agent_id) = '' THEN 'main' ELSE trim(agent_id) END")
      .run();
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id, updated_at)");
  }

  private ensureSessionWorkingDirectoryColumn(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((column) => column.name));

    if (!columns.has("working_directory")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN working_directory TEXT");
    }

    this.db
      .prepare("UPDATE sessions SET working_directory = ? WHERE working_directory IS NULL OR trim(working_directory) = ''")
      .run(this.defaultWorkingDirectory);
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

  private ensureAgentRevisionColumn(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(agent_definitions)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    if (!columns.has("revision")) {
      this.db.exec("ALTER TABLE agent_definitions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    }
    this.db.prepare("UPDATE agent_definitions SET revision = 1 WHERE revision IS NULL OR revision < 1").run();
  }

  private ensureAgentContextPolicyColumn(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(agent_definitions)").all() as Array<{ name: string }>).map((column) => column.name)
    );
    if (!columns.has("context_policy_json")) {
      this.db.exec("ALTER TABLE agent_definitions ADD COLUMN context_policy_json TEXT NOT NULL DEFAULT '{}'");
    }
  }

  private seedDefaultAgents(): void {
    const now = new Date().toISOString();
    const defaultMainAgentToolIdsJson = JSON.stringify(defaultMainAgentToolIds);
    this.db
      .prepare(
        `INSERT INTO agent_definitions (
           id, revision, name, description, system_prompt, model_profile_id, default_run_options_json, context_policy_json,
           skill_ids_json, tool_ids_json, metadata_json, created_at, updated_at
         )
          VALUES (@id, 1, @name, @description, @systemPrompt, NULL, '{}', '{}', '[]', @toolIdsJson, @metadataJson, @createdAt, @updatedAt)
          ON CONFLICT(id) DO NOTHING`
      )
      .run({
        id: "main",
        name: "Mango",
        description: "Default main assistant agent.",
        systemPrompt: "You are Mango, a helpful local assistant. Be concise, safe, and ask clarifying questions when requirements are unclear.",
        toolIdsJson: defaultMainAgentToolIdsJson,
        metadataJson: JSON.stringify({ builtin: true, version: 1 }),
        createdAt: now,
        updatedAt: now
      });
  }

  private migrateMainAgentExplicitToolAllowlist(): void {
    const migrationName = "agent_main_explicit_tool_allowlist_v1";
    const migrate = this.db.transaction(() => {
      const applied = this.db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(migrationName);
      if (applied) {
        return;
      }
      const row = this.db.prepare("SELECT revision, tool_ids_json, metadata_json FROM agent_definitions WHERE id = ?").get("main") as
        | Pick<AgentDefinitionRow, "revision" | "tool_ids_json" | "metadata_json">
        | undefined;
      const appliedAt = new Date().toISOString();
      if (row) {
        const metadata = parseJsonObject(row.metadata_json);
        const legacyMetadataMarkerWasApplied = metadata.explicitToolAllowlistVersion === 1;
        delete metadata.explicitToolAllowlistVersion;
        this.db
          .prepare("UPDATE agent_definitions SET tool_ids_json = ?, metadata_json = ? WHERE id = ?")
          .run(
            legacyMetadataMarkerWasApplied || row.revision > 1 || parseStringArray(row.tool_ids_json).length > 0
              ? row.tool_ids_json
              : JSON.stringify(defaultMainAgentToolIds),
            JSON.stringify(metadata),
            "main"
          );
      }
      this.db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(migrationName, appliedAt);
    });
    migrate.immediate();
  }

  private migrateMainDelegationDefault(): void {
    this.db.transaction(() => {
      const name = "main_subsession_default_v1";
      if (this.db.prepare("SELECT 1 FROM schema_migrations WHERE name=?").get(name)) return;
      const row = this.db.prepare("SELECT tool_ids_json FROM agent_definitions WHERE id='main'").get() as { tool_ids_json: string } | undefined;
      // Revision records all profile edits, not which tool list was explicitly chosen.
      // Only the exact old default is eligible; empty/custom lists and other profiles are preserved.
      if (row && isDeepStrictEqual(parseStringArray(row.tool_ids_json), ["shell.exec"])) {
        this.db.prepare("UPDATE agent_definitions SET tool_ids_json=?,revision=revision+1,updated_at=? WHERE id='main'")
          .run(JSON.stringify(defaultMainAgentToolIds),new Date().toISOString());
      }
      this.db.prepare("INSERT INTO schema_migrations(name,applied_at) VALUES (?,?)").run(name,new Date().toISOString());
    }).immediate();
  }

  private ensureAgentReferenceTriggers(): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET agent_id = 'main'
         WHERE NOT EXISTS (SELECT 1 FROM agent_definitions WHERE agent_definitions.id = sessions.agent_id)`
      )
      .run();
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS sessions_agent_insert_guard
      BEFORE INSERT ON sessions
      WHEN NOT EXISTS (SELECT 1 FROM agent_definitions WHERE id = NEW.agent_id)
      BEGIN
        SELECT RAISE(ABORT, 'session_agent_not_found');
      END;

      CREATE TRIGGER IF NOT EXISTS sessions_agent_update_guard
      BEFORE UPDATE OF agent_id ON sessions
      WHEN NOT EXISTS (SELECT 1 FROM agent_definitions WHERE id = NEW.agent_id)
      BEGIN
        SELECT RAISE(ABORT, 'session_agent_not_found');
      END;

      CREATE TRIGGER IF NOT EXISTS agent_session_delete_guard
      BEFORE DELETE ON agent_definitions
      WHEN EXISTS (SELECT 1 FROM sessions WHERE agent_id = OLD.id)
      BEGIN
        SELECT RAISE(ABORT, 'agent_in_use');
      END;

      CREATE TRIGGER IF NOT EXISTS main_agent_delete_guard
      BEFORE DELETE ON agent_definitions
      WHEN OLD.id = 'main'
      BEGIN
        SELECT RAISE(ABORT, 'main_agent_protected');
      END;
    `);
  }

  private insertEvent(input: AppendEventInput): RunEvent {
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
  }

  private permissionRequestRows(condition = "", params: readonly string[] = []): PermissionRequestRow[] {
    const where = condition ? `WHERE ${condition}` : "";
    return this.db
      .prepare(
        `SELECT id, session_id, run_id, message_id, invocation_id, tool_id, tool_name, caller, permission_decision,
                input_summary, public_input_json, execution_input_json, risk_level, reason, status,
                tool_call_part_id, command_output_part_id, metadata_json, created_at, updated_at, resolved_at
         FROM permission_requests
         ${where}
         ORDER BY created_at DESC, id DESC`
      )
      .all(...params) as PermissionRequestRow[];
  }

  private expirePendingPermissionsForRun(runId: string, resolvedAt: string): StoredPermissionRequest[] {
    const pendingRows = this.permissionRequestRows("run_id = ? AND status = 'pending'", [runId]);
    if (pendingRows.length === 0) {
      return [];
    }

    this.db
      .prepare(
        `UPDATE permission_requests
         SET status = 'expired', resolved_at = ?, updated_at = ?
         WHERE run_id = ? AND status = 'pending'`
      )
      .run(resolvedAt, resolvedAt, runId);

    for (const pendingRow of pendingRows) {
      const part = this.db
        .prepare(
          `SELECT id, message_id, seq, type, text, content_json, metadata_json, created_at, updated_at
           FROM message_parts
           WHERE id = ? AND type = 'tool_call'`
        )
        .get(pendingRow.tool_call_part_id) as MessagePartRow | undefined;
      if (!part) {
        continue;
      }
      const content = parseJsonObject(part.content_json);
      const status = content.status;
      if (status !== "created" && status !== "pending" && status !== "pending_permission" && status !== "running") {
        continue;
      }
      content.status = "cancelled";
      this.db
        .prepare("UPDATE message_parts SET content_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(content), resolvedAt, part.id);
    }

    return pendingRows.map((row) => rowToPermissionRequest({ ...row, status: "expired", resolved_at: resolvedAt, updated_at: resolvedAt }));
  }

  private cancelActiveToolCallPartsForRun(runId: string, updatedAt: string): void {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.content_json
         FROM message_parts p
         INNER JOIN messages m ON m.id = p.message_id
         WHERE m.run_id = ? AND p.type = 'tool_call'`
      )
      .all(runId) as Array<{ id: string; content_json: string }>;

    for (const row of rows) {
      const content = parseJsonObject(row.content_json);
      const status = content.status;
      if (status !== "created" && status !== "pending" && status !== "pending_permission" && status !== "running") {
        continue;
      }
      content.status = "cancelled";
      this.db
        .prepare("UPDATE message_parts SET content_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(content), updatedAt, row.id);
    }
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

function rowToSession(row: SessionRow, defaultWorkingDirectory: string): Session {
  return {
    id: row.id,
    title: row.title,
    workingDirectory: normalizeStoredWorkingDirectory(row.working_directory, defaultWorkingDirectory),
    agentId: row.agent_id || "main",
    activeSegmentId: row.active_segment_id,
    parentSessionId: row.parent_session_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeStoredWorkingDirectory(value: string | null | undefined, defaultWorkingDirectory: string): string {
  const trimmed = value?.trim();
  return trimmed ? resolve(trimmed) : defaultWorkingDirectory;
}

function assertValidRunTransition(expectedStatuses: readonly RunType.Status[], status: RunType.Status): void {
  const target = new RunVO.Status(status);
  for (const expectedStatus of expectedStatuses) {
    if (!new RunVO.Status(expectedStatus).canTransitionTo(target)) {
      throw new Error(`Invalid run status transition: ${expectedStatus} -> ${status}`);
    }
  }
}

function assertMatchingTerminalEvent(status: RunType.TerminalStatus, eventType: RunEventType): void {
  const expectedEventType = `run_${status}`;
  if (eventType !== expectedEventType) {
    throw new Error(`Terminal run status '${status}' requires event '${expectedEventType}', received '${eventType}'.`);
  }
}

function rowToRun(row: RunRow): Run {
  const metadata = parseJsonObject(row.metadata_json);
  return {
    id: row.id,
    sessionId: row.session_id,
    segmentId: row.segment_id,
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
  const error = new MessageVO.Status(row.status).isFailed() ? metadataError ?? row.run_error ?? null : metadataError;
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    segmentId: row.segment_id,
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

function rowToContextSegment(row: ContextSegmentRow): ContextSegment {
  return {
    id: row.id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    previousSegmentId: row.previous_segment_id,
    status: row.status,
    firstMessageId: row.first_message_id,
    lastMessageId: row.last_message_id,
    inheritedArtifactId: row.inherited_artifact_id,
    messageCount: row.message_count,
    createdAt: row.created_at,
    sealedAt: row.sealed_at
  };
}

function rowToContextArtifact(row: ContextArtifactRow): ContextArtifact {
  const usage = usageFromMetadata({ usage: parseJsonObject(row.usage_json) });
  return {
    id: row.id,
    kind: row.kind,
    sessionId: row.session_id,
    sourceSegmentId: row.source_segment_id,
    targetSegmentId: row.target_segment_id,
    previousArtifactId: row.previous_artifact_id,
    sourceMessageIds: parseStringArray(row.source_message_ids_json),
    sourceCategories: parseContextArtifactCategories(row.source_categories_json),
    sourceFirstMessageId: row.source_first_message_id,
    sourceLastMessageId: row.source_last_message_id,
    summary: row.summary,
    strategyVersion: row.strategy_version,
    estimatorVersion: row.estimator_version,
    estimatedTokensBefore: row.estimated_tokens_before,
    estimatedTokensAfter: row.estimated_tokens_after,
    resolvedWindowTokens: row.resolved_window_tokens,
    windowSource: row.window_source,
    status: row.status,
    providerProfileId: row.provider_profile_id,
    model: row.model,
    usage,
    error: row.error,
    createdAt: row.created_at
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
    revision: row.revision,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    modelProfileId: row.model_profile_id,
    defaultRunOptions: runOptionsFromJsonObject(parseJsonObject(row.default_run_options_json)),
    contextPolicy: contextPolicyFromJsonObject(parseJsonObject(row.context_policy_json)),
    skillIds: parseStringArray(row.skill_ids_json),
    toolIds: parseStringArray(row.tool_ids_json),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sameMutableAgentDefinition(left: AgentDefinition, right: AgentDefinition): boolean {
  return (
    left.name === right.name &&
    left.description === right.description &&
    left.systemPrompt === right.systemPrompt &&
    left.modelProfileId === right.modelProfileId &&
    isDeepStrictEqual(left.defaultRunOptions, right.defaultRunOptions) &&
    isDeepStrictEqual(left.contextPolicy, right.contextPolicy) &&
    isDeepStrictEqual(left.skillIds, right.skillIds) &&
    isDeepStrictEqual(left.toolIds, right.toolIds) &&
    isDeepStrictEqual(left.metadata, right.metadata)
  );
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

function rowToDaemonLease(row: DaemonLeaseRow): DaemonLeaseRecord {
  return {
    ownerId: row.owner_id,
    pid: row.pid,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at
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
  const reasoningEffort = normalizeReasoningEffort(value.reasoningEffort);
  if (reasoningEffort) {
    runOptions.reasoningEffort = reasoningEffort;
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

function contextPolicyFromJsonObject(value: JsonObject): AgentDefinition["contextPolicy"] {
  const policy: NonNullable<AgentDefinition["contextPolicy"]> = {};
  if (typeof value.contextWindowTokensOverride === "number" && Number.isInteger(value.contextWindowTokensOverride)) {
    policy.contextWindowTokensOverride = value.contextWindowTokensOverride;
  }
  if (typeof value.reservedOutputTokens === "number" && Number.isInteger(value.reservedOutputTokens)) {
    policy.reservedOutputTokens = value.reservedOutputTokens;
  }
  if (typeof value.safetyMarginRatio === "number" && Number.isFinite(value.safetyMarginRatio)) {
    policy.safetyMarginRatio = value.safetyMarginRatio;
  }
  if (typeof value.automaticCompaction === "boolean") {
    policy.automaticCompaction = value.automaticCompaction;
  }
  return Object.keys(policy).length > 0 ? policy : null;
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

function parseContextArtifactCategories(value: string | null | undefined): ContextArtifactSourceCategory[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!isJsonObject(entry) || !Array.isArray(entry.messageIds) || typeof entry.category !== "string") return [];
      const category = entry.category;
      if (
        category !== "completed_turn" &&
        category !== "unsuccessful_turn" &&
        category !== "standalone_tool" &&
        category !== "orphan_record" &&
        category !== "summary_recovery"
      ) return [];
      return [{
        category,
        messageIds: entry.messageIds.filter((id): id is string => typeof id === "string"),
        runId: typeof entry.runId === "string" ? entry.runId : null,
        status: typeof entry.status === "string" ? entry.status : "unknown"
      }];
    });
  } catch {
    return [];
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
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
