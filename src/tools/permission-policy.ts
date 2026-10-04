import { resolve } from "node:path";
import {
  activeRegexPatternSources,
  evaluateToolPermission as evaluateCommandPermission,
  type ToolSettingsPermissionMatch
} from "../shared/tool-settings";
import type {
  JsonObject,
  PermissionPolicy,
  PermissionPolicyAction,
  PermissionRiskLevel,
  ToolDefinition,
  ToolInvocationCaller,
  ToolPermissionDecision,
  ToolSettings
} from "../shared/types";

export interface ToolPermissionEvaluation {
  decision: ToolPermissionDecision;
  action: PermissionPolicyAction;
  riskLevel: PermissionRiskLevel;
  reason: string;
  ruleId: string;
  policy: PermissionPolicy;
  matchedPattern?: ToolSettingsPermissionMatch;
}

export interface ToolPermissionInput {
  tool: ToolDefinition;
  caller: ToolInvocationCaller;
  publicInput: JsonObject;
  executionInput: JsonObject;
  executionCwd: string;
  settings: ToolSettings;
}

export function evaluateToolPermission(input: ToolPermissionInput): ToolPermissionEvaluation {
  const policy = createPermissionPolicy(input.executionCwd, input.settings);
  if (input.tool.id === "subsession.start") {
    return evaluation("ask", "subsession.target.approval", "Approve this exact target Agent revision, task, and tool authority. Child tool approvals are separate.", "high", policy);
  }

  if (input.tool.id !== "shell.exec") {
    return evaluation("ask", "tool.unknown", "Unknown or future tools require explicit approval.", "medium", policy);
  }

  return evaluateShellExecPermission(input, policy);
}

export function createPermissionPolicy(executionCwd: string, settings: ToolSettings): PermissionPolicy {
  return {
    id: "user.tool-settings",
    version: 1,
    experimental: true,
    defaultAction: settings.defaultAction,
    executionCwd: resolve(executionCwd),
    shell: {
      defaultAction: settings.defaultAction,
      rules: [
        {
          id: "shell.regex.deny",
          action: "deny",
          riskLevel: "high",
          description: "User-configured deny regex patterns from Tool Settings.",
          patterns: activeRegexPatternSources(settings.denyPatternsText)
        },
        {
          id: "shell.regex.ask",
          action: "ask",
          riskLevel: "medium",
          description: "User-configured ask regex patterns from Tool Settings.",
          patterns: activeRegexPatternSources(settings.askPatternsText)
        },
        {
          id: "shell.regex.allow",
          action: "allow",
          riskLevel: "low",
          description: "User-configured allow regex patterns from Tool Settings.",
          patterns: activeRegexPatternSources(settings.allowPatternsText)
        },
        {
          id: "shell.default",
          action: settings.defaultAction,
          riskLevel: riskLevelForAction(settings.defaultAction),
          description: "Tool Settings default action when no regex pattern matches."
        }
      ]
    }
  };
}

function evaluateShellExecPermission(input: ToolPermissionInput, policy: PermissionPolicy): ToolPermissionEvaluation {
  const command = stringField(input.executionInput, "command").trim();

  if (!command) {
    return evaluation("deny", "shell.command.empty", "shell.exec requires a non-empty command.", "high", policy);
  }

  const commandEvaluation = evaluateCommandPermission(command, input.settings);
  const matchedPattern = commandEvaluation.matchedPattern;
  if (matchedPattern) {
    return evaluation(
      commandEvaluation.action,
      `shell.regex.${commandEvaluation.source}.line-${matchedPattern.lineNumber}`,
      `Command matched ${commandEvaluation.source} regex on line ${matchedPattern.lineNumber}: ${matchedPattern.pattern}`,
      riskLevelForAction(commandEvaluation.action),
      policy,
      matchedPattern
    );
  }

  return evaluation(
    commandEvaluation.action,
    `shell.default.${commandEvaluation.action}`,
    `No Tool Settings regex matched; default action '${commandEvaluation.action}' applied.`,
    riskLevelForAction(commandEvaluation.action),
    policy
  );
}

function evaluation(
  action: PermissionPolicyAction,
  ruleId: string,
  reason: string,
  riskLevel: PermissionRiskLevel,
  policy: PermissionPolicy,
  matchedPattern?: ToolSettingsPermissionMatch
): ToolPermissionEvaluation {
  return {
    action,
    decision: actionToDecision(action),
    riskLevel,
    reason,
    ruleId,
    policy,
    matchedPattern
  };
}

function actionToDecision(action: PermissionPolicyAction): ToolPermissionDecision {
  if (action === "allow") {
    return "allowed";
  }
  if (action === "deny") {
    return "denied";
  }
  return "requires_approval";
}

function riskLevelForAction(action: PermissionPolicyAction): PermissionRiskLevel {
  if (action === "allow") {
    return "low";
  }
  if (action === "deny") {
    return "high";
  }
  return "medium";
}

function stringField(object: JsonObject, key: string): string {
  const value = object[key];
  return typeof value === "string" ? value : "";
}
