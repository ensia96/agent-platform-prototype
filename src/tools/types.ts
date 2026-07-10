import type { JsonObject, ToolDefinition, ToolExecutionEvent, ToolInvocation } from "../shared/types";

export class ToolInputError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "ToolInputError";
  }
}

export interface ToolInputValidationContext {
  /** Default execution cwd supplied by the session workingDirectory. */
  cwd: string;
  /** Deprecated compatibility alias for the current default execution cwd. */
  workspaceRoot: string;
}

export interface ToolExecutionContext {
  invocation: ToolInvocation;
  /** Default execution cwd supplied by the session workingDirectory. */
  cwd: string;
  /** Deprecated compatibility alias for the current default execution cwd. */
  workspaceRoot: string;
  signal: AbortSignal;
  emit(event: ToolExecutionEvent): void | Promise<void>;
}

export interface ToolExecutor {
  validateInput?(input: JsonObject, context: ToolInputValidationContext): JsonObject;
  toPublicInput?(input: JsonObject, context: ToolInputValidationContext): JsonObject;
  execute(input: JsonObject, context: ToolExecutionContext): Promise<JsonObject>;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  executor: ToolExecutor;
}
