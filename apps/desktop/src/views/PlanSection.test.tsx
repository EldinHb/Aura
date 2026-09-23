import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { emptyTranscript, useStore } from "../state/store";
import { setPlanView, usePlanViews } from "../state/planView";
import type { Item } from "../gen";
import { PlanSection } from "./PlanSection";
import { sessionPlans } from "./sessionPlans";
function item(id: string, text: string, kind: Item["kind"] = "agent_message", data = {}): Item {
  return { id, session_id: "s", turn_id: null, kind, status: "completed", title: null, text, data, parent_id: null, started_at: "", ended_at: null };
}
beforeEach(() => {
  useStore.setState({ transcripts: { s: emptyTranscript() } });
  usePlanViews.setState({ views: {} });
});
afterEach(cleanup);
it("restores Codex plan events from history and keeps updates hidden when collapsed", () => {
  useStore.getState().loadHistory("s", [{ seq: 1, ts: "", event: { type: "provider_info", session_id: "s", info: { kind: "plan", turn_id: "turn", plan: [{ step: "Build the feature", status: "in_progress" }] } } }]);
  const { unmount } = render(<PlanSection sessionId="s" />);
  expect(screen.getByText("Build the feature", { exact: false })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Hide/ }));
  act(() => useStore.getState().applyEvent({ type: "provider_info", session_id: "s", info: { kind: "plan", turn_id: "turn", plan: [{ step: "Verify the feature", status: "completed" }] } }));
  expect(screen.queryByText("Verify the feature", { exact: false })).toBeNull();
  unmount();
  render(<PlanSection sessionId="s" />);
  fireEvent.click(screen.getByRole("button", { name: /Show/ }));
  expect(screen.getByText("Verify the feature", { exact: false })).toBeTruthy();
});
it("finds Claude prose plans and TodoWrite steps, and supports explicitly kept messages", () => {
  const t = emptyTranscript();
  t.order = ["prose", "todo", "ordinary"];
  t.items = {
    prose: item("prose", "Here is the plan.\n1. Build it\n2. Test it"),
    todo: item("todo", "", "tool_call", { tool_name: "TodoWrite", input: { todos: [{ content: "Test it", status: "completed" }] } }),
    ordinary: item("ordinary", "An outline without special wording"),
  };
  expect(sessionPlans(t).map((p) => p.id)).toEqual(["prose", "todo"]);
  useStore.setState({ transcripts: { s: t } });
  setPlanView("s", { selectedId: "ordinary", open: true });
  render(<PlanSection sessionId="s" />);
  expect(screen.getByText("An outline without special wording")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Displayed plan"), { target: { value: "prose" } });
  expect(screen.getByText("Build it")).toBeTruthy();
});
it("retains an approval plan after it has been resolved", () => {
  useStore.getState().applyEvent({ type: "approval_requested", session_id: "s", approval: { id: "a", session_id: "s", turn_id: null, item_id: null, kind: "generic", title: "Plan", description: null, payload: { plan: "A durable plan" }, options: [], created_at: "" } });
  useStore.getState().applyEvent({ type: "approval_resolved", session_id: "s", approval_id: "a", decision: { option: "accept", updated_input: null, message: null } });
  expect(sessionPlans(useStore.getState().transcripts.s)[0]?.text).toBe("A durable plan");
});
