import { KernelError } from "../kernel/kernel";
import { PermissionRequestType } from "@/kernel/permission-request/type";
import { PermissionRequestVO } from "@/kernel/permission-request/vo";
import {
  defaultShellToolSettings,
  normalizeToolSettings,
  toolSettingsSettingKey,
  validateToolSettings
} from "../shared/tool-settings";
import { hasControlCharacters, maxReasoningEffortLength, normalizeReasoningEffort } from "../shared/run-options";
import type {
  CreateAgentDefinitionRequest,
  CreateSessionRequest,
  JsonObject,
  JsonValue,
  RunOptions,
  ShellExecRequest,
  ToolSettings,
  UpdateSessionRequest
} from "../shared/types";

export type AgentDefinitionPatch = {
  expectedRevision?: number;
  name?: string;
  description?: string | null;
  systemPrompt?: string;
  modelProfileId?: string | null;
  defaultRunOptions?: RunOptions | null;
  contextPolicy?: CreateAgentDefinitionRequest["contextPolicy"];
  skillIds?: string[];
  toolIds?: string[];
  metadata?: JsonObject;
};

export function parseToolSettingsPatch(body: unknown, current: ToolSettings): ToolSettings {
  const candidate = isPlainObject(body) && isPlainObject(body.settings) ? body.settings : body;
  if (!isPlainObject(candidate)) {
    throw new KernelError("PATCH /api/tool-settings expects a JSON object or { settings: object }.", 400);
  }

  const allowedKeys = new Set(["defaultAction", "denyPatternsText", "askPatternsText", "allowPatternsText", "shell"]);
  for (const key of Object.keys(candidate)) {
    if (!allowedKeys.has(key)) {
      throw new KernelError(`Unsupported Tool Settings field '${key}'.`, 400);
    }
  }

  return normalizeToolSettings(candidate, current);
}

export function normalizeSettingsPatch(patch: JsonObject): JsonObject {
  const normalizedPatch: JsonObject = {};
  for (const [key, value] of Object.entries(patch)) {
    normalizedPatch[key] = key === toolSettingsSettingKey ? toolSettingsToJson(normalizeToolSettings(value)) : value;
  }
  return normalizedPatch;
}

export function toolSettingsToJson(settings: ToolSettings): JsonObject {
  const validatedSettings = validateToolSettings(settings);
  return {
    defaultAction: validatedSettings.defaultAction,
    denyPatternsText: validatedSettings.denyPatternsText,
    askPatternsText: validatedSettings.askPatternsText,
    allowPatternsText: validatedSettings.allowPatternsText,
    shell: {
      defaultTimeoutMs: validatedSettings.shell.defaultTimeoutMs ?? defaultShellToolSettings.defaultTimeoutMs,
      maxTimeoutMs: validatedSettings.shell.maxTimeoutMs ?? defaultShellToolSettings.maxTimeoutMs,
      maxOutputChars: validatedSettings.shell.maxOutputChars ?? defaultShellToolSettings.maxOutputChars
    }
  };
}

export function parseCreateSessionRequest(body: Record<string, unknown>): CreateSessionRequest {
  const request: CreateSessionRequest = {};
  if (body.title !== undefined && body.title !== null && body.title !== "") {
    if (typeof body.title !== "string") {
      throw new KernelError("Session field 'title' must be a string when provided.", 400);
    }
    request.title = body.title;
  }
  if (body.workingDirectory !== undefined && body.workingDirectory !== null && body.workingDirectory !== "") {
    if (typeof body.workingDirectory !== "string") {
      throw new KernelError("Session field 'workingDirectory' must be a string when provided.", 400);
    }
    request.workingDirectory = body.workingDirectory;
  }
  if (body.agentId !== undefined && body.agentId !== null && body.agentId !== "") {
    if (typeof body.agentId !== "string" || !body.agentId.trim()) {
      throw new KernelError("Session field 'agentId' must be a non-empty string when provided.", 400);
    }
    request.agentId = body.agentId.trim();
  }
  return request;
}

export function parseSessionPatch(body: unknown): UpdateSessionRequest {
  if (!isPlainObject(body)) {
    throw new KernelError("PATCH /api/sessions/:id expects a JSON object.", 400);
  }
  const allowedKeys = new Set(["workingDirectory", "agentId"]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      throw new KernelError(`Unsupported session field '${key}'.`, 400);
    }
  }
  const request: UpdateSessionRequest = {};
  if ("workingDirectory" in body) {
    if (typeof body.workingDirectory !== "string" || !body.workingDirectory.trim()) {
      throw new KernelError("Session field 'workingDirectory' must be a non-empty string.", 400);
    }
    request.workingDirectory = body.workingDirectory;
  }
  if ("agentId" in body) {
    if (typeof body.agentId !== "string" || !body.agentId.trim()) {
      throw new KernelError("Session field 'agentId' must be a non-empty string.", 400);
    }
    request.agentId = body.agentId.trim();
  }
  if (Object.keys(request).length === 0) {
    throw new KernelError("Session patch requires workingDirectory or agentId.", 400);
  }
  return request;
}

