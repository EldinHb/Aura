import type { Item } from "../../gen";
import { commandOutput, contextBoundary, durationMs, fmtDuration, itemLabel } from "./format";

export type TranscriptTree = {
  /** Items without a (known) parent, in transcript order. */
  top: Item[];
  /** Subagent id → the items its subagent produced, flattened to the first subagent ancestor. */
  byParent: Map<string, Item[]>;
};

export function transcriptTree(order: string[], items: Record<string, Item>): TranscriptTree {
  const byParent = new Map<string, Item[]>();
  const top: Item[] = [];
  for (const id of order) {
    const it = items[id];
    if (!it) continue;
    if (it.parent_id && items[it.parent_id]) {
      let p = it.parent_id;
      let guard = 0;
      while (items[p]?.parent_id && items[items[p].parent_id!] && guard++ < 8) p = items[p].parent_id!;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p)!.push(it);
    } else top.push(it);
  }
  return { top, byParent };
}

/** The work an agent did on the way to one reply: reasoning, tool calls and in-between messages. */
export type StepGroup = {
  /** The first step's item id; stable while the group grows. */
  id: string;
  items: Item[];
};

/** Items that stay in the chat: messages from the user, replies, errors and context markers. */
function alwaysShown(it: Item): boolean {
  return it.kind === "user_message" || it.kind === "agent_message" || it.kind === "error" || !!contextBoundary(it) || !!commandOutput(it);
}

/**
 * Groups the steps of each reply. A reply runs from a user message (or a new
 * turn) to the next one; inside it every step is grouped, including agent
 * messages written before the last step. The agent messages after the last step
 * are the reply itself and stay in the chat.
 *
 * Returns each grouped item's id mapped to its group.
 */
export function groupSteps(top: Item[]): Map<string, StepGroup> {
  const out = new Map<string, StepGroup>();
  let start = 0;
  const flush = (end: number) => {
    const seg = top.slice(start, end);
    let last = -1;
    seg.forEach((it, i) => {
      if (!alwaysShown(it)) last = i;
    });
    let group: StepGroup | null = null;
    seg.forEach((it, i) => {
      const step = !alwaysShown(it) || (it.kind === "agent_message" && i < last);
      if (!step) return;
      group ??= { id: it.id, items: [] };
      group.items.push(it);
      out.set(it.id, group);
    });
    start = end;
  };
  top.forEach((it, i) => {
    if (i > start && (it.kind === "user_message" || it.turn_id !== top[i - 1].turn_id)) flush(i);
  });
  flush(top.length);
  return out;
}

const NOUNS: Partial<Record<Item["kind"], [string, string]>> = {
  command_exec: ["command", "commands"],
  file_change: ["edit", "edits"],
  tool_call: ["tool call", "tool calls"],
  mcp_call: ["tool call", "tool calls"],
  web_search: ["search", "searches"],
  subagent: ["subagent", "subagents"],
  plan: ["plan update", "plan updates"],
  agent_message: ["message", "messages"],
  system: ["event", "events"],
};

export type StepSummary = {
  count: number;
  /** "thinking, 3 commands, 2 edits" */
  parts: string;
  running: boolean;
  /** Label of the step in progress, when running. */
  current: string | null;
  failed: number;
  duration: string;
};

export function summarizeSteps(items: Item[]): StepSummary {
  const counts = new Map<string, number>();
  let thinking = false;
  let failed = 0;
  let current: Item | null = null;
  for (const it of items) {
    if (it.status === "in_progress") current = it;
    if (it.status === "failed") failed++;
    if (it.kind === "reasoning") {
      thinking = true;
      continue;
    }
    const noun = NOUNS[it.kind];
    if (!noun) continue;
    const key = noun.join();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const nouns = [...counts].map(([key, n]) => `${n} ${key.split(",")[n === 1 ? 0 : 1]}`);
  const parts = [...(thinking ? ["thinking"] : []), ...nouns].join(", ");
  const first = items[0];
  const ends = items.map((it) => it.ended_at).filter((x): x is string => !!x).sort();
  const running = current !== null;
  return {
    count: items.length,
    parts,
    running,
    current: current ? (current.kind === "reasoning" ? "thinking" : itemLabel(current)) : null,
    failed,
    duration: !running && first && ends.length ? fmtDuration(durationMs(first.started_at, ends[ends.length - 1])) : "",
  };
}

/** The transcript tree with reasoning dropped when hidden, and its step groups. */
export function replySteps(order: string[], items: Record<string, Item>, showReasoning: boolean): TranscriptTree & { groups: Map<string, StepGroup> } {
  const tree = transcriptTree(order, items);
  const top = showReasoning ? tree.top : tree.top.filter((it) => it.kind !== "reasoning");
  return { top, byParent: tree.byParent, groups: groupSteps(top) };
}
