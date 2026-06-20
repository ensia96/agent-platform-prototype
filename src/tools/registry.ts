import { createShellExecTool } from "./shell-exec";
import type { RegisteredTool } from "./types";
import type { ToolDefinition } from "../shared/types";

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    const id = tool.definition.id.trim();
    if (!id) {
      throw new Error("Tool id is required.");
    }
    if (this.tools.has(id)) {
      throw new Error(`Tool '${id}' is already registered.`);
    }
    this.tools.set(id, tool);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition).sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): RegisteredTool | null {
    return this.tools.get(id) ?? null;
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createShellExecTool());
  return registry;
}
