import type { Binding } from "../../lib/keymap";
import { normalizeChord } from "../../lib/keymap";

export type Conflict = { keys: string; when: string; commands: string[] };

/** Bindings that share identical (normalized) keys and `when` but map to different commands. */
export function findConflicts(bindings: Binding[], isMac: boolean, leader: string): Conflict[] {
  const m = new Map<string, { keys: string; when: string; commands: Set<string> }>();
  for (const b of bindings) {
    if (!b.command) continue;
    const keys = b.keys.split(/\s+/).filter(Boolean).map((c) => normalizeChord(c, isMac, leader)).join(" ");
    const when = (b.when ?? "").replace(/\s+/g, "");
    const k = `${keys}|${when}`;
    if (!m.has(k)) m.set(k, { keys, when, commands: new Set() });
    m.get(k)!.commands.add(b.command);
  }
  return [...m.values()].filter((v) => v.commands.size > 1).map((v) => ({ keys: v.keys, when: v.when, commands: [...v.commands].sort() }));
}

export function isConflicting(b: Binding, conflicts: Conflict[], isMac: boolean, leader: string): boolean {
  const keys = b.keys.split(/\s+/).filter(Boolean).map((c) => normalizeChord(c, isMac, leader)).join(" ");
  const when = (b.when ?? "").replace(/\s+/g, "");
  return conflicts.some((c) => c.keys === keys && c.when === when);
}
