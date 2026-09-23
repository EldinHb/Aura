import type { Item } from "../gen";
import type { Transcript } from "../state/store";

export type SessionPlan = { id: string; title: string; text: string; steps: { step: string; status: string }[]; position: number };
export function planContent(value: unknown): Pick<SessionPlan, "text" | "steps"> | null {
  if (typeof value === "string") return value.trim() ? { text: value, steps: [] } : null;
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const entries = Array.isArray(value) ? value : data.steps ?? data.plan ?? data.todos;
  const steps = Array.isArray(entries) ? entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const step = row.step ?? row.content;
    return typeof step === "string" ? [{ step, status: typeof row.status === "string" ? row.status : "pending" }] : [];
  }) : [];
  const text = typeof data.text === "string" ? data.text : typeof data.plan === "string" ? data.plan : "";
  return steps.length || text.trim() ? { steps, text } : null;
}

function itemPlan(item: Item, pinned: boolean) {
  if (item.parent_id && !pinned) return null;
  if (item.kind === "plan") return planContent(item.data) ?? planContent(item.text);
  const input = item.data.input as Record<string, unknown> | undefined;
  if (item.data.tool_name === "TodoWrite") return planContent(input);
  if (item.data.tool_name === "ExitPlanMode") return planContent(input?.plan);
  if (item.data.tool_name === "Write" && typeof input?.file_path === "string" && /[/\\]plans[/\\].*\.md$/.test(input.file_path)) return planContent(input.content);
  if (item.kind === "agent_message" && (pinned || (
    /(?:^#{1,6}\s+.*\b(?:plan|implementation steps)\b|\b(?:here is|here's|proposed|implementation)\s+(?:the |my |a )?plan\b)/im.test(item.text)
    && /^\s*(?:\d+[.)]|[-*])\s+\S/m.test(item.text)
  ))) return planContent(item.text);
  return null;
}

export function sessionPlans(transcript: Transcript | null | undefined, pinnedId?: string): SessionPlan[] {
  if (!transcript) return [];
  const plans = [...Object.values(transcript.planSnapshots ?? {})];
  transcript.order.forEach((id, index) => {
    const item = transcript.items[id];
    if (!item) return;
    const content = itemPlan(item, id === pinnedId);
    if (!content) return;
    plans.push({ id, title: item.kind === "agent_message" ? "Agent plan" : item.title || "Plan", ...content, position: index * 2 });
  });
  return plans.sort((a, b) => a.position - b.position);
}
