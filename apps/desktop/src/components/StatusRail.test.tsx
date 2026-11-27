import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session, Workspace } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { STATE_SECTION, selectRail, selectScheduledRail, selectSessionSections, useStore } from "../state/store";
import { Sidebar } from "./Sidebar";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });

function session(id: string, title: string, patch: Partial<Session> = {}): Session {
  return { id, title, cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false, workspace: "here",
    pending_count: 0, attention: null, created_at: "2026-11-20T00:00:00Z", last_activity: "2026-11-20T00:00:00Z", group: null, worktree: null, model: null, orchestrator: false, orchestrator_id: null, ...patch } as Session;
}
const ws = (id: string, name: string, position: number): Workspace => ({ id, name, position, created_at: "" });
const touchWorkspace = vi.fn(() => Promise.resolve(true));

/**
 * "Here" (active) and "Infra": in Infra a leader waiting on its own, a leader
 * whose worker asks the user, an idle one and a working one; scheduled runs in
 * both, one waiting, one working, one idle.
 */
function setup(list: Session[] = []) {
  const all = [
    session("h", "Here plain"),
    session("needs", "Review PR #12", { workspace: "infra", pending_count: 1, last_activity: "2026-11-20T10:00:00Z" }),
    session("lead", "Login revamp", { workspace: "infra", orchestrator: true, last_activity: "2026-11-20T11:00:00Z" }),
    session("tester", "Tester", { workspace: "infra", orchestrator_id: "lead", attention: "waiting" }),
    session("quiet", "Spike caching", { workspace: "infra" }),
    session("busy", "Busy", { workspace: "infra", status: "running" }),
    session("run1", "Nightly deps · 03:00", { workspace: "infra", scheduled_task_id: "t1", scheduled_task_name: "Nightly deps", attention: "waiting", pending_count: 1 }),
    session("run2", "Weekly · Mon", { scheduled_task_id: "t2", scheduled_task_name: "Weekly", status: "running" }),
    session("run3", "Old run", { workspace: "infra", scheduled_task_id: "t1", scheduled_task_name: "Nightly deps" }),
    ...list,
  ];
  useStore.setState({
    sessions: Object.fromEntries(all.map((s) => [s.id, s])), sessionOrder: all.map((s) => s.id),
    workspaces: [ws("here", "Here", 0), ws("infra", "Infra", 1)], activeWorkspace: "here",
  });
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  touchWorkspace.mockClear();
  useStore.setState({
    client: { touchWorkspace, getSetting: () => new Promise(() => {}) } as unknown as RpcClient,
    transcripts: {}, sidebarFilter: "", showArchived: false, selectedId: null, sidebarCursor: null, modView: null, focus: "sidebar",
    sidebarTab: "sessions", collapsedGroups: [], expandedOrchestras: [], collapsedSubOrchestras: [], lastSelectedByWorkspace: {},
    tabs: [], activeTab: null, recentTabs: [], closedTabs: [], dialog: { kind: "none" },
  });
});
afterEach(cleanup);

const rail = () => screen.queryByRole("group", { name: "Other workspaces" });
const railRows = (name: string) => [...(screen.queryByRole("group", { name })?.querySelectorAll<HTMLElement>("[data-session-id-rail]") ?? [])].map((el) => el.dataset.sessionIdRail);

