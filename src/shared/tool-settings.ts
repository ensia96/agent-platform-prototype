import type {
  PermissionPolicyAction,
  ShellToolSettings,
  ToolSettings,
  ToolSettingsPatternField,
  ToolSettingsValidationField
} from "./types";

export const toolSettingsSettingKey = "toolSettings";

export const defaultShellToolSettings: Required<ShellToolSettings> = {
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 300_000,
  maxOutputChars: 64_000
};

export const defaultToolSettings: ToolSettings = {
  defaultAction: "allow",
  denyPatternsText: "",
  askPatternsText: "",
  allowPatternsText: "",
  shell: { ...defaultShellToolSettings }
};

export interface ParsedRegexPattern {
  lineNumber: number;
  pattern: string;
  regex: RegExp;
}

export interface ToolSettingsValidationIssue {
  field: ToolSettingsValidationField;
  lineNumber?: number;
  pattern?: string;
  message: string;
}

export interface ToolSettingsPermissionMatch {
  action: PermissionPolicyAction;
  field: ToolSettingsPatternField;
  lineNumber: number;
  pattern: string;
}

export interface ToolSettingsPermissionEvaluation {
  action: PermissionPolicyAction;
  source: "deny" | "ask" | "allow" | "default";
  matchedPattern?: ToolSettingsPermissionMatch;
}

export class ToolSettingsValidationError extends Error {
  constructor(readonly issues: ToolSettingsValidationIssue[]) {
    super(formatToolSettingsValidationIssues(issues));
    this.name = "ToolSettingsValidationError";
  }
}

export function parseRegexPatternText(text: string, field: ToolSettingsPatternField = "allowPatternsText"): ParsedRegexPattern[] {
  const { patterns, issues } = parseRegexPatternTextInternal(text, field);
  if (issues.length > 0) {
    throw new ToolSettingsValidationError(issues);
  }
  return patterns;
}

export function validateToolSettings(settings: ToolSettings): ToolSettings {
  return normalizeToolSettings(settings, defaultToolSettings);
}

export function normalizeShellToolSettings(
  value: unknown,
  base: ShellToolSettings = defaultShellToolSettings
): Required<ShellToolSettings> {
  const issues: ToolSettingsValidationIssue[] = [];
  const shell = readShellToolSettings(value === undefined ? {} : { shell: value }, base, issues);
  if (issues.length > 0) {
    throw new ToolSettingsValidationError(dedupeIssues(issues));
  }
  return shell;
}

export function normalizeToolSettings(value: unknown, base: ToolSettings = defaultToolSettings): ToolSettings {
  const issues: ToolSettingsValidationIssue[] = [];
  const candidate = value === undefined ? {} : isPlainObject(value) ? value : null;
  if (!candidate) {
    issues.push({ field: "defaultAction", message: "Tool Settings must be a JSON object." });
  }

  let defaultAction = base.defaultAction;
  if (candidate && "defaultAction" in candidate) {
    if (isPermissionPolicyAction(candidate.defaultAction)) {
      defaultAction = candidate.defaultAction;
    } else {
      issues.push({
        field: "defaultAction",
        message: "Default action must be one of allow, ask, deny."
      });
    }
  }

  const denyPatternsText = readPatternText(candidate ?? {}, base, "denyPatternsText", issues);
  const askPatternsText = readPatternText(candidate ?? {}, base, "askPatternsText", issues);
  const allowPatternsText = readPatternText(candidate ?? {}, base, "allowPatternsText", issues);
  const shell = readShellToolSettings(candidate ?? {}, base.shell, issues);
  const settings: ToolSettings = {
    defaultAction,
    denyPatternsText,
    askPatternsText,
    allowPatternsText,
    shell
  };

  issues.push(...collectToolSettingsIssues(settings));
  if (issues.length > 0) {
    throw new ToolSettingsValidationError(dedupeIssues(issues));
  }
  return settings;
}

