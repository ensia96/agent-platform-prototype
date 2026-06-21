import type { ModelToolDefinition, ToolDefinition } from "./types";

export const shellExecProviderToolName = "shell_exec";
export const defaultMainAgentToolIds = ["shell.exec"];

const providerToolNamesById: Record<string, string> = {
  "shell.exec": shellExecProviderToolName
};

const toolIdsByProviderToolName = Object.fromEntries(
  Object.entries(providerToolNamesById).map(([toolId, providerName]) => [providerName, toolId])
) as Record<string, string>;

export function toModelToolDefinition(tool: ToolDefinition): ModelToolDefinition | null {
  const providerName = toolIdToProviderToolName(tool.id);
  if (!providerName) {
    return null;
  }

  return {
    id: tool.id,
    providerName,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    metadata: {
      ...tool.metadata,
      canonicalToolId: tool.id,
      providerToolName: providerName
    }
  };
}

export function toolIdToProviderToolName(toolId: string): string | null {
  return providerToolNamesById[toolId] ?? null;
}

export function providerToolNameToToolId(providerName: string): string | null {
  return toolIdsByProviderToolName[providerName.trim()] ?? null;
}
