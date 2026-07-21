import { randomUUID } from "node:crypto";
import type { StoredPermissionRequest } from "../store/types";
import { normalizeShellToolSettings } from "../shared/tool-settings";
import type {
  BuiltContext,
  JsonObject,
  Message,
  MessagePart,
  PermissionRequest,
  ToolDefinition,
  ToolExecutionResult,
  ToolInvocation,
  ToolInvocationCaller,
  ToolPermissionDecision,
  ToolResultStatus,
  ToolSettings
} from "../shared/types";
import type { ToolPermissionEvaluation } from "../tools/permission-policy";
import {
  booleanField,
  nullableNumberField,
  numberField,
  partNumber,
  partString,
  stringField
} from "./kernel-metadata";

const defaultCommandOutputMaxChars = 128_000;

export function buildToolRunMetadata(
  tool: ToolDefinition,
  input: JsonObject,
  caller: ToolInvocationCaller,
  permission: ToolPermissionEvaluation,
  executionCwd: string
): JsonObject {
  return {
    kind: "tool_invocation",
    toolId: tool.id,
    toolName: tool.name,
    toolSource: tool.source,
    caller,
    permissionDecision: permission.decision,
    permissionAction: permission.action,
    permissionRuleId: permission.ruleId,
    permissionRiskLevel: permission.riskLevel,
    permissionReason: permission.reason,
    input,
    executionCwd,
    permissionPolicy: permissionPolicySummary(permission)
  };
}

export function buildToolMessageMetadata(
  tool: ToolDefinition,
  input: JsonObject,
  caller: ToolInvocationCaller,
  permission: ToolPermissionEvaluation
): JsonObject {
  return {
    kind: "tool_invocation",
    toolId: tool.id,
    toolName: tool.name,
    toolSource: tool.source,
    caller,
    permissionDecision: permission.decision,
    permissionAction: permission.action,
    permissionRuleId: permission.ruleId,
    permissionRiskLevel: permission.riskLevel,
    input
  };
}

export function commandOutputMaxCharsForTool(toolId: string, settings: ToolSettings): number {
  if (toolId !== "shell.exec") {
    return defaultCommandOutputMaxChars;
  }
  return normalizeShellToolSettings(settings.shell).maxOutputChars * 2;
}

export function toolProviderForPart(toolId: string): "shell" | "internal" {
  return toolId === "shell.exec" ? "shell" : "internal";
}

export function toPublicPermissionRequest(request: StoredPermissionRequest): PermissionRequest {
  return {
    id: request.id,
    sessionId: request.sessionId,
    runId: request.runId,
    invocationId: request.invocationId,
    toolName: request.toolName,
    toolId: request.toolId,
    inputSummary: request.inputSummary,
    input: request.publicInput,
    riskLevel: request.riskLevel,
    reason: request.reason,
    status: request.status,
    createdAt: request.createdAt,
    resolvedAt: request.resolvedAt
  };
}

export function permissionEvaluationFromRequest(request: StoredPermissionRequest, executionCwd: string): ToolPermissionEvaluation {
  const action = request.permissionDecision === "allowed" ? "allow" : request.permissionDecision === "denied" ? "deny" : "ask";
  const ruleId = stringField(request.metadata, "permissionRuleId") || "permission.request";
  return {
    action,
    decision: request.permissionDecision,
    riskLevel: request.riskLevel,
    reason: request.reason,
    ruleId,
    policy: {
      id: "user.tool-settings",
      version: 1,
      experimental: true,
      defaultAction: action,
      executionCwd,
      shell: {
        defaultAction: action,
        rules: []
      }
    }
  };
}

