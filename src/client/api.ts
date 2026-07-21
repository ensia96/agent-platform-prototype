export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
      issues?: Array<{ field?: string; lineNumber?: number; pattern?: string; message?: string }>;
    } | null;
    const issueText = body?.issues?.length
      ? `\n${body.issues
          .map((issue) => {
            const location = issue.lineNumber ? `${issue.field ?? "field"} line ${issue.lineNumber}` : issue.field ?? "field";
            return `${location}: ${issue.message ?? "Invalid value"}${issue.pattern ? ` (${issue.pattern})` : ""}`;
          })
          .join("\n")}`
      : "";
    throw new Error(`${body?.message || body?.error || `${response.status} ${response.statusText}`}${issueText}`);
  }
  return (await response.json()) as T;
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
