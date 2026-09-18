/** Pure filtering / grouping for the command palette. */
import { fuzzyScore } from "../lib/commands";

export type PaletteCommand = { id: string; title: string; group: string; keywords?: string[] };
export type PaletteSection<T> = { label: string; items: T[] };

export const RECENT_KEY = "aura.palette.recent";
export const RECENT_MAX = 8;

export function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function pushRecent(id: string, current: string[] = loadRecent()): string[] {
  const next = [id, ...current.filter((x) => x !== id)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

/**
 * Empty query: a "Recent" section followed by every command grouped by group
 * (groups alphabetical, titles alphabetical). With a query: fuzzy scored,
 * groups ordered by their best score, items by score.
 */
export function buildSections(commands: PaletteCommand[], query: string, recent: string[] = []): PaletteSection<PaletteCommand>[] {
  const q = query.trim();
  if (!q) {
    const byId = new Map(commands.map((c) => [c.id, c]));
    const recentItems = recent.map((id) => byId.get(id)).filter((c): c is PaletteCommand => !!c);
    const groups = new Map<string, PaletteCommand[]>();
    for (const c of [...commands].sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title))) {
      if (!groups.has(c.group)) groups.set(c.group, []);
      groups.get(c.group)!.push(c);
    }
    const sections: PaletteSection<PaletteCommand>[] = [];
    if (recentItems.length) sections.push({ label: "Recent", items: recentItems });
    for (const [label, items] of groups) sections.push({ label, items });
    return sections;
  }
  const scored = commands
    .map((c) => ({ c, score: fuzzyScore(`${c.title} ${c.group} ${(c.keywords ?? []).join(" ")}`, q) }))
    .filter((x): x is { c: PaletteCommand; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.c.title.localeCompare(b.c.title));
  const groups = new Map<string, { best: number; items: PaletteCommand[] }>();
  for (const { c, score } of scored) {
    const g = groups.get(c.group);
    if (g) g.items.push(c);
    else groups.set(c.group, { best: score, items: [c] });
  }
  return [...groups.entries()].sort((a, b) => b[1].best - a[1].best).map(([label, g]) => ({ label, items: g.items }));
}

/** Flatten sections into a selectable list, preserving section boundaries. */
export function flattenSections<T>(sections: PaletteSection<T>[]): { item: T; section: string; first: boolean }[] {
  const out: { item: T; section: string; first: boolean }[] = [];
  for (const s of sections) s.items.forEach((item, i) => out.push({ item, section: s.label, first: i === 0 }));
  return out;
}

/** Generic fuzzy filter for pickers. */
export function filterItems<T>(items: T[], query: string, text: (t: T) => string): T[] {
  const q = query.trim();
  if (!q) return items;
  return items
    .map((t) => ({ t, score: fuzzyScore(text(t), q) }))
    .filter((x): x is { t: T; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.t);
}