export function parseShellExecRequest(body: Record<string, unknown>): ShellExecRequest {
  if (typeof body.command !== "string" || !body.command.trim()) {
    throw new KernelError("shell.exec requires body field 'command' as a non-empty string.", 400);
  }
  if (body.command.length > 20_000) {
    throw new KernelError("shell.exec field 'command' must be 20000 characters or fewer.", 400);
  }

  const input: ShellExecRequest = { command: body.command };
  if (body.cwd !== undefined && body.cwd !== null && body.cwd !== "") {
    if (typeof body.cwd !== "string") {
      throw new KernelError("shell.exec field 'cwd' must be a string when provided.", 400);
    }
    input.cwd = body.cwd;
  }
  if (body.timeoutMs !== undefined && body.timeoutMs !== null && body.timeoutMs !== "") {
    if (typeof body.timeoutMs !== "number" || !Number.isFinite(body.timeoutMs) || !Number.isInteger(body.timeoutMs)) {
      throw new KernelError("shell.exec field 'timeoutMs' must be an integer number of milliseconds.", 400);
    }
    input.timeoutMs = body.timeoutMs;
  }
  return input;
}

export function parsePermissionStatus(value: unknown): PermissionRequestType.Status | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (Array.isArray(value)) {
    throw new KernelError("Permission status query must be a single value.", 400);
  }
  const status = new PermissionRequestVO.Status(value);
  if (status.isValid()) {
    return status.value;
  }
  throw new KernelError("Permission status must be one of pending, approved, denied, expired.", 400);
}

export function extractSettingsPatch(body: unknown): JsonObject | null {
  const candidate = isPlainObject(body) && isPlainObject(body.settings) ? body.settings : body;
  if (!isPlainObject(candidate)) {
    return null;
  }

  const patch: JsonObject = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (!isValidSettingKey(key) || !isJsonValue(value)) {
      return null;
    }
    patch[key] = value;
  }
  return patch;
}

export function parseAgentDefinitionPatch(body: unknown): AgentDefinitionPatch {
  if (!isPlainObject(body)) {
    throw new KernelError("PATCH /api/agents/:id expects a JSON object.", 400);
  }

  const allowedKeys = new Set([
    "name",
    "description",
    "systemPrompt",
    "modelProfileId",
    "defaultRunOptions",
    "contextPolicy",
    "skillIds",
    "toolIds",
    "metadata",
    "expectedRevision"
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      throw new KernelError(`Unsupported agent definition field '${key}'.`, 400);
    }
  }

  const patch: AgentDefinitionPatch = {};
  if ("expectedRevision" in body) {
    patch.expectedRevision = parsePositiveRevision(body.expectedRevision);
  }
  if ("name" in body) {
    if (typeof body.name !== "string") {
      throw new KernelError("Agent field 'name' must be a string.", 400);
    }
    const name = body.name.trim();
    if (!name || name.length > 120 || hasControlCharacters(name)) {
      throw new KernelError("Agent field 'name' must be 1-120 characters without control characters.", 400);
    }
    patch.name = name;
  }

  if ("description" in body) {
    if (body.description === null || body.description === undefined) {
      patch.description = null;
    } else if (typeof body.description === "string") {
      const description = body.description.trim();
      if (description.length > 1000) {
        throw new KernelError("Agent field 'description' must be 1000 characters or fewer.", 400);
      }
      patch.description = description || null;
    } else {
      throw new KernelError("Agent field 'description' must be a string or null.", 400);
    }
  }

  if ("systemPrompt" in body) {
    if (typeof body.systemPrompt !== "string") {
      throw new KernelError("Agent field 'systemPrompt' must be a string.", 400);
    }
    if (!body.systemPrompt.trim() || body.systemPrompt.length > 20_000) {
      throw new KernelError("Agent field 'systemPrompt' must be 1-20000 characters.", 400);
    }
    patch.systemPrompt = body.systemPrompt;
  }

  if ("modelProfileId" in body) {
    if (body.modelProfileId === null || body.modelProfileId === undefined || body.modelProfileId === "") {
      patch.modelProfileId = null;
    } else if (typeof body.modelProfileId === "string") {
      const modelProfileId = body.modelProfileId.trim();
      if (modelProfileId.length > 120 || hasControlCharacters(modelProfileId)) {
        throw new KernelError("Agent field 'modelProfileId' must be 120 characters or fewer without control characters.", 400);
      }
      patch.modelProfileId = modelProfileId || null;
    } else {
      throw new KernelError("Agent field 'modelProfileId' must be a string or null.", 400);
    }
  }

  if ("defaultRunOptions" in body) {
    patch.defaultRunOptions = body.defaultRunOptions === null ? null : parseRunOptionsValue(body.defaultRunOptions) ?? {};
  }
  if ("contextPolicy" in body) {
    patch.contextPolicy = parseAgentContextPolicy(body.contextPolicy);
  }

  if ("skillIds" in body) {
    patch.skillIds = parseStringList(body.skillIds, "skillIds");
  }
  if ("toolIds" in body) {
    patch.toolIds = parseStringList(body.toolIds, "toolIds");
  }

  if ("metadata" in body) {
    if (!isPlainObject(body.metadata) || !isJsonValue(body.metadata)) {
      throw new KernelError("Agent field 'metadata' must be a JSON object.", 400);
    }
    if (containsSensitiveKey(body.metadata)) {
      throw new KernelError("Agent metadata must not contain credential, token, secret, or API key fields.", 400);
    }
    if (containsReservedAgentMetadataKey(body.metadata)) {
      throw new KernelError("Agent metadata keys beginning with '_' and reserved migration keys are not user-editable.", 400);
    }
    patch.metadata = body.metadata;
  }

  return patch;
}