export function permissionPolicySummary(permission: ToolPermissionEvaluation): JsonObject {
  return {
    id: permission.policy.id,
    version: permission.policy.version,
    experimental: permission.policy.experimental,
    executionCwd: permission.policy.executionCwd,
    defaultAction: permission.policy.shell.defaultAction,
    ruleId: permission.ruleId,
    action: permission.action,
    riskLevel: permission.riskLevel,
    ...(permission.matchedPattern
      ? {
          matchedPattern: {
            field: permission.matchedPattern.field,
            lineNumber: permission.matchedPattern.lineNumber,
            pattern: permission.matchedPattern.pattern,
            action: permission.matchedPattern.action
          }
        }
      : {})
  };
}

export function summarizeToolInput(toolId: string, input: JsonObject): string {
  if (toolId === "shell.exec") {
    const command = stringField(input, "command");
    const cwd = stringField(input, "cwd");
    const timeoutMs = numberField(input, "timeoutMs");
    return [command ? `$ ${command}` : "shell.exec", cwd ? `cwd: ${cwd}` : "", timeoutMs !== null ? `timeout: ${timeoutMs}ms` : ""]
      .filter(Boolean)
      .join("\n");
  }
  return `Tool call: ${toolId}`;
}

export function buildPermissionBlockedResult(
  invocation: ToolInvocation,
  toolId: string,
  permissionDecision: ToolPermissionDecision,
  reason: string,
  startedAt: string,
  completedAt: string
): ToolExecutionResult {
  return {
    invocationId: invocation.id,
    toolId,
    status: "failed",
    output: {},
    error:
      permissionDecision === "requires_approval"
        ? `Tool execution requires approval: ${reason}`
        : `Tool execution denied by permission policy: ${reason}`,
    startedAt,
    completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    metadata: { permissionDecision, reason }
  };
}

export function buildToolExecutionResult(
  invocation: ToolInvocation,
  toolId: string,
  output: JsonObject,
  startedAt: string,
  completedAt: string
): ToolExecutionResult {
  const status = inferToolResultStatus(output);
  const durationMs = numberField(output, "durationMs") ?? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
  return {
    invocationId: invocation.id,
    toolId,
    status,
    output,
    error: inferToolResultError(output, status),
    startedAt,
    completedAt,
    durationMs,
    metadata: {
      exitCode: nullableNumberField(output, "exitCode"),
      timedOut: booleanField(output, "timedOut"),
      stdoutTruncated: booleanField(output, "stdoutTruncated"),
      stderrTruncated: booleanField(output, "stderrTruncated")
    }
  };
}

function inferToolResultStatus(output: JsonObject): ToolResultStatus {
  const timedOut = booleanField(output, "timedOut") === true;
  if (timedOut) {
    return "failed";
  }
  if (Object.prototype.hasOwnProperty.call(output, "exitCode")) {
    return numberField(output, "exitCode") === 0 ? "completed" : "failed";
  }
  return "completed";
}

function inferToolResultError(output: JsonObject, status: ToolResultStatus): string | null {
  if (status === "completed") {
    return null;
  }
  const timeoutMs = numberField(output, "durationMs");
  if (booleanField(output, "timedOut") === true) {
    return `Command timed out${timeoutMs !== null ? ` after ${timeoutMs}ms` : ""}.`;
  }
  const exitCode = nullableNumberField(output, "exitCode");
  if (exitCode !== null) {
    return `Command exited with code ${exitCode}.`;
  }
  if (Object.prototype.hasOwnProperty.call(output, "exitCode")) {
    return "Command ended without an exit code.";
  }
  return "Tool execution failed.";
}

export function commandOutputMetadataFromResult(result: ToolExecutionResult, commandOutputTruncated: boolean): JsonObject {
  const metadata: JsonObject = {
    durationMs: result.durationMs,
    truncated: commandOutputTruncated,
    status: result.status
  };
  const exitCode = nullableNumberField(result.output, "exitCode");
  if (exitCode !== null) {
    metadata.exitCode = exitCode;
  }
  const cwd = stringField(result.output, "cwd");
  if (cwd) {
    metadata.cwd = cwd;
  }
  const timedOut = booleanField(result.output, "timedOut");
  if (timedOut !== null) {
    metadata.timedOut = timedOut;
  }
  const stdoutTruncated = booleanField(result.output, "stdoutTruncated");
  if (stdoutTruncated !== null) {
    metadata.stdoutTruncated = stdoutTruncated;
    metadata.truncated = commandOutputTruncated || stdoutTruncated === true;
  }
  const stderrTruncated = booleanField(result.output, "stderrTruncated");
  if (stderrTruncated !== null) {
    metadata.stderrTruncated = stderrTruncated;
    metadata.truncated = commandOutputTruncated || stdoutTruncated === true || stderrTruncated === true;
  }
  return metadata;
}

