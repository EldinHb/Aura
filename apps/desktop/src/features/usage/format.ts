/**
 * Usage numbers and periods, shared by the dashboards and the line under each
 * reply. Costs an agent did not report are estimates from Aura's price table
 * (crates/aura-core/src/pricing.rs); they show with a "~".
 */
import type { TurnUsage, Usage, UsageTotals } from "../../gen";

export function fmtTokens(n: number | null | undefined): string {
  if (!n) return "0";
  if (n >= 1_000_000_000) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1e3)}k`;
  if (n >= 1000) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function fmtCost(c: number | null | undefined, estimated = false): string {
  if (c === null || c === undefined) return "—";
  const s = c >= 100 ? `$${c.toFixed(0)}` : c >= 0.995 || c === 0 ? `$${c.toFixed(2)}` : `$${c.toFixed(3)}`;
  return estimated ? `~${s}` : s;
}

export function fmtPct(x: number | null): string {
  return x === null ? "—" : `${Math.round(x * 100)}%`;
}

export const totalTokens = (t: UsageTotals) => t.inputTokens + t.outputTokens + t.cachedInputTokens;

/** Cache reads as a share of all input (uncached input plus cache reads and writes). */
export function cacheHitRate(t: Pick<UsageTotals, "inputTokens" | "cachedInputTokens" | "cacheWriteTokens">): number | null {
  const input = t.inputTokens + t.cachedInputTokens;
  return input > 0 ? (t.cachedInputTokens - t.cacheWriteTokens) / input : null;
}

/** "+25%" / "−10%" / "new" / "" against the period before. */
export function change(now: number, before: number): { text: string; dir: "up" | "down" | "flat" } | null {
  if (before <= 0) return now > 0 ? { text: "new", dir: "up" } : null;
  const pct = ((now - before) / before) * 100;
  if (Math.abs(pct) < 0.5) return { text: "±0%", dir: "flat" };
  return pct > 0 ? { text: `+${pct.toFixed(0)}%`, dir: "up" } : { text: `−${(-pct).toFixed(0)}%`, dir: "down" };
}

/** What one turn spent, for the line under a reply: the daemon's record when it has one, else the turn's own usage. */
export type TurnLine = {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  contextUsed: number | null; contextWindow: number | null;
  cost: number | null; estimated: boolean;
};

export function turnLine(record: TurnUsage | undefined, usage: Usage | null): TurnLine | null {
  if (record) {
    return {
      input: record.inputTokens, output: record.outputTokens, cacheRead: record.cacheReadTokens, cacheWrite: record.cacheWriteTokens,
      contextUsed: record.contextUsed, contextWindow: record.contextWindow, cost: record.costUsd, estimated: record.estimated,
    };
  }
  if (!usage) return null;
  const write = usage.cache_write_tokens ?? 0;
  return {
    input: usage.input_tokens, output: usage.output_tokens, cacheRead: Math.max(0, usage.cached_input_tokens - write), cacheWrite: write,
    contextUsed: usage.context_used, contextWindow: usage.context_window, cost: usage.total_cost_usd, estimated: false,
  };
}

/** The compact line: "1.2k in · 300 out · 12k cache · ctx 45% · $0.03". */
export function compactLine(l: TurnLine): string {
  const parts = [`${fmtTokens(l.input)} in`, `${fmtTokens(l.output)} out`];
  const cache = l.cacheRead + l.cacheWrite;
  if (cache > 0) parts.push(`${fmtTokens(cache)} cache`);
  if (l.contextUsed && l.contextWindow) parts.push(`ctx ${fmtPct(l.contextUsed / l.contextWindow)}`);
  else if (l.contextUsed) parts.push(`ctx ${fmtTokens(l.contextUsed)}`);
  if (l.cost !== null) parts.push(fmtCost(l.cost, l.estimated));
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Periods

export type PeriodKey = "today" | "yesterday" | "7d" | "30d" | "week" | "custom";
export type Period = { key: PeriodKey; from: Date; to: Date; label: string };

const DAY = 86_400_000;
function midnight(d: Date): Date {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  return m;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** A period ending now (or, for yesterday and custom, at the end of its last day), local time. */
export function period(key: PeriodKey, now = new Date(), custom?: { from: string; to: string }): Period {
  const today = midnight(now);
  const tomorrow = addDays(today, 1);
  switch (key) {
    case "today": return { key, from: today, to: tomorrow, label: "Today" };
    case "yesterday": return { key, from: addDays(today, -1), to: today, label: "Yesterday" };
    case "7d": return { key, from: addDays(today, -6), to: tomorrow, label: "Last 7 days" };
    case "30d": return { key, from: addDays(today, -29), to: tomorrow, label: "Last 30 days" };
    case "week": {
      // Weeks start on Monday.
      const back = (today.getDay() + 6) % 7;
      return { key, from: addDays(today, -back), to: tomorrow, label: "This week" };
    }
    case "custom": {
      const from = custom?.from ? midnight(new Date(`${custom.from}T00:00:00`)) : today;
      const last = custom?.to ? midnight(new Date(`${custom.to}T00:00:00`)) : today;
      const to = addDays(last < from ? from : last, 1);
      return { key, from, to, label: `${from.toLocaleDateString()} – ${addDays(to, -1).toLocaleDateString()}` };
    }
  }
}

/** The period of the same length right before. */
export function previous(p: Period): { from: Date; to: Date } {
  const len = p.to.getTime() - p.from.getTime();
  return { from: new Date(p.from.getTime() - len), to: p.from };
}

/** The caller's offset from UTC in minutes, east positive, as the daemon wants it. */
export function tzOffsetMinutes(at = new Date()): number {
  return -at.getTimezoneOffset();
}

export function days(p: { from: Date; to: Date }): number {
  return Math.round((p.to.getTime() - p.from.getTime()) / DAY);
}

/** "2026-11-03" → "Tue 3", or "3 Nov" for long ranges. */
export function dayLabel(key: string, long: boolean): string {
  const d = new Date(`${key}T00:00:00`);
  return long ? d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}
