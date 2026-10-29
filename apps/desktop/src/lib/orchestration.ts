import type { Item, Session } from "../gen";
import { auraMessage } from "./auraMessage";

/**
 * What passes between an orchestrator and its workers, read back from the
 * transcripts both keep:
 *
 * - The orchestrator's messages to a worker (its brief and every follow-up) are
 *   user messages in the worker's transcript. The daemon records the sender in
 *   `data.from_orchestrator`; transcripts stored before it did are read by
 *   `orchestratorMessages` below.
 * - Worker reports are messages from Aura in the orchestrator's transcript,
 *   one section per worker (`### Title (`id`) · agent · model · effort · status`).
 */

/** One worker's part of a worker report. */
export type ReportSection = {
  workerId: string;
  title: string;
  /** "claude · opus · high · idle": the heading after the worker's id. */
  detail: string;
  /** The last part of the heading: "idle", "failed", "waiting for the user's answer". */
  status: string;
  /** The section without its heading. */
  body: string;
};

/** A worker's heading: its title, its session id (a UUID) and what follows. */
const HEADING = /^### (.*) \(`([0-9a-f]{8}-[0-9a-f-]{27})`\) · (.*)$/;

/** A report's sections, one per worker. */
export function reportSections(body: string): ReportSection[] {
  const out: ReportSection[] = [];
  let lines: string[] = [];
  const close = () => {
    const last = out[out.length - 1];
    if (last) last.body = lines.join("\n").trim();
    lines = [];
  };
  for (const line of body.split("\n")) {
    const m = HEADING.exec(line);
    if (m) {
      close();
      const detail = m[3];
      out.push({ workerId: m[2], title: m[1], detail, status: detail.split(" · ").pop() ?? "", body: "" });
    } else lines.push(line);
  }
  close();
  return out;
}

/** The workers a message from Aura reports on, in its order. */
export function reportedWorkers(item: Item): ReportSection[] {
  const aura = auraMessage(item);
  return aura?.report ? reportSections(aura.body) : [];
}

/** Whom a user message in a worker's transcript came from. */
export type Sender = "orchestrator" | "user" | "aura";

/**
 * Texts the orchestrator gave workers with `start_session`, `send_message` and
 * (a feature owner) `hire`,
 * read from the tool calls in its transcript. Claude Code, Codex and ACP
 * agents all record the call's arguments in `data.input`.
 */
export function sentTexts(items: Iterable<Item>): Set<string> {
  const out = new Set<string>();
  for (const it of items) {
    if (it.kind !== "tool_call" && it.kind !== "mcp_call") continue;
    const d = it.data as { tool?: unknown; tool_name?: unknown; input?: unknown };
    const name = [d.tool, d.tool_name, it.title].find((n): n is string => typeof n === "string" && /(start_session|send_message|hire)$/.test(n));
    const input = d.input as { text?: unknown; prompt?: unknown } | null | undefined;
    if (!name || !input || typeof input !== "object") continue;
    const text = name.endsWith("send_message") ? input.text : input.prompt;
    if (typeof text === "string" && text.trim()) out.add(text.trim());
  }
  return out;
}

export type Origins = {
  /** User message id → who sent it. */
  senders: Map<string, Sender>;
  /** Whether telling them apart needs the texts the orchestrator sent (see `sentTexts`). */
  needsSent: boolean;
};

/**
 * Who sent each top-level user message of a worker: its orchestrator, the user,
 * or Aura. Messages the daemon marked say so themselves. Before it marked them,
 * a worker's first message was always its brief; later ones are the
 * orchestrator's when their text is one it sent (`sent`, from its transcript),
 * the user's otherwise. A marked message ends that guessing: whatever is
 * unmarked after it was the user's.
 */
export function orchestratorMessages(worker: Pick<Session, "orchestrator_id">, top: Item[], sent?: ReadonlySet<string>): Origins {
  const senders = new Map<string, Sender>();
  let needsSent = false;
  if (!worker.orchestrator_id) {
    for (const it of top) if (it.kind === "user_message") senders.set(it.id, auraMessage(it) ? "aura" : "user");
    return { senders, needsSent };
  }
  let marked = false;
  let first = true;
  for (const it of top) {
    if (it.kind !== "user_message") continue;
    let sender: Sender;
    if (auraMessage(it)) sender = "aura";
    else if (typeof it.data.from_orchestrator === "string") {
      sender = "orchestrator";
      marked = true;
    } else if (marked) sender = "user";
    else if (first) sender = "orchestrator";
    else {
      needsSent = true;
      sender = sent?.has(it.text.trim()) ? "orchestrator" : "user";
    }
    first = false;
    senders.set(it.id, sender);
  }
  return { senders, needsSent: needsSent && !sent };
}

export type ThreadEntry =
  /** The orchestrator to the worker: its brief (the first) or a follow-up. */
  | { kind: "orchestrator"; item: Item; brief: boolean }
  /** The user, writing to the worker directly. */
  | { kind: "user"; item: Item }
  /** Aura to the worker, such as review activity. */
  | { kind: "aura"; item: Item }
  /** The worker's reply: its last message before the next one it was sent. */
  | { kind: "reply"; item: Item }
  /** Aura telling the orchestrator how the worker stopped. */
  | { kind: "report"; item: Item; section: ReportSection };

/**
 * The conversation between an orchestrator and one worker, in time order:
 * what was sent to the worker and its replies (from the worker's transcript),
 * and the worker's sections of the reports (from the orchestrator's).
 */
export function workerThread(workerId: string, workerTop: Item[], senders: Map<string, Sender>, orchestratorTop: Item[]): ThreadEntry[] {
  const out: { at: string; order: number; entry: ThreadEntry }[] = [];
  const push = (entry: ThreadEntry) => out.push({ at: entry.item.started_at, order: out.length, entry });
  let reply: Item | null = null;
  let briefed = false;
  const flush = () => {
    if (reply) push({ kind: "reply", item: reply });
    reply = null;
  };
  for (const it of workerTop) {
    if (it.kind === "user_message") {
      flush();
      const sender = senders.get(it.id) ?? "user";
      if (sender === "orchestrator") {
        push({ kind: "orchestrator", item: it, brief: !briefed });
        briefed = true;
      } else push({ kind: sender, item: it });
    } else if (it.kind === "agent_message" && it.text.trim()) reply = it;
  }
  flush();
  for (const it of orchestratorTop) {
    for (const section of reportedWorkers(it)) if (section.workerId === workerId) push({ kind: "report", item: it, section });
  }
  // Stable: entries at the same moment keep the order they were found in.
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order).map((x) => x.entry);
}
