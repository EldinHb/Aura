import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Item, Session } from "../gen";
import { emptyTranscript, useStore } from "../state/store";
import { Inspector } from "./Inspector";

vi.mock("../features/watches/WatchSection", () => ({ WatchSection: () => null }));
afterEach(cleanup);

const nextFrame = () => act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));

function item(id: string, text: string): Item {
  return { id, session_id: "s", turn_id: null, kind: "agent_message", status: "completed", title: null, text, data: {}, parent_id: null, started_at: "", ended_at: null };
}

it("a control inside keeps the keyboard after the region notices the focus", async () => {
  const s = { id: "s", title: "Plans", cwd: "/work/s", provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false,
    pending_count: 0, last_activity: "2026-09-30T00:00:00Z", created_at: "2026-09-30T00:00:00Z", group: null, worktree: null, model: null, orchestrator: false, orchestrator_id: null,
    usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_cost_usd: null, context_window: null, context_used: null, running_totals: false } } as unknown as Session;
  const t = emptyTranscript();
  t.loaded = true;
  t.order = ["p1", "p2"];
  t.items = { p1: item("p1", "Here is the plan.\n1. Build it\n2. Test it"), p2: item("p2", "Here is the plan.\n1. Ship it\n2. Watch it") };
  useStore.setState({ sessions: { s }, transcripts: { s: t }, client: null });
  render(<Inspector sessionId="s" />);
  const select = screen.getByLabelText("Displayed plan");
  act(() => select.focus());
  expect(useStore.getState().focus).toBe("inspector");
  await nextFrame();
  await nextFrame();
  expect(document.activeElement).toBe(select);
});

function lead(patch: Partial<Session>): Session {
  return { id: "o", title: "Lead", cwd: "/work/repo", provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false,
    pending_count: 0, last_activity: "2026-09-30T00:00:00Z", created_at: "2026-09-30T00:00:00Z", group: null, worktree: null, model: null, orchestrator: true, orchestrator_id: null, folderless: false,
    usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_cost_usd: null, context_window: null, context_used: null, running_totals: false }, ...patch } as unknown as Session;
}
const caps = { structured: true, terminal_mode: true, fork: false, models: false, effort: false, permission_modes: [], sandbox_modes: [] };

it("shows an orchestrator without a folder as a chat: no folder, diff or terminal mode", () => {
  useStore.setState({ sessions: { o: lead({ folderless: true, cwd: "/data/orchestrators/o" }) }, transcripts: {}, client: null, providers: [{ kind: "claude", capabilities: caps } as never] });
  render(<Inspector sessionId="o" />);
  expect(screen.getByText(/^Belongs to no folder/)).toBeTruthy();
  expect(screen.queryByText("cwd")).toBeNull();
  expect(screen.queryByText("/data/orchestrators/o")).toBeNull();
  expect(screen.queryByText("Diff")).toBeNull();
  expect(screen.queryByText("Stop orchestrating")).toBeNull();
  expect(screen.queryByText("Terminal")).toBeNull();
  expect(screen.getByText("Delete")).toBeTruthy();
});

it("keeps the folder and diff of an orchestrator that has one, without terminal mode", () => {
  useStore.setState({ sessions: { o: lead({}) }, transcripts: {}, client: null, providers: [{ kind: "claude", capabilities: caps } as never] });
  render(<Inspector sessionId="o" />);
  expect(screen.getByText("/work/repo")).toBeTruthy();
  expect(screen.getByText("Diff")).toBeTruthy();
  expect(screen.getByText("Stop orchestrating")).toBeTruthy();
  expect(screen.queryByText("Terminal")).toBeNull();
});
