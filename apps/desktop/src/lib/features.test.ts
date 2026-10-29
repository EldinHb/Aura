import { expect, it } from "vitest";
import type { Feature, Item, UserQuestion } from "../gen";
import { describeAutonomy, featureCard, openQuestions } from "./features";
import { groupSteps } from "../views/transcript/replySteps";

const item = (id: string, kind: Item["kind"], patch: Partial<Item> = {}): Item => ({ id, session_id: "o", turn_id: "t1", kind, status: "completed", title: null, text: "", data: {}, parent_id: null, started_at: "", ended_at: null, ...patch });

it("reads the card a system item stands for, and nothing else", () => {
  expect(featureCard(item("c", "system", { data: { feature_card: { kind: "decision", id: "q1" }, message: "Which?" } }))).toEqual({ kind: "decision", id: "q1" });
  expect(featureCard(item("c", "system", { data: { feature_card: { kind: "report", id: "report" } } }))).toEqual({ kind: "report", id: "report" });
  expect(featureCard(item("c", "system", { data: { feature_card: { kind: "poll", id: "x" } } }))).toBeNull();
  expect(featureCard(item("c", "system", { data: { message: "compacted" } }))).toBeNull();
  expect(featureCard(item("c", "tool_call", { data: { feature_card: { kind: "decision", id: "q1" } } }))).toBeNull();
});

it("keeps a feature owner's cards in the chat while the steps around them fold", () => {
  const top = [
    item("u", "user_message", { text: "Build it" }),
    item("tool", "mcp_call"),
    item("card", "system", { data: { feature_card: { kind: "decision", id: "q1" } } }),
    item("tool2", "mcp_call"),
    item("reply", "agent_message", { text: "Asked you." }),
  ];
  const groups = groupSteps(top);
  expect(groups.has("card")).toBe(false);
  expect(groups.get("tool")?.items.map((i) => i.id)).toEqual(["tool", "tool2"]);
  expect(groups.has("reply")).toBe(false);
});

it("words autonomy as the daemon does and finds the open questions", () => {
  expect(describeAutonomy({ level: "autonomous", checkpoints: [] })).toBe("autonomous");
  expect(describeAutonomy({ level: "blocking_decisions", checkpoints: ["after_design"] })).toBe("blocking decisions");
  expect(describeAutonomy({ level: "checkpoints", checkpoints: ["before_delivery", "after_design"] })).toBe("checkpoints (after design, before delivery)");
  expect(describeAutonomy({ level: "checkpoints", checkpoints: [] })).toBe("checkpoints (none chosen)");
  const q = (id: string, patch: Partial<UserQuestion> = {}): UserQuestion => ({ id, question: id, context: "", options: [], recommended: null, kind: "decision", checkpoint: null, asked_at: "", answer: null, withdrawn: false, ...patch });
  const f = { questions: [q("open"), q("answered", { answer: { option: "A", text: "", at: "", delivered: true } }), q("withdrawn", { withdrawn: true })] } as Feature;
  expect(openQuestions(f).map((x) => x.id)).toEqual(["open"]);
  expect(openQuestions(undefined)).toEqual([]);
});
