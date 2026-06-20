import type { RunUsage } from "../shared/types";

const usageContainerKeys = [
  "usage",
  "token_usage",
  "tokenUsage",
  "usage_metadata",
  "usageMetadata",
  "response",
  "message",
  "result",
  "metadata"
];

export function extractRunUsage(value: unknown): RunUsage | null {
  const direct = normalizeRunUsage(value);
  if (direct) {
    return direct;
  }
  return findNestedUsage(value, 0);
}

export function normalizeRunUsage(value: unknown): RunUsage | null {
  if (!isRecord(value)) {
    return null;
  }

  const inputTokens = firstNumber(value, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
  const outputTokens = firstNumber(value, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
  const totalTokens = firstNumber(value, ["totalTokens", "total_tokens"]);
  const reasoningTokens =
    firstNumber(value, ["reasoningTokens", "reasoning_tokens"]) ??
    firstNumber(value.completion_tokens_details, ["reasoningTokens", "reasoning_tokens"]) ??
    firstNumber(value.output_tokens_details, ["reasoningTokens", "reasoning_tokens"]) ??
    firstNumber(value.details, ["reasoningTokens", "reasoning_tokens"]);

  const usage: RunUsage = {};
  if (inputTokens !== undefined) {
    usage.inputTokens = inputTokens;
  }
  if (outputTokens !== undefined) {
    usage.outputTokens = outputTokens;
  }
  if (reasoningTokens !== undefined) {
    usage.reasoningTokens = reasoningTokens;
  }
  if (totalTokens !== undefined) {
    usage.totalTokens = totalTokens;
  } else if (inputTokens !== undefined && outputTokens !== undefined) {
    usage.totalTokens = inputTokens + outputTokens;
  }

  return Object.keys(usage).length > 0 ? usage : null;
}

function findNestedUsage(value: unknown, depth: number): RunUsage | null {
  if (depth > 4) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const usage = normalizeRunUsage(item) ?? findNestedUsage(item, depth + 1);
      if (usage) {
        return usage;
      }
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  for (const key of usageContainerKeys) {
    if (!(key in value)) {
      continue;
    }
    const nested = value[key];
    const usage = normalizeRunUsage(nested) ?? findNestedUsage(nested, depth + 1);
    if (usage) {
      return usage;
    }
  }

  return null;
}

function firstNumber(value: unknown, keys: string[]): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const numberValue = tokenNumber(value[key]);
    if (numberValue !== undefined) {
      return numberValue;
    }
  }
  return undefined;
}

function tokenNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
