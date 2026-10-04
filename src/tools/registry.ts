import { createShellExecTool } from "./shell-exec";
import type { RegisteredTool } from "./types";
import type { ShellToolSettings, ToolDefinition } from "../shared/types";

export interface DefaultToolRegistryOptions {
  getShellSettings?: () => ShellToolSettings;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool, replace = false): void {
    const id = tool.definition.id.trim();
    if (!id) {
      throw new Error("Tool id is required.");
    }
    if (this.tools.has(id) && !replace) {
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

export function createDefaultToolRegistry(options: DefaultToolRegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createShellExecTool({ getShellSettings: options.getShellSettings }));
  return registry;
}