export function evaluateToolPermission(command: string, settings: ToolSettings): ToolSettingsPermissionEvaluation {
  const validatedSettings = validateToolSettings(settings);
  const denyPatterns = parseRegexPatternText(validatedSettings.denyPatternsText, "denyPatternsText");
  const askPatterns = parseRegexPatternText(validatedSettings.askPatternsText, "askPatternsText");
  const allowPatterns = parseRegexPatternText(validatedSettings.allowPatternsText, "allowPatternsText");

  const denyMatch = findPatternMatch(command, denyPatterns);
  if (denyMatch) {
    return {
      action: "deny",
      source: "deny",
      matchedPattern: { action: "deny", field: "denyPatternsText", ...denyMatch }
    };
  }

  const askMatch = findPatternMatch(command, askPatterns);
  if (askMatch) {
    return {
      action: "ask",
      source: "ask",
      matchedPattern: { action: "ask", field: "askPatternsText", ...askMatch }
    };
  }

  const allowMatch = findPatternMatch(command, allowPatterns);
  if (allowMatch) {
    return {
      action: "allow",
      source: "allow",
      matchedPattern: { action: "allow", field: "allowPatternsText", ...allowMatch }
    };
  }

  return { action: validatedSettings.defaultAction, source: "default" };
}

export function activeRegexPatternSources(text: string): string[] {
  return text
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function formatToolSettingsValidationIssues(issues: ToolSettingsValidationIssue[]): string {
  if (issues.length === 0) {
    return "Tool Settings validation failed.";
  }
  return issues
    .map((issue) => {
      const location = issue.lineNumber ? `${fieldLabel(issue.field)} line ${issue.lineNumber}` : fieldLabel(issue.field);
      return `${location}: ${issue.message}`;
    })
    .join("\n");
}

function collectToolSettingsIssues(settings: ToolSettings): ToolSettingsValidationIssue[] {
  const issues: ToolSettingsValidationIssue[] = [];
  if (!isPermissionPolicyAction(settings.defaultAction)) {
    issues.push({ field: "defaultAction", message: "Default action must be one of allow, ask, deny." });
  }

  for (const field of ["denyPatternsText", "askPatternsText", "allowPatternsText"] as const) {
    if (typeof settings[field] !== "string") {
      issues.push({ field, message: `${fieldLabel(field)} must be a string.` });
      continue;
    }
    issues.push(...parseRegexPatternTextInternal(settings[field], field).issues);
  }
  readShellToolSettings({ shell: settings.shell }, defaultShellToolSettings, issues);
  return issues;
}

function parseRegexPatternTextInternal(
  text: string,
  field: ToolSettingsPatternField
): { patterns: ParsedRegexPattern[]; issues: ToolSettingsValidationIssue[] } {
  const patterns: ParsedRegexPattern[] = [];
  const issues: ToolSettingsValidationIssue[] = [];
  const lines = text.split(/\r\n|\n|\r/);

  for (let index = 0; index < lines.length; index += 1) {
    const pattern = lines[index].trim();
    if (!pattern || pattern.startsWith("#")) {
      continue;
    }

    try {
      patterns.push({ lineNumber: index + 1, pattern, regex: new RegExp(pattern) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Invalid JavaScript regular expression.";
      issues.push({
        field,
        lineNumber: index + 1,
        pattern,
        message: detail
      });
    }
  }

  return { patterns, issues };
}

function readPatternText(
  candidate: Record<string, unknown>,
  base: ToolSettings,
  field: ToolSettingsPatternField,
  issues: ToolSettingsValidationIssue[]
): string {
  if (!(field in candidate)) {
    return base[field];
  }
  const value = candidate[field];
  if (typeof value !== "string") {
    issues.push({ field, message: `${fieldLabel(field)} must be a string.` });
    return base[field];
  }
  return value;
}

function readShellToolSettings(
  candidate: Record<string, unknown>,
  base: ShellToolSettings,
  issues: ToolSettingsValidationIssue[]
): Required<ShellToolSettings> {
  const baseSettings = mergeShellToolSettings(base);
  if (!("shell" in candidate)) {
    return baseSettings;
  }

  const shellValue = candidate.shell;
  if (!isPlainObject(shellValue)) {
    issues.push({ field: "shell", message: "Shell execution settings must be a JSON object." });
    return baseSettings;
  }

  for (const key of Object.keys(shellValue)) {
    if (key !== "defaultTimeoutMs" && key !== "maxTimeoutMs" && key !== "maxOutputChars") {
      issues.push({ field: "shell", message: `Unsupported shell execution setting '${key}'.` });
    }
  }

  const shell: Required<ShellToolSettings> = {
    defaultTimeoutMs: readPositiveIntegerSetting(
      shellValue,
      baseSettings.defaultTimeoutMs,
      "defaultTimeoutMs",
      "shell.defaultTimeoutMs",
      "Shell default timeout",
      "milliseconds",
      issues
    ),
    maxTimeoutMs: readPositiveIntegerSetting(
      shellValue,
      baseSettings.maxTimeoutMs,
      "maxTimeoutMs",
      "shell.maxTimeoutMs",
      "Shell max timeout",
      "milliseconds",
      issues
    ),
    maxOutputChars: readPositiveIntegerSetting(
      shellValue,
      baseSettings.maxOutputChars,
      "maxOutputChars",
      "shell.maxOutputChars",
      "Shell max output chars",
      "characters",
      issues
    )
  };

  if (shell.defaultTimeoutMs > shell.maxTimeoutMs) {
    issues.push({
      field: "shell.defaultTimeoutMs",
      message: "Shell default timeout must be less than or equal to shell max timeout."
    });
  }

  return shell;
}

function mergeShellToolSettings(base: ShellToolSettings): Required<ShellToolSettings> {
  return {
    defaultTimeoutMs: positiveIntegerOrDefault(base.defaultTimeoutMs, defaultShellToolSettings.defaultTimeoutMs),
    maxTimeoutMs: positiveIntegerOrDefault(base.maxTimeoutMs, defaultShellToolSettings.maxTimeoutMs),
    maxOutputChars: positiveIntegerOrDefault(base.maxOutputChars, defaultShellToolSettings.maxOutputChars)
  };
}

function readPositiveIntegerSetting(
  object: Record<string, unknown>,
  fallback: number,
  key: keyof ShellToolSettings,
  field: ToolSettingsValidationField,
  label: string,
  unit: string,
  issues: ToolSettingsValidationIssue[]
): number {
  if (!(key in object)) {
    return fallback;
  }

  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    issues.push({ field, message: `${label} must be an integer number of ${unit}.` });
    return fallback;
  }
  if (value <= 0) {
    issues.push({ field, message: `${label} must be greater than 0.` });
    return fallback;
  }
  return value;
}

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : fallback;
}

function findPatternMatch(command: string, patterns: ParsedRegexPattern[]): Pick<ToolSettingsPermissionMatch, "lineNumber" | "pattern"> | null {
  for (const pattern of patterns) {
    if (pattern.regex.test(command)) {
      return { lineNumber: pattern.lineNumber, pattern: pattern.pattern };
    }
  }
  return null;
}

function isPermissionPolicyAction(value: unknown): value is PermissionPolicyAction {
  return value === "allow" || value === "ask" || value === "deny";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldLabel(field: ToolSettingsValidationField): string {
  if (field === "defaultAction") {
    return "Default action";
  }
  if (field === "denyPatternsText") {
    return "Deny patterns";
  }
  if (field === "askPatternsText") {
    return "Ask patterns";
  }
  if (field === "allowPatternsText") {
    return "Allow patterns";
  }
  if (field === "shell") {
    return "Shell execution settings";
  }
  if (field === "shell.defaultTimeoutMs") {
    return "Shell default timeout";
  }
  if (field === "shell.maxTimeoutMs") {
    return "Shell max timeout";
  }
  if (field === "shell.maxOutputChars") {
    return "Shell max output chars";
  }
  return "Allow patterns";
}

function dedupeIssues(issues: ToolSettingsValidationIssue[]): ToolSettingsValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.field}:${issue.lineNumber ?? ""}:${issue.pattern ?? ""}:${issue.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
