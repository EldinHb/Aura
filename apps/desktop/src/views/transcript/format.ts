import type { Item } from "../../gen";

export function durationMs(start: string, end: string | null): number | null {
  if (!end) return null;
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

export function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i < 0 ? s : s.slice(0, i);
}

export function prettyJson(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "ctx";

export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  return "ctx";
}

type Change = { path?: string; kind?: string; diff?: string };

export function itemChanges(item: Item): Change[] {
  const c = item.data.changes;
  return Array.isArray(c) ? (c as Change[]) : [];
}

/** Short one-line label for a card header. */
export function itemLabel(item: Item): string {
  const d = item.data as Record<string, unknown>;
  switch (item.kind) {
    case "command_exec":
      return truncate(firstLine(String(d.command ?? item.title ?? "command")), 120);
    case "file_change": {
      const paths = itemChanges(item).map((c) => c.path ?? "?");
      return paths.length ? truncate(paths.join(", "), 120) : item.title ?? "file change";
    }
    case "tool_call":
      return String(d.tool_name ?? item.title ?? "tool");
    case "mcp_call":
      return `${d.server ?? "mcp"} · ${d.tool ?? item.title ?? "tool"}`;
    case "web_search":
      return truncate(String(d.query ?? d.url ?? item.title ?? "search"), 120);
    case "subagent":
      return truncate(String(d.description ?? item.title ?? "subagent"), 120);
    case "plan":
      return item.title ?? "plan";
    case "error":
      return truncate(String(d.message ?? item.text ?? item.title ?? "error"), 120);
    case "system":
      return truncate(String(d.message ?? item.title ?? firstLine(item.text) ?? "system"), 120);
    default:
      return item.title ?? item.kind;
  }
}

export function kindIcon(kind: Item["kind"]): string {
  switch (kind) {
    case "command_exec":
      return "$";
    case "file_change":
      return "±";
    case "tool_call":
      return "⚙";
    case "mcp_call":
      return "⇄";
    case "web_search":
      return "🔍";
    case "subagent":
      return "⑂";
    case "plan":
      return "☰";
    case "error":
      return "!";
    case "system":
      return "ℹ";
    case "reasoning":
      return "…";
    default:
      return "";
  }
}

export function isCardKind(kind: Item["kind"]): boolean {
  return !["user_message", "agent_message", "reasoning"].includes(kind);
}

export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return "";
  return `$${v.toFixed(v < 1 ? 3 : 2)}`;
}

export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function relTime(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  const s = Math.floor(d / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export type ContextBoundary = { kind: "clear" | "compact"; title: string; detail: string | null };

/** A clear or compaction marker: the agent's context starts over at this item. */
export function contextBoundary(item: Item): ContextBoundary | null {
  if (item.kind !== "system") return null;
  const d = item.data as Record<string, unknown>;
  if (d.boundary === "clear") {
    return { kind: "clear", title: "Context cleared", detail: "The agent no longer sees anything above this line" };
  }
  if (d.boundary !== "compact") return null;
  if (item.status === "in_progress") return { kind: "compact", title: "Compacting context…", detail: null };
  if (item.status === "failed") return { kind: "compact", title: String(d.message ?? "Compaction failed"), detail: "Context unchanged" };
  const pre = typeof d.pre_tokens === "number" ? d.pre_tokens : null;
  const post = typeof d.post_tokens === "number" ? d.post_tokens : null;
  const tokens = pre !== null && post !== null ? ` (${fmtTokens(pre)} → ${fmtTokens(post)} tokens)` : "";
  return {
    kind: "compact",
    title: String(d.message ?? "Context compacted"),
    detail: `The agent sees a summary of everything above this line${tokens}`,
  };
}

/** Index of the last item that replaced the agent's context, or -1. */
export function lastBoundaryIndex(items: Item[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].status === "completed" && contextBoundary(items[i])) return i;
  }
  return -1;
}

/** Output of a slash command the CLI ran itself; `name` is null when unknown. */
export function commandOutput(item: Item): { name: string | null } | null {
  const d = item.data as Record<string, unknown>;
  if (item.kind !== "system" || !("command" in d)) return null;
  return { name: typeof d.command === "string" && d.command ? d.command : null };
}

/** `/compact keep it short` is a slash command; `/src/a.ts is broken` is not. */
export function isSlashCommand(text: string): boolean {
  return /^\/[\w:.-]+(\s|$)/.test(text.trimStart());
}
