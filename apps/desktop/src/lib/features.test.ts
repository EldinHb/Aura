import { expect, it } from "vitest";
import type { Feature, Item, Meeting, UserQuestion, MeetingTurn } from "../gen";
import { attendeesLine, describeAutonomy, featureCard, meetingState, oneOnOneLabel, openQuestions, isLive, currentSpeaker, liveRounds } from "./features";
import { groupSteps } from "../views/transcript/replySteps";

const item = (id: string, kind: Item["kind"], patch: Partial<Item> = {}): Item => ({ id, session_id: "o", turn_id: "t1", kind, status: "completed", title: null, text: "", data: {}, parent_id: null, started_at: "", ended_at: null, ...patch });

it("reads the card a system item stands for, and nothing else", () => {
  expect(featureCard(item("c", "system", { data: { feature_card: { kind: "decision", id: "q1" }, message: "Which?" } }))).toEqual({ kind: "decision", id: "q1" });
  expect(featureCard(item("c", "system", { data: { feature_card: { kind: "report", id: "report" } } }))).toEqual({ kind: "report", id: "report" });
  expect(featureCard(item("c", "system", { data: { feature_card: { kind: "meeting", id: "m1" } } }))).toEqual({ kind: "meeting", id: "m1" });
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

it("words how far a meeting got and who asked whom", () => {
  const a = (status: Meeting["attendees"][number]["status"]) => ({ worker_id: "w", name: "W", role: "", guest: false, status, answer: null, missing: null, answered_at: null });
  const m = { id: "m1", topic: "T", agenda: "Q", context: "", attendees: [a("answered"), a("asked"), a("invited")], status: "collecting", decision_ids: [], started_at: "", deadline: "", ended_at: null, delivered: false, mode: "written", round: 0, max_rounds: 0, turn_words: 0, turns: [], outcome: null, timeout_minutes: 0, left: [] } as Meeting;
  expect(meetingState(m)).toBe("collecting · 1 of 3 answered");
  expect(meetingState({ ...m, status: "incomplete" })).toBe("held · 2 missing");
  expect(meetingState({ ...m, status: "complete", attendees: [a("answered")] })).toBe("held");
  expect(attendeesLine({ ...m, attendees: [a("answered")] })).toBe("1 attendee");
  expect(attendeesLine({ ...m, attendees: [a("answered"), a("late")] })).toBe("2 attendees · 1 missing");
  const ask = { id: "a1", from_id: "b", from_name: "Builder", to_id: "d", to_name: "Designer", to_owner: false, question: "?", answer: null, error: null, status: "open", asked_at: "", answered_at: null, sent: false, delivered: false } as const;
  expect(oneOnOneLabel(ask)).toBe("Builder → Designer");
  expect(oneOnOneLabel({ ...ask, to_owner: true, to_name: "Owner" })).toBe("Builder → Owner (owner)");
});

it("words how far a live meeting got and threads it by round", () => {
  const t = (round: number, name: string, patch: Partial<MeetingTurn> = {}): MeetingTurn => ({ round, worker_id: name, name, role: "", chair: false, status: "answered", text: "x", missing: null, at: null, ...patch });
  const m = {
    id: "m1", topic: "T", agenda: "Q", context: "", attendees: [], status: "collecting", decision_ids: [], started_at: "", deadline: "", ended_at: null, delivered: false,
    mode: "live", round: 2, max_rounds: 3, turn_words: 150, outcome: null, timeout_minutes: 20, left: [],
    turns: [t(1, "A"), t(1, "B"), t(2, "Owner", { chair: true, text: "Steer" }), t(2, "A"), t(2, "B", { status: "invited", text: null })],
  } as Meeting;
  expect(isLive(m)).toBe(true);
  expect(currentSpeaker(m)?.name).toBe("B");
  expect(meetingState(m)).toBe("round 2 of 3 · B next, once free");
  expect(meetingState({ ...m, turns: m.turns.map((x) => (x.status === "invited" ? { ...x, status: "asked" } : x)) })).toBe("round 2 of 3 · B speaking");
  expect(meetingState({ ...m, status: "waiting_on_chair" })).toBe("round 2 of 3 over · waiting on the owner");
  expect(meetingState({ ...m, status: "complete" })).toBe("held · 2 rounds");
  expect(attendeesLine({ ...m, status: "incomplete", round: 1 })).toBe("live · 0 attendees · held · 1 round");
  const rounds = liveRounds(m);
  expect(rounds.map((r) => [r.round, r.steer?.text ?? null, r.turns.map((x) => x.name)])).toEqual([
    [1, null, ["A", "B"]],
    [2, "Steer", ["A", "B"]],
  ]);
  // From a daemon before live meetings: written.
  expect(isLive({ ...m, mode: undefined } as unknown as Meeting)).toBe(false);
});
