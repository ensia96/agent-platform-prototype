import type { JsonObject, ToolDefinition, ToolExecutionEvent, ToolInvocation } from "../shared/types";

export class ToolInputError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "ToolInputError";
  }
}

export interface ToolInputValidationContext {
  workspaceRoot: string;
}

export interface ToolExecutionContext {
  invocation: ToolInvocation;
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
