export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly body: Record<string, unknown> | null
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

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
    const message = `${body?.message || body?.error || `${response.status} ${response.statusText}`}${issueText}`;
    throw new ApiRequestError(
      message,
      response.status,
      typeof body?.error === "string" ? body.error : null,
      body as Record<string, unknown> | null
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
