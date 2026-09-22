export class ProviderContextLengthError extends Error {
  readonly code = "context_length_exceeded";

  constructor(message = "The provider rejected the request because its context length was exceeded.") {
    super(message);
    this.name = "ProviderContextLengthError";
  }
}

export function isProviderContextLengthFailure(input: {
  status?: number;
  code?: string;
  type?: string;
  message?: string;
}): boolean {
  const code = `${input.code ?? ""} ${input.type ?? ""}`.toLowerCase();
  const message = (input.message ?? "").toLowerCase();
  const explicitCode = /context[_ -]?(length|window).*exceed|maximum[_ -]?context|too[_ -]?many[_ -]?tokens/.test(code);
  const explicitMessage =
    /context (length|window).*(exceed|maximum|too (long|large))|maximum context length|too many tokens|input.*token.*limit/.test(message);
  return explicitCode || ((input.status === 400 || input.status === 413 || input.status === 422) && explicitMessage);
}

export function providerContextLengthErrorIfRecognized(input: {
  status?: number;
  code?: string;
  type?: string;
  message?: string;
}): ProviderContextLengthError | null {
  return isProviderContextLengthFailure(input) ? new ProviderContextLengthError() : null;
}
