import type { Session } from "../shared/types";

export type SessionMutationField = "agentId" | "workingDirectory";

export function mergeSessionMutation(
  current: Session,
  response: Session,
  fields: readonly SessionMutationField[]
): Session {
  if (current.id !== response.id) {
    return current;
  }
  return {
    ...current,
    ...(fields.includes("agentId") ? { agentId: response.agentId } : {}),
    ...(fields.includes("workingDirectory") ? { workingDirectory: response.workingDirectory } : {}),
    updatedAt: current.updatedAt > response.updatedAt ? current.updatedAt : response.updatedAt
  };
}
