import type { Session } from "../gen";

/**
 * The folder a session works in, or null for an orchestrator that belongs to
 * none: its `cwd` is a directory Aura made for it, not the user's.
 */
export function folderOf(s: Pick<Session, "cwd"> & { folderless?: boolean }): string | null {
  return s.folderless ? null : s.cwd;
}

/** The sessions under an orchestrator: its workers, theirs, and so on. */
export function workersUnder(id: string, sessions: Record<string, Session>): Session[] {
  const out: Session[] = [];
  const parents = [id];
  const seen = new Set(parents);
  while (parents.length) {
    const parent = parents.shift()!;
    for (const s of Object.values(sessions)) {
      if (s.orchestrator_id !== parent || seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
      parents.push(s.id);
    }
  }
  return out;
}
