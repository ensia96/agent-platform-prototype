import type { Session } from "../shared/types";

/** Loading alone has no UI side effects. Only a still-current navigation may apply its snapshot. */
export async function navigateToRelatedSession(input: {
  targetId: string;
  load: () => Promise<Session[]>;
  isCurrent: () => boolean;
  apply: (sessions: Session[], targetId: string) => void;
  onError: (error: unknown) => void;
}): Promise<void> {
  try {
    const sessions = await input.load();
    if (!input.isCurrent()) return;
    if (!sessions.some((session) => session.id === input.targetId)) throw new Error("Related session is no longer available.");
    input.apply(sessions, input.targetId);
  } catch (error) {
    if (input.isCurrent()) input.onError(error);
  }
}
