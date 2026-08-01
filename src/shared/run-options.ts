import type { ReasoningEffort } from "./types";

export const maxReasoningEffortLength = 64;

export function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  if (typeof value !== "string") {
    return null;
  }
  if (hasControlCharacters(value)) {
    return null;
  }
  const effort = value.trim();
  if (!effort || effort.length > maxReasoningEffortLength) {
    return null;
  }
  return effort;
}

export function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
