import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session, Workspace } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { selectListedSessions, selectTabActivity, selectVisibleSessions, useStore } from "../state/store";
import { workspaceNameError } from "./dialogs/WorkspaceDialogs";
import { Sidebar } from "./Sidebar";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });

function session(id: string, workspace: string, patch: Partial<Session> = {}): Session {
  return { id, title: id.toUpperCase(), cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false, workspace,
    pending_count: 0, attention: null, created_at: "2026-11-20T00:00:00Z", last_activity: "2026-11-20T00:00:00Z", group: null, worktree: null, model: null, orchestrator: false, orchestrator_id: null, ...patch } as Session;
}
const ws = (id: string, name: string, position: number): Workspace => ({ id, name, position, created_at: "" });
const touchWorkspace = vi.fn(() => Promise.resolve(true));
const rows = () => [...document.querySelectorAll<HTMLElement>(".session-list [data-session-id]")].map((el) => el.dataset.sessionId);

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  touchWorkspace.mockClear();
  const list = [
    session("a", "one"),
    session("b", "one", { status: "running" }),
    session("c", "two", { pending_count: 2, attention: "waiting" }),
    session("cw", "two", { orchestrator_id: "c", pending_count: 1 }),
    session("d", "two"),
    session("run", "two", { scheduled_task_id: "t", scheduled_task_name: "Nightly", pending_count: 5 }),
  ];
  useStore.setState({
    client: { touchWorkspace, getSetting: () => new Promise(() => {}) } as unknown as RpcClient,
    sessions: Object.fromEntries(list.map((s) => [s.id, s])), sessionOrder: list.map((s) => s.id),
    workspaces: [ws("one", "Aura client work", 0), ws("two", "Research", 1)], activeWorkspace: "one", lastSelectedByWorkspace: {},
    transcripts: {}, sidebarFilter: "", showArchived: false, selectedId: null, sidebarCursor: null, modView: null, focus: "sidebar",
    sidebarTab: "sessions", collapsedGroups: [], expandedOrchestras: [], collapsedSubOrchestras: [],
    tabs: [], activeTab: null, recentTabs: [], closedTabs: [], dialog: { kind: "none" },
  });
});
afterEach(cleanup);

it("scopes the list, ⌘-numbers and tab badges to the active workspace; ⌘K still lists every session", () => {
  render(<Sidebar />);
  expect(rows()).toEqual(["b", "a"]);
  const st = useStore.getState();
  expect(selectVisibleSessions(st).map((s) => s.id)).toEqual(["b", "a"]);
  expect(selectTabActivity(st, "scheduled").pending).toBe(0);
  expect(selectListedSessions(st).map((s) => s.id)).toEqual(["c", "cw", "b", "a", "d", "run"]);
});

it("names the workspace, and sums what waits on the user in the others, scheduled runs left out", () => {
  render(<Sidebar />);
  expect(screen.getByRole("button", { name: "Workspace: Aura client work. Switch workspace" })).toBeTruthy();
  const others = document.querySelector<HTMLElement>(".workspace-others")!;
  expect(others.title).toBe("Other workspaces: 3 waiting on you");
  expect(others.querySelector(".badge")?.textContent).toBe("3");
  expect(others.querySelector(".attention.waiting")).not.toBeNull();
});

it("switches workspace from the menu by keyboard, clears the filter and comes back to the last selection", () => {
  render(<Sidebar />);
  act(() => useStore.getState().select("a"));
  act(() => useStore.getState().setSidebarFilter("x"));
  fireEvent.click(screen.getByRole("button", { name: /^Workspace: / }));
  const list = screen.getByRole("listbox", { name: "Workspaces" });
  const options = [...list.querySelectorAll('[role="option"]')];
  expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining("Aura client work"), expect.stringContaining("Research"), expect.stringContaining("New workspace…")]);
  expect(options[0].getAttribute("aria-selected")).toBe("true");
  // Research holds two leaders (its run is not counted), and waits on the user.
  expect(options[1].querySelector(".count")?.textContent).toBe("2");
  expect(options[1].querySelector(".badge")?.textContent).toBe("3");
  const input = screen.getByRole("textbox", { name: "Filter workspaces" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(useStore.getState().activeWorkspace).toBe("two");
  expect(useStore.getState().sidebarFilter).toBe("");
  expect(touchWorkspace).toHaveBeenCalledWith("two");
  expect(localStorage.getItem("aura.workspace")).toBe("two");
  // Nothing selected here before: the first row.
  expect(useStore.getState().selectedId).toBe("c");
  expect(rows()).toEqual(["c", "cw", "d"]);
  // Back: the session last selected there.
  act(() => useStore.getState().switchWorkspace("one"));
  expect(useStore.getState().selectedId).toBe("a");
});

it("switches workspace when a session elsewhere is selected, as from ⌘K or a notification", () => {
  render(<Sidebar />);
  act(() => useStore.getState().select("cw"));
  expect(useStore.getState().activeWorkspace).toBe("two");
  expect(useStore.getState().expandedOrchestras).toEqual(["c"]);
  expect(rows()).toContain("cw");
});

it("keeps the workspace list from the daemon's events, and falls back when the active one is deleted", () => {
  render(<Sidebar />);
  act(() => useStore.getState().applyEvent({ type: "workspaces_changed", workspaces: [ws("two", "Research", 0)] }));
  expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(["two"]);
  expect(useStore.getState().activeWorkspace).toBe("two");
  expect(rows()).toEqual(["c", "cw", "d"]);
});

it("treats everything as one workspace against a daemon without them", () => {
  act(() => useStore.setState({ workspaces: [] }));
  render(<Sidebar />);
  expect(screen.queryByRole("button", { name: /^Workspace: / })).toBeNull();
  expect(rows()).toEqual(["c", "cw", "b", "a", "d"]);
});

it("says what is wrong with a workspace name", () => {
  const list = [ws("one", "Aura", 0)];
  expect(workspaceNameError("  ", list)).toBe("Name can't be empty.");
  expect(workspaceNameError("aura ", list)).toBe("A workspace with this name already exists.");
  expect(workspaceNameError("AURA", list, "one")).toBeNull();
  expect(workspaceNameError("x".repeat(41), list)).toBe("Names are at most 40 characters.");
});

it("points at ⌘K when the filter matches only in other workspaces, and offers to move sessions into an empty one", () => {
  render(<Sidebar />);
  act(() => useStore.getState().setSidebarFilter("d"));
  expect(screen.getByText(/1 match in other workspaces/)).toBeTruthy();
  act(() => useStore.setState({ workspaces: [...useStore.getState().workspaces, ws("three", "Empty", 2)], activeWorkspace: "three", sidebarFilter: "" }));
  expect(screen.getByText("No sessions in Empty yet.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Move sessions here…" })).toBeTruthy();
});
