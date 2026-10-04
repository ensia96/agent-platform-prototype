/** Redact recognizable credential text before truncation or projection to another context. */
export function redactPublicSecrets(value: string): string {
  return value
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
    .replace(/("(?:(?:access|refresh|id)_?token|api[_-]?key)"\s*:\s*")(?:\\.|[^"\\])*("|$)/gi, "$1[REDACTED]$2")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]");
}

export function sanitizePublicText(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const sanitized = redactPublicSecrets(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
  return sanitized || null;
}
