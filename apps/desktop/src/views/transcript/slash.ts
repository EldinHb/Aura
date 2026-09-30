import type { SlashCommand } from "../../gen";
import { fuzzyScore } from "../../lib/commands";

export type SlashEntry = { name: string; description: string | null; source: string | null };

const BUILTINS: Record<string, SlashEntry[]> = {
  claude: [
    { name: "clear", description: "Start over with an empty context (the transcript stays visible)", source: "builtin" },
    { name: "compact", description: "Replace the context with a summary to free up space", source: "builtin" },
    { name: "context", description: "Show context window usage", source: "builtin" },
    { name: "model", description: "Show or set the model (e.g. /model sonnet)", source: "builtin" },
    { name: "effort", description: "Set effort level (low, medium, high, xhigh, max)", source: "builtin" },
    { name: "cost", description: "Show session cost", source: "builtin" },
    { name: "usage", description: "Show plan usage limits", source: "builtin" },
    { name: "mcp", description: "Show MCP server status", source: "builtin" },
    { name: "init", description: "Create a CLAUDE.md for this project", source: "builtin" },
    { name: "config", description: "Change a setting (key=value)", source: "builtin" },
  ],
  codex: [
    { name: "compact", description: "Replace the thread's context with a summary to free up space", source: "builtin" },
    { name: "review", description: "Start a code review", source: "builtin" },
    { name: "model", description: "Change model", source: "builtin" },
    { name: "effort", description: "Set reasoning effort", source: "builtin" },
  ],
};

export function builtinSlashCommands(provider: string): SlashEntry[] {
  return BUILTINS[provider] ?? [];
}

/**
 * Merge provider commands with builtins (provider wins on name clashes). A
 * provider command without a description keeps the builtin one: Claude's
 * startup catalogue lists names only.
 */
export function mergeSlashCommands(provider: string, fromProvider: SlashCommand[]): SlashEntry[] {
  const builtins = new Map(builtinSlashCommands(provider).map((b) => [b.name, b]));
  const seen = new Set<string>();
  const out: SlashEntry[] = [];
  for (const c of fromProvider) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({ name: c.name, description: c.description ?? builtins.get(c.name)?.description ?? null, source: c.source ?? "provider" });
  }
  for (const b of builtinSlashCommands(provider)) {
    if (!seen.has(b.name)) {
      seen.add(b.name);
      out.push(b);
    }
  }
  return out;
}

/** Filter + rank by fuzzy match on name (and weakly on description). */
export function filterSlashCommands(entries: SlashEntry[], query: string, limit = 40): SlashEntry[] {
  const q = query.trim();
  if (!q) return entries.slice(0, limit);
  const scored: { s: number; e: SlashEntry }[] = [];
  for (const e of entries) {
    const n = fuzzyScore(e.name, q);
    const d = e.description ? fuzzyScore(e.description, q) : null;
    const s = n !== null ? n + 50 : d !== null ? d - 20 : null;
    if (s !== null) scored.push({ s, e });
  }
  scored.sort((a, b) => b.s - a.s || a.e.name.localeCompare(b.e.name));
  return scored.slice(0, limit).map((x) => x.e);
}

/** Detect an active slash trigger: text is a single token starting with `/` (no spaces yet). */
export function slashQuery(text: string): string | null {
  const m = /^\/([^\s/]*)$/.exec(text);
  return m ? m[1] : null;
}

/** Detect an active `@` mention at the caret: returns the partial path query or null. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}
