import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Approval, Item } from "../../gen";
import { emptyTranscript, useStore } from "../../state/store";
import { Overlays } from "../../components/Overlays";
import { Transcript } from "../Transcript";
import { groupSteps, summarizeSteps } from "./replySteps";

function item(id: string, kind: Item["kind"], extra: Partial<Item> = {}): Item {
  return { id, session_id: "s", turn_id: "t1", kind, status: "completed", title: null, text: id, data: {}, parent_id: null, started_at: "", ended_at: null, ...extra };
}

function load(items: Item[], approvals: Record<string, Approval> = {}) {
  const t = emptyTranscript();
  t.order = items.map((i) => i.id);
  t.items = Object.fromEntries(items.map((i) => [i.id, i]));
  t.approvals = approvals;
  t.loading = false;
  act(() => useStore.setState({ transcripts: { s: t }, dialog: { kind: "none" }, cursorItemId: null }));
}

const ids = (m: Map<string, { id: string }>) => [...m].map(([k, g]) => `${k}>${g.id}`);

// jsdom has no layout, so no scrollIntoView.
Element.prototype.scrollIntoView ??= () => {};

beforeEach(() => useStore.setState({ transcripts: { s: emptyTranscript() }, settings: { ...useStore.getState().settings, showReasoning: true } }));
afterEach(cleanup);

it("folds everything before the final reply into one group per reply", () => {
  const items = [
    item("u1", "user_message"),
    item("r1", "reasoning"),
    item("m1", "agent_message"),
    item("c1", "command_exec"),
    item("a1", "agent_message"),
    item("u2", "user_message", { turn_id: "t2" }),
    item("r2", "reasoning", { turn_id: "t2" }),
    item("a2", "agent_message", { turn_id: "t2" }),
    item("a3", "agent_message", { turn_id: "t2" }),
  ];
  expect(ids(groupSteps(items))).toEqual(["r1>r1", "m1>r1", "c1>r1", "r2>r2"]);
});

it("keeps errors, context markers and replies without steps in the chat", () => {
  const items = [
    item("u1", "user_message"),
    item("a1", "agent_message"),
    item("u2", "user_message"),
    item("c1", "tool_call"),
    item("e1", "error"),
    item("k1", "system", { data: { boundary: "compact" } }),
  ];
  expect(ids(groupSteps(items))).toEqual(["c1>c1"]);
});

it("starts a new group when the turn changes without a user message", () => {
  const items = [item("c1", "tool_call", { turn_id: "t1" }), item("c2", "tool_call", { turn_id: "t2" })];
  expect(ids(groupSteps(items))).toEqual(["c1>c1", "c2>c2"]);
});

it("summarizes steps by kind and shows the step in progress", () => {
  const done = summarizeSteps([
    item("r", "reasoning"),
    item("c1", "command_exec", { data: { command: "ls" } }),
    item("c2", "command_exec", { status: "failed" }),
    item("t", "mcp_call"),
    item("f", "file_change"),
  ]);
  expect(done.parts).toBe("thinking, 2 commands, 1 tool call, 1 edit");
  expect(done.failed).toBe(1);
  expect(done.running).toBe(false);
  const running = summarizeSteps([item("r", "reasoning"), item("c", "command_exec", { status: "in_progress", data: { command: "cargo test" } })]);
  expect(running.running).toBe(true);
  expect(running.current).toBe("cargo test");
});

it("shows one steps row in the transcript and opens every step in a modal", () => {
  load([
    item("u1", "user_message", { text: "fix it" }),
    item("r1", "reasoning", { text: "let me think" }),
    item("c1", "command_exec", { data: { command: "cargo build" } }),
    item("a1", "agent_message", { text: "Fixed." }),
  ]);
  const { container } = render(
    <>
      <Transcript sessionId="s" />
      <Overlays />
    </>,
  );
  const shown = [...container.querySelectorAll(".transcript > [data-item-id], .transcript > [data-steps-id]")].map((el) => el.getAttribute("data-item-id") ?? `steps:${el.getAttribute("data-steps-id")}`);
  expect(shown).toEqual(["u1", "steps:r1", "a1"]);
  const row = container.querySelector<HTMLElement>(".steps-row")!;
  expect(row.textContent).toContain("2 steps");
  expect(row.textContent).toContain("thinking, 1 command");

  fireEvent.click(row);
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("let me think");
  expect(dialog.textContent).toContain("cargo build");
  expect(dialog.textContent).not.toContain("Fixed.");
});