it("shows what needs the user elsewhere, leaders only, most urgent first, and folds Idle", () => {
  setup();
  render(<Sidebar />);
  // Pending first, then the leader whose worker waits on the user; never a worker, a scheduled run or a working leader.
  expect(railRows("Other workspaces")).toEqual(["needs", "lead"]);
  const lead = rail()!.querySelector<HTMLElement>('[data-session-id-rail="lead"]')!;
  expect(lead.textContent).toContain("Tester needs you");
  expect(lead.getAttribute("aria-label")).toBe("Login revamp, Infra, Tester needs you");
  // Idle is folded with its count; unfolding it is remembered.
  const idle = screen.getByRole("button", { name: /^Idle elsewhere, 1 session/ });
  expect(idle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(idle);
  expect(railRows("Other workspaces")).toEqual(["needs", "lead", "quiet"]);
  expect(localStorage.getItem("aura.rail-idle-open.v1")).toBe("1");
});

it("opens the worker that waits, in its workspace, from the rail", () => {
  setup();
  render(<Sidebar />);
  fireEvent.click(rail()!.querySelector('[data-session-id-rail="lead"]')!);
  const st = useStore.getState();
  expect(st.activeWorkspace).toBe("infra");
  expect(st.selectedId).toBe("tester");
  expect(st.expandedOrchestras).toEqual(["lead"]);
  expect(touchWorkspace).toHaveBeenCalledWith("infra");
  // Now the other workspace is "Here": the rail shows it, and no longer Infra's sessions.
  expect(railRows("Other workspaces")).toEqual([]);
  expect(screen.getByText("Nothing needs you elsewhere.")).toBeTruthy();
});

it("hides Elsewhere while there is one workspace, and keeps the scheduled runs block", () => {
  setup();
  act(() => useStore.setState({ workspaces: [ws("here", "Here", 0)] }));
  render(<Sidebar />);
  expect(rail()).toBeNull();
  expect(railRows("Scheduled runs")).toEqual(["run1", "run2"]);
});

it("keeps scheduled runs out of the state sections and Elsewhere, in a block of their own from every workspace", () => {
  setup();
  render(<Sidebar />);
  const st = useStore.getState();
  // The Sessions tab: no run, even one that waits on the user.
  const listed = selectSessionSections(st).flatMap(([, list]) => list.map((s) => s.id));
  expect(listed).toEqual(["h"]);
  expect(selectSessionSections(st).map(([k]) => k)).toEqual([STATE_SECTION + "idle"]);
  const elsewhere = selectRail(st)!;
  expect([...elsewhere.needsYou, ...elsewhere.idle].map((r) => r.leader.id)).not.toContain("run1");
  // Runs that wait or work, waiting first; idle runs only on the Scheduled tab.
  expect(selectScheduledRail(st).map((r) => r.leader.id)).toEqual(["run1", "run2"]);
  const run1 = screen.getByRole("group", { name: "Scheduled runs" }).querySelector<HTMLElement>('[data-session-id-rail="run1"]')!;
  expect(run1.textContent).toContain("Nightly deps");
  expect(run1.textContent).toContain("Infra");
  // Clicking one shows its workspace and the Scheduled tab.
  fireEvent.click(run1);
  expect(useStore.getState().activeWorkspace).toBe("infra");
  expect(useStore.getState().sidebarTab).toBe("scheduled");
  expect(useStore.getState().selectedId).toBe("run1");
});

it("caps Needs you at five rows and expands in place", () => {
  setup(Array.from({ length: 6 }, (_, i) => session(`x${i}`, `Asks ${i}`, { workspace: "infra", attention: "waiting" })));
  render(<Sidebar />);
  expect(railRows("Other workspaces")).toHaveLength(5);
  fireEvent.click(screen.getByRole("button", { name: "+ 3 more" }));
  expect(railRows("Other workspaces")).toHaveLength(8);
  fireEvent.click(screen.getByRole("button", { name: "Show less" }));
  expect(railRows("Other workspaces")).toHaveLength(5);
});

it("moves from the last list row into the rail and back", async () => {
  setup();
  const { runCommand } = await import("../lib/commands");
  render(<Sidebar />);
  act(() => useStore.getState().select("h"));
  act(() => { void runCommand("sidebar.nav.down"); });
  expect(document.activeElement?.getAttribute("data-session-id-rail")).toBe("needs");
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement?.getAttribute("data-session-id-rail")).toBe("lead");
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  expect(document.activeElement?.closest("[data-region]")?.getAttribute("data-region")).toBe("sidebar");
  expect(useStore.getState().selectedId).toBe("h");
});