export function parseCreateAgentDefinition(body: unknown): CreateAgentDefinitionRequest {
  const patch = parseAgentDefinitionPatch(body);
  if (patch.expectedRevision !== undefined) {
    throw new KernelError("Agent creation does not accept expectedRevision.", 400);
  }
  if (!patch.name || !patch.systemPrompt) {
    throw new KernelError("Agent creation requires name and systemPrompt.", 400);
  }
  return {
    name: patch.name,
    systemPrompt: patch.systemPrompt,
    description: patch.description,
    modelProfileId: patch.modelProfileId,
    defaultRunOptions: patch.defaultRunOptions,
    contextPolicy: patch.contextPolicy,
    skillIds: patch.skillIds,
    toolIds: patch.toolIds,
    metadata: patch.metadata
  };
}

export function parseExpectedAgentRevision(body: unknown): number {
  if (!isPlainObject(body)) {
    throw new KernelError("Agent mutation expects body { expectedRevision }.", 400);
  }
  for (const key of Object.keys(body)) {
    if (key !== "expectedRevision") {
      throw new KernelError(`Unsupported agent mutation field '${key}'.`, 400);
    }
  }
  return parsePositiveRevision(body.expectedRevision);
}

export function parseRunOptionsFromBody(body: Record<string, unknown> | undefined): RunOptions | undefined {
  const rawOptions = body?.runOptions ?? body?.options;
  return parseRunOptionsValue(rawOptions);
}

function parseRunOptionsValue(rawOptions: unknown): RunOptions | undefined {
  if (rawOptions === undefined || rawOptions === null) {
    return undefined;
  }
  if (!isPlainObject(rawOptions)) {
    throw new KernelError("Run options must be a JSON object.", 400);
  }

  const options: RunOptions = {};
  if ("model" in rawOptions) {
    if (rawOptions.model !== null && rawOptions.model !== undefined) {
      if (typeof rawOptions.model !== "string") {
        throw new KernelError("Run option 'model' must be a string.", 400);
      }
      const model = rawOptions.model.trim();
      if (model.length > 200 || hasControlCharacters(model)) {
        throw new KernelError("Run option 'model' must be 200 characters or fewer without control characters.", 400);
      }
      if (model) {
        options.model = model;
      }
    }
  }

  if ("reasoningEffort" in rawOptions) {
    if (rawOptions.reasoningEffort !== null && rawOptions.reasoningEffort !== undefined) {
      if (typeof rawOptions.reasoningEffort !== "string") {
        throw new KernelError("Run option 'reasoningEffort' must be a string.", 400);
      }
      if (hasControlCharacters(rawOptions.reasoningEffort)) {
        throw new KernelError("Run option 'reasoningEffort' must not contain control characters.", 400);
      }
      const effort = rawOptions.reasoningEffort.trim();
      if (effort.length > maxReasoningEffortLength) {
        throw new KernelError(`Run option 'reasoningEffort' must be ${maxReasoningEffortLength} characters or fewer.`, 400);
      }
      const normalized = normalizeReasoningEffort(effort);
      if (normalized) {
        options.reasoningEffort = normalized;
      }
    }
  }

  if ("temperature" in rawOptions) {
    if (rawOptions.temperature !== null && rawOptions.temperature !== undefined && rawOptions.temperature !== "") {
      if (typeof rawOptions.temperature !== "number" || !Number.isFinite(rawOptions.temperature)) {
        throw new KernelError("Run option 'temperature' must be a finite number.", 400);
      }
      if (rawOptions.temperature < 0 || rawOptions.temperature > 2) {
        throw new KernelError("Run option 'temperature' must be between 0 and 2.", 400);
      }
      options.temperature = rawOptions.temperature;
    }
  }

  return options;
}

