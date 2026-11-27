import type { Session } from "../gen";
import { forestOf } from "../state/forest";

/**
 * The folder a session works in, or null for an orchestrator that belongs to
 * none: its `cwd` is a directory Aura made for it, not the user's.
 */
export function folderOf(s: Pick<Session, "cwd"> & { folderless?: boolean }): string | null {
  return s.folderless ? null : s.cwd;
}

/** The sessions under an orchestrator: its workers, theirs, and so on, each once (see state/forest.ts). */
export function workersUnder(id: string, sessions: Record<string, Session>): Session[] {
  return forestOf(sessions).descendantsOf(id);
}