export function summarizeToolResult(result: ToolExecutionResult): string {
  const exitCode = nullableNumberField(result.output, "exitCode");
  const parts = [
    result.status,
    exitCode !== null ? `exit ${exitCode}` : "",
    `${result.durationMs}ms`,
    booleanField(result.output, "timedOut") === true ? "timed out" : "",
    booleanField(result.output, "stdoutTruncated") === true || booleanField(result.output, "stderrTruncated") === true ? "output truncated" : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

export function appendLimitedText(
  current: string,
  truncated: boolean,
  delta: string,
  maxChars: number,
  label: string
): { text: string; truncated: boolean } {
  if (truncated || delta.length === 0) {
    return { text: current, truncated };
  }
  const remaining = maxChars - current.length;
  if (delta.length <= remaining) {
    return { text: current + delta, truncated: false };
  }
  const marker = `\n[${label} truncated after ${maxChars} characters]\n`;
  const sliceLength = Math.max(0, remaining - marker.length);
  return {
    text: `${current}${delta.slice(0, sliceLength)}${marker.slice(0, remaining - sliceLength)}`,
    truncated: true
  };
}

export function normalizeToolCallId(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return randomUUID();
  }
  return trimmed.length > 160 ? trimmed.slice(0, 160) : trimmed;
}

export function toolLoopSyntheticMessages(message: Message): BuiltContext["messages"] {
  const output: BuiltContext["messages"] = [];
  const toolCallParts = message.parts.filter((part) => part.type === "tool_call");
  for (const toolCallPart of toolCallParts) {
    const callId = partString(toolCallPart, "callId");
    if (!callId) {
      continue;
    }
    const relatedParts = message.parts.filter((part) => part.id !== toolCallPart.id && partString(part, "callId") === callId);
    const content = toolLoopContextText(toolCallPart, relatedParts);
    if (!content.trim()) {
      continue;
    }
    output.push({
      role: "user",
      content,
      source: "synthetic",
      messageId: message.id,
      metadata: {
        syntheticKind: "tool_result",
        callId,
        runId: message.runId ?? null
      }
    });
  }
  return output;
}

function toolLoopContextText(toolCallPart: MessagePart, relatedParts: MessagePart[]): string {
  const lines = [
    `[tool call · ${partString(toolCallPart, "toolName") || partString(toolCallPart, "toolId") || "unknown"} · ${partString(toolCallPart, "callId")}]`,
    partString(toolCallPart, "inputSummary") || toolCallPart.text
  ].filter(Boolean);
  for (const part of relatedParts.sort(comparePartsForContext)) {
    if (part.type === "command_output") {
      const outputText = partString(part, "text") || part.text;
      if (outputText.trim()) {
        lines.push(`[command output${partString(part, "stream") ? ` · ${partString(part, "stream")}` : ""}${partNumber(part, "exitCode") !== null ? ` · exit ${partNumber(part, "exitCode")}` : ""}]`);
        lines.push(outputText);
      }
    }
    if (part.type === "tool_result") {
      const status = partString(part, "status") || "completed";
      const body = partString(part, "outputSummary") || partString(part, "output") || partString(part, "error") || part.text;
      lines.push(`[tool result · ${status}]`);
      if (body.trim()) {
        lines.push(body);
      }
    }
  }
  return lines.join("\n");
}

function comparePartsForContext(a: MessagePart, b: MessagePart): number {
  return a.seq - b.seq || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