function parseAgentContextPolicy(value: unknown): CreateAgentDefinitionRequest["contextPolicy"] {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw new KernelError("Agent field 'contextPolicy' must be a JSON object or null.", 400);
  }
  const allowedKeys = new Set(["contextWindowTokensOverride", "reservedOutputTokens", "safetyMarginRatio", "automaticCompaction"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new KernelError(`Unsupported Agent context policy field '${key}'.`, 400);
    }
  }
  const policy: NonNullable<CreateAgentDefinitionRequest["contextPolicy"]> = {};
  if (value.contextWindowTokensOverride !== undefined && value.contextWindowTokensOverride !== null && value.contextWindowTokensOverride !== "") {
    if (typeof value.contextWindowTokensOverride !== "number" || !Number.isInteger(value.contextWindowTokensOverride)) {
      throw new KernelError("Agent contextWindowTokensOverride must be an integer.", 400);
    }
    policy.contextWindowTokensOverride = value.contextWindowTokensOverride;
  }
  if (value.reservedOutputTokens !== undefined && value.reservedOutputTokens !== null && value.reservedOutputTokens !== "") {
    if (typeof value.reservedOutputTokens !== "number" || !Number.isInteger(value.reservedOutputTokens)) {
      throw new KernelError("Agent reservedOutputTokens must be an integer.", 400);
    }
    policy.reservedOutputTokens = value.reservedOutputTokens;
  }
  if (value.safetyMarginRatio !== undefined && value.safetyMarginRatio !== null && value.safetyMarginRatio !== "") {
    if (typeof value.safetyMarginRatio !== "number" || !Number.isFinite(value.safetyMarginRatio)) {
      throw new KernelError("Agent safetyMarginRatio must be a finite number.", 400);
    }
    policy.safetyMarginRatio = value.safetyMarginRatio;
  }
  if (value.automaticCompaction !== undefined) {
    if (typeof value.automaticCompaction !== "boolean") {
      throw new KernelError("Agent automaticCompaction must be a boolean.", 400);
    }
    policy.automaticCompaction = value.automaticCompaction;
  }
  return Object.keys(policy).length > 0 ? policy : null;
}

function isValidSettingKey(key: string): boolean {
  return key.trim().length > 0 && key.length <= 128;
}

function parsePositiveRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new KernelError("Agent expectedRevision must be a positive integer.", 400);
  }
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (isPlainObject(value)) {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requestBodyObject(body: unknown): Record<string, unknown> {
  return isPlainObject(body) ? body : {};
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseStringList(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new KernelError(`Agent field '${fieldName}' must be an array of strings.`, 400);
  }
  if (value.length > 100) {
    throw new KernelError(`Agent field '${fieldName}' must contain 100 IDs or fewer.`, 400);
  }
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new KernelError(`Agent field '${fieldName}' must be an array of strings.`, 400);
    }
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.length > 120) {
      throw new KernelError(`Agent field '${fieldName}' IDs must be 120 characters or fewer.`, 400);
    }
    if (hasControlCharacters(trimmed)) {
      throw new KernelError(`Agent field '${fieldName}' IDs must not contain control characters.`, 400);
    }
    if (output.includes(trimmed)) {
      throw new KernelError(`Agent field '${fieldName}' contains duplicate ID '${trimmed}'.`, 400);
    }
    output.push(trimmed);
  }
  return output;
}

function containsSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSensitiveKey);
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.entries(value).some(([key, nested]) => isSensitiveMetadataKey(key) || containsSensitiveKey(nested));
}

function isSensitiveMetadataKey(key: string): boolean {
  return /authorization|cookie|token|secret|api[_-]?key|credential|password|refresh|access/i.test(key);
}

function containsReservedAgentMetadataKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsReservedAgentMetadataKey);
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, nested]) => key.startsWith("_") || key === "explicitToolAllowlistVersion" || containsReservedAgentMetadataKey(nested)
  );
}