it("keeps a pending approval for a grouped step visible in the chat", () => {
  const approval: Approval = {
    id: "ap", session_id: "s", turn_id: "t1", item_id: "c1", kind: "command", title: "Run cargo build", description: null, payload: { command: "cargo build" }, options: ["accept", "decline"], created_at: "",
  };
  load([item("u1", "user_message"), item("c1", "command_exec", { status: "in_progress", data: { command: "cargo build" } })], { ap: approval });
  const { container } = render(<Transcript sessionId="s" />);
  expect(container.querySelector(".steps-row")?.textContent).toContain("Working");
  expect(container.querySelector('[data-approval-id="ap"]')).toBeTruthy();
});

it("moves a jump to a folded step onto the row that holds it", () => {
  load([item("u1", "user_message"), item("r1", "reasoning"), item("c1", "command_exec"), item("a1", "agent_message")]);
  const { container } = render(<Transcript sessionId="s" />);
  act(() => useStore.getState().setCursorItem("c1"));
  expect(useStore.getState().cursorItemId).toBe("steps:r1");
  expect(container.querySelector(".steps-row.cursor")).toBeTruthy();
});

const report = (id: string, extra: Partial<Item> = {}) =>
  item(id, "user_message", { text: `[Aura] Worker report. This message comes from Aura, not the user.\n\n### Builder ${id}\nLast reply:\nDone.`, ...extra });

it("folds worker reports and the turns on them into one row, keeping the replies to the user", () => {
  load([
    item("u1", "user_message", { text: "build it" }),
    item("a1", "agent_message", { text: "Started a worker." }),
    // Reports the orchestrator only acted on, then one it answers the user on: one row for all three.
    report("w1", { turn_id: "t2" }),
    item("c1", "mcp_call", { turn_id: "t2" }),
    report("w2", { turn_id: null }),
    item("r2", "reasoning", { turn_id: "t3" }),
    item("c2", "mcp_call", { turn_id: "t3" }),
    report("w3", { turn_id: "t4" }),
    item("a4", "agent_message", { turn_id: "t4", text: "The build is done." }),
  ]);
  act(() => {
    const t = useStore.getState().transcripts.s;
    const turn = (id: string, status: "completed" | "failed") => ({ id, session_id: "s", status, started_at: "", ended_at: "", usage: null, error: status === "failed" ? "overloaded" : null });
    useStore.setState({ transcripts: { s: { ...t, turns: [turn("t1", "completed"), turn("t2", "completed"), turn("t3", "completed"), turn("t4", "failed")] } } });
  });
  const { container } = render(
    <>
      <Transcript sessionId="s" />
      <Overlays />
    </>,
  );
  const shown = [...container.querySelectorAll(".transcript > [data-item-id], .transcript > [data-steps-id], .transcript > .turn-divider")].map(
    (el) => el.getAttribute("data-item-id") ?? (el.getAttribute("data-steps-id") ? `steps:${el.getAttribute("data-steps-id")}` : `turn:${el.textContent}`),
  );
  // Only the turn the user started and the one that failed keep their divider.
  expect(shown).toEqual([expect.stringMatching(/^turn:completed/), "u1", "a1", "steps:w1", expect.stringMatching(/^turn:failed/), "a4"]);
  expect(container.textContent).not.toContain("[Aura]");
  const row = container.querySelector<HTMLElement>(".steps-row.aura")!;
  expect(row.textContent).toContain("3 worker reports");
  expect(row.textContent).toContain("thinking, 2 tool calls");

  fireEvent.click(row);
  const dialog = screen.getByRole("dialog");
  expect(dialog.querySelectorAll(".aura_message")).toHaveLength(3);
  expect(dialog.textContent).toContain("Builder w2");
  expect(dialog.textContent).not.toContain("This message comes from Aura");
});

it("keeps a reply to the user apart from the next report's group", () => {
  const items = [report("w1"), item("a1", "agent_message"), report("w2", { turn_id: "t2" }), item("c2", "tool_call", { turn_id: "t2" })];
  expect(ids(groupSteps(items))).toEqual(["w1>w1", "w2>w2", "c2>w2"]);
  expect(groupSteps(items).get("w1")?.aura).toBe(true);
});
