import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ScheduledTask, Session } from "../gen";
import { useSchedules } from "../features/schedules/state";
import type { RpcClient } from "../lib/rpc";
import { runCommand } from "../lib/commands";
import { selectListedSessions, useStore } from "../state/store";
import { setFeature, useFeatures } from "../state/features";
import { slots } from "../mods/registry";
import { Sidebar } from "./Sidebar";

const settings = new Map<string, string>();
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });
const getSetting = vi.fn(async (key: string) => settings.get(key) ?? null);
const setSetting = vi.fn(async (key: string, value: string) => { settings.set(key, value); return true; });

function session(id: string, title: string, patch: Partial<Session> = {}): Session {
  return { id, title, cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false,
    pending_count: 0, last_activity: "2026-09-30T00:00:00Z", group: null, worktree: null, model: null, orchestrator: false, orchestrator_id: null, ...patch } as Session;
}

const rows = () => [...document.querySelectorAll<HTMLElement>("[data-session-id]")].map((el) => el.dataset.sessionId);
const toggle = (id: string) => document.querySelector<HTMLButtonElement>(`[data-session-id="${id}"] .orchestra-toggle`);
const press = (command: string) => act(() => { void runCommand(command); });
const current = () => useStore.getState().selectedId;

/**
 * Two orchestras between plain sessions of one group: o1 with w1 and w2 (which
 * runs w3), o2 with v1. No daemon, so the rows do not load links behind the test's back.
 */
function orchestras() {
  const list = [
    session("p", "Plain"),
    session("o1", "Lead", { orchestrator: true }),
    session("w1", "Worker 1", { orchestrator_id: "o1" }),
    session("w2", "Worker 2", { orchestrator: true, orchestrator_id: "o1" }),
    session("w3", "Worker 3", { orchestrator_id: "w2" }),
    session("o2", "Other lead", { orchestrator: true }),
    session("v1", "Other worker", { orchestrator_id: "o2" }),
    session("q", "Plain too"),
  ].map((s) => ({ ...s, group: "Work" }));
  useStore.setState({ sessions: Object.fromEntries(list.map((s) => [s.id, s])), sessionOrder: list.map((s) => s.id), focus: "sidebar", client: null });
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  settings.clear();
  getSetting.mockClear();
  setSetting.mockClear();
  useStore.setState({
    client: { getSetting, setSetting } as unknown as RpcClient,
    sessions: { a: session("a", "Hours page"), b: session("b", "Other") },
    sessionOrder: ["a", "b"], transcripts: {}, sidebarFilter: "", showArchived: false,
    collapsedOrchestras: [], selectedId: null, sidebarCursor: null, modView: null, focus: "sidebar",
    sidebarTab: "sessions", collapsedGroups: [],
  });
});
afterEach(cleanup);

it("shows the chips mods add to each row, and none from a mod that fails", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const off = [
    slots.sessionRowChips.register("test-mod", "chip", {
      component: ({ session, selected }) => <span className="test-chip">{`${session.title}${selected ? " (selected)" : ""}`}</span>,
    }),
    slots.sessionRowChips.register("broken-mod", "chip", { component: () => { throw new Error("boom"); } }),
  ];
  try {
    useStore.setState({ selectedId: "a" });
    render(<Sidebar />);
    const chips = (id: string) => [...document.querySelectorAll(`[data-session-id="${id}"] .links .test-chip`)].map((el) => el.textContent);
    expect(chips("a")).toEqual(["Hours page (selected)"]);
    expect(chips("b")).toEqual(["Other"]);
    expect(document.querySelector(".mod-error")).toBeNull();
  } finally {
    cleanup();
    off.forEach((f) => f());
    vi.mocked(console.error).mockRestore();
  }
});

it("draws a mod sidebar section's title as Aura's own section heading", () => {
  const off = [
    slots.sidebarSection.register("titled", "panel", { title: "Turn counter", component: () => <div className="titled-body">body</div> }),
    slots.sidebarSection.register("untitled", "panel", { component: () => <div className="untitled-body">body</div> }),
  ];
  try {
    render(<Sidebar />);
    const headings = [...document.querySelectorAll(".section-title.mod-section-title")].map((el) => el.textContent);
    expect(headings).toEqual(["Turn counter"]);
    const heading = document.querySelector(".mod-section-title")!;
    expect(heading.nextElementSibling?.className).toBe("titled-body");
  } finally {
    cleanup();
    off.forEach((f) => f());
  }
});

it("shows every level of workers under their orchestrator", () => {
  orchestras();
  render(<Sidebar />);
  expect(rows()).toEqual(["p", "o1", "w1", "w2", "w3", "o2", "v1", "q"]);
  expect(toggle("o1")?.getAttribute("aria-expanded")).toBe("true");
  expect(toggle("w2")?.getAttribute("aria-expanded")).toBe("true");
  expect(toggle("p")).toBeNull();
  expect(toggle("w1")).toBeNull();
});

it("collapses an orchestrator to hide its workers and keeps that across a restart", () => {
  orchestras();
  render(<Sidebar />);
  fireEvent.click(toggle("o1")!);
  expect(rows()).toEqual(["p", "o1", "o2", "v1", "q"]);
  expect(toggle("o1")?.getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector('[data-session-id="o1"] .sub .workers')?.textContent).toContain("+3");
  // Collapsing does not select the orchestrator, and the hidden workers give up their ⌘-numbers.
  expect(current()).toBeNull();
  expect(document.querySelector('[data-session-id="o2"] kbd')?.textContent).toBe("3");
  expect(JSON.parse(localStorage.getItem("aura.sidebar-collapsed.v1")!)).toEqual(["o1"]);

  // Another window, or the next start, reads the saved state.
  act(() => useStore.setState({ collapsedOrchestras: [] }));
  expect(rows()).toContain("w1");
  act(() => { window.dispatchEvent(new StorageEvent("storage", { key: "aura.sidebar-collapsed.v1" })); });
  expect(rows()).toEqual(["p", "o1", "o2", "v1", "q"]);

  fireEvent.click(toggle("o1")!);
  expect(rows()).toEqual(["p", "o1", "w1", "w2", "w3", "o2", "v1", "q"]);
  expect(JSON.parse(localStorage.getItem("aura.sidebar-collapsed.v1")!)).toEqual([]);
});

it("collapses a nested orchestrator on its own", () => {
  orchestras();
  render(<Sidebar />);
  fireEvent.click(toggle("w2")!);
  expect(rows()).toEqual(["p", "o1", "w1", "w2", "o2", "v1", "q"]);
});

it("opens a collapsed orchestra when one of its workers is selected from elsewhere", () => {
  orchestras();
  useStore.setState({ collapsedOrchestras: ["o1", "w2", "o2"] });
  render(<Sidebar />);
  act(() => useStore.getState().select("w3"));
  expect(rows()).toEqual(["p", "o1", "w1", "w2", "w3", "o2", "q"]);
  expect(useStore.getState().collapsedOrchestras).toEqual(["o2"]);
});

it("shows matching workers of a collapsed orchestrator while filtering", () => {
  orchestras();
  useStore.setState({ collapsedOrchestras: ["o1"], sidebarFilter: "worker 3" });
  render(<Sidebar />);
  expect(rows()).toEqual(["w3"]);
});

it("walks into an orchestra from its orchestrator and out past its last worker", () => {
  orchestras();
  render(<Sidebar />);
  act(() => useStore.getState().select("p"));
  // The orchestrator belongs to its orchestra, so down from it goes through every worker, nested ones included.
  for (const id of ["o1", "w1", "w2", "w3", "o2", "v1", "q", "q"]) {
    press("sidebar.nav.down");
    expect(current()).toBe(id);
  }
});

it("skips the workers of open orchestras when moving up from outside them", () => {
  orchestras();
  render(<Sidebar />);
  act(() => useStore.getState().select("q"));
  for (const id of ["o2", "o1", "p", "p"]) {
    press("sidebar.nav.up");
    expect(current()).toBe(id);
  }
  // Up from a worker stays in its orchestra until the orchestrator, then leaves it.
  act(() => useStore.getState().select("w3"));
  for (const id of ["w2", "w1", "o1", "p"]) {
    press("sidebar.nav.up");
    expect(current()).toBe(id);
  }
  // Up from the orchestrator below lands on the orchestrator above, not its last worker.
  act(() => useStore.getState().select("v1"));
  press("sidebar.nav.up");
  expect(current()).toBe("o2");
  press("sidebar.nav.up");
  expect(current()).toBe("o1");
});

it("steps over a collapsed nested orchestra inside an open one", () => {
  orchestras();
  useStore.setState({ collapsedOrchestras: ["w2"] });
  render(<Sidebar />);
  act(() => useStore.getState().select("o1"));
  for (const id of ["w1", "w2", "o2"]) {
    press("sidebar.nav.down");
    expect(current()).toBe(id);
  }
});

it("keeps first and last at the ends of the sidebar", () => {
  orchestras();
  useStore.setState({ sessionOrder: ["p", "q", "o1", "w1", "w2", "w3", "o2", "v1"] });
  render(<Sidebar />);
  act(() => useStore.getState().select("w1"));
  press("sidebar.nav.first");
  expect(current()).toBe("p");
  press("sidebar.nav.last");
  expect(current()).toBe("v1");
});

it("moves through every session as before outside an orchestra and past collapsed ones", () => {
  orchestras();
  useStore.setState({ collapsedOrchestras: ["o1", "o2"] });
  render(<Sidebar />);
  press("sidebar.nav.down");
  expect(current()).toBe("p");
  for (const id of ["o1", "o2", "q", "q"]) {
    press("sidebar.nav.down");
    expect(current()).toBe(id);
  }
  press("sidebar.nav.first");
  expect(current()).toBe("p");
  press("sidebar.nav.last");
  expect(current()).toBe("q");

  // Plain sessions alone are unchanged.
  act(() => useStore.setState({ sessions: { a: session("a", "A"), b: session("b", "B") }, sessionOrder: ["a", "b"], collapsedOrchestras: [] }));
  act(() => useStore.getState().select("a"));
  press("sidebar.nav.down");
  expect(current()).toBe("b");
  press("sidebar.nav.up");
  expect(current()).toBe("a");
});

it("opens and closes orchestras with left and right like a tree", () => {
  orchestras();
  render(<Sidebar />);
  act(() => useStore.getState().select("w3"));
  press("sidebar.nav.collapse");
  expect(current()).toBe("w2");
  press("sidebar.nav.collapse");
  expect(rows()).not.toContain("w3");
  expect(current()).toBe("w2");
  press("sidebar.nav.collapse");
  expect(current()).toBe("o1");
  press("sidebar.nav.collapse");
  expect(rows()).toEqual(["p", "o1", "o2", "v1", "q"]);
  // A collapsed orchestrator is a single row that up and down move past.
  press("sidebar.nav.up");
  expect(current()).toBe("p");
  press("sidebar.nav.down");
  expect(current()).toBe("o1");
  press("sidebar.nav.down");
  expect(current()).toBe("o2");
  press("sidebar.nav.up");
  expect(current()).toBe("o1");
  press("sidebar.nav.expand");
  expect(rows()).toEqual(["p", "o1", "w1", "w2", "o2", "v1", "q"]);
  expect(current()).toBe("o1");
  press("sidebar.nav.expand");
  expect(current()).toBe("w1");
  // Right on a worker and left on a plain session do nothing.
  press("sidebar.nav.expand");
  expect(current()).toBe("w1");
  act(() => useStore.getState().select("p"));
  press("sidebar.nav.collapse");
  expect(current()).toBe("p");
});

it("navigates from the orchestrator when the selected worker was collapsed away with the mouse", () => {
  orchestras();
  render(<Sidebar />);
  act(() => useStore.getState().select("w1"));
  fireEvent.click(toggle("o1")!);
  expect(current()).toBe("w1");
  expect(document.querySelector('[data-session-id="o1"]')?.classList.contains("cursor")).toBe(true);
  press("sidebar.nav.down");
  expect(current()).toBe("o2");
});

it("shows the session's agent, orchestrator mark and hidden workers on the second line, the title alone on the first", () => {
  orchestras();
  useStore.setState({ collapsedOrchestras: ["o1"], sessions: { ...useStore.getState().sessions, w3: session("w3", "Worker 3", { group: "Work", orchestrator_id: "w2" }) } });
  render(<Sidebar />);
  const row = document.querySelector('[data-session-id="o1"]')!;
  expect(row.querySelector(".title")?.textContent).toBe("Lead");
  expect(row.querySelector(".sub .agent")?.textContent).toBe("claude");
  expect(row.querySelector(".sub [aria-label=Orchestrator]")).toBeTruthy();
  const workers = row.querySelector(".sub .workers")!;
  expect(workers.textContent).toBe("+3");
  expect(workers.getAttribute("title")).toBe("Worker 1\nWorker 2\nWorker 3");
  expect(document.querySelector('[data-session-id="p"] [aria-label=Orchestrator]')).toBeNull();
});

it("lists sessions by state: waiting for you, working, idle; workers under their orchestrator while they share a state", () => {
  const list = [
    session("p", "Plain"),
    session("o", "Chat", { orchestrator: true, folderless: true, cwd: "/data/orchestrators/o", status: "running" }),
    session("w", "Worker", { orchestrator_id: "o", cwd: "/work/repo", status: "running" }),
    session("done", "Worker done", { orchestrator_id: "o", attention: "done" }),
    session("g", "Grouped", { group: "G" }),
    session("ask", "Asks", { pending_count: 1 }),
  ];
  useStore.setState({ sessions: Object.fromEntries(list.map((s) => [s.id, s])), sessionOrder: list.map((s) => s.id), client: null });
  render(<Sidebar />);
  expect(rows()).toEqual(["done", "ask", "o", "w", "p", "g"]);
  expect([...document.querySelectorAll(".section-label")].map((el) => el.textContent)).toEqual(["Waiting for you", "Working", "Idle"]);
  expect(document.querySelector('[data-session-id="w"]')?.classList.contains("worker")).toBe(true);
  // A worker away from its orchestrator says whose it is; a group shows on the row.
  expect(document.querySelector('[data-session-id="done"] .chip.lead')?.textContent).toBe("↳ Chat");
  expect(document.querySelector('[data-session-id="w"] .chip.lead')).toBeNull();
  expect(document.querySelector('[data-session-id="g"] .chip.group')?.textContent).toBe("G");
  // Sessions move only within their state.
  act(() => useStore.getState().moveSessionTo("p", "o"));
  expect(rows()).toEqual(["done", "ask", "o", "w", "p", "g"]);
  act(() => useStore.getState().moveSessionTo("g", "p"));
  expect(rows()).toEqual(["done", "ask", "o", "w", "g", "p"]);
  // A session that starts working moves up to Working.
  act(() => useStore.getState().upsertSession({ ...useStore.getState().sessions.p, status: "running" }));
  // It keeps its place in the saved order: above the orchestra.
  expect(rows()).toEqual(["done", "ask", "p", "o", "w", "g"]);
});

it("leaves out a state no session is in", () => {
  orchestras();
  const sessions = { ...useStore.getState().sessions, p: session("p", "Plain") };
  useStore.setState({ sessions });
  render(<Sidebar />);
  expect([...document.querySelectorAll(".section-label")].map((el) => el.textContent)).toEqual(["Idle"]);
});

it("shows no folder for an orchestrator that belongs to none, and its workers' folders", () => {
  const list = [
    session("o", "Chat", { orchestrator: true, folderless: true, cwd: "/data/orchestrators/o", model: "opus" }),
    session("w", "Worker", { orchestrator_id: "o", cwd: "/work/repo" }),
    session("x", "Picked", { orchestrator_id: "o", cwd: "/work/repo", model: "gpt-5", effort: "low" }),
  ];
  useStore.setState({ sessions: Object.fromEntries(list.map((s) => [s.id, s])), sessionOrder: list.map((s) => s.id), client: null });
  render(<Sidebar />);
  const lead = document.querySelector<HTMLElement>('[data-session-id="o"]')!;
  expect(lead.querySelector(".sub .where")?.textContent).toBe("opus");
  expect(lead.title).toBe("Orchestrator: belongs to no folder");
  const worker = document.querySelector<HTMLElement>('[data-session-id="w"]')!;
  expect(worker.querySelector(".sub .where")?.textContent).toBe("repo");
  expect(worker.title).toBe("/work/repo");
  // The model and effort the orchestrator gave a worker.
  expect(document.querySelector('[data-session-id="x"] .sub .where')?.textContent).toBe("repo · gpt-5 · low");
});

it("marks a feature owner, the role of each specialist under it and the decisions waiting on the user", () => {
  const list = [
    session("owner", "Dark mode", { orchestrator: true, feature_owner: true }),
    session("ux", "Theme switch flow", { orchestrator_id: "owner", specialist_id: "ux-designer", specialist_name: "UX designer" }),
    session("qa", "Tester (QA)", { orchestrator_id: "owner", specialist_id: "tester", specialist_name: "Tester (QA)" }),
    session("adhoc", "Scout", { orchestrator_id: "owner" }),
    session("lead", "Lead", { orchestrator: true }),
  ].map((s) => ({ ...s, group: "Work" }));
  useFeatures.setState({ features: {} });
  setFeature({ owner_id: "owner", goal: "", status: "waiting_on_user", autonomy: null, meeting_mode: null, team: [], decisions: [], checkpoints: [], suggestions: [], meetings: [], one_on_ones: [], report: null, created_at: "", updated_at: "", counters: {},
    questions: [{ id: "q1", question: "Which?", context: "", options: [], recommended: null, kind: "decision", checkpoint: null, asked_at: "", answer: null, withdrawn: false }] });
  useStore.setState({ sessions: Object.fromEntries(list.map((s) => [s.id, s])), sessionOrder: list.map((s) => s.id), client: null });
  render(<Sidebar />);
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-session-id="${id}"]`)!;
  expect(row("owner").querySelector("[aria-label='Feature owner']")).toBeTruthy();
  expect(row("owner").querySelector("[aria-label='Orchestrator']")).toBeNull();
  expect(row("owner").querySelector(".feature-state")?.textContent).toBe("decision for you");
  expect(row("lead").querySelector("[aria-label='Orchestrator']")).toBeTruthy();
  expect(row("ux").querySelector(".chip.specialist")?.textContent).toBe("UX designer");
  expect(row("adhoc").querySelector(".chip.specialist")).toBeNull();
  expect(row("qa").querySelector(".chip.specialist"), "a title that says the role needs no chip").toBeNull();
});

/**
 * Sessions by hand in "Work" and ungrouped, and runs of two scheduled tasks:
 * two of "Nightly" (n1 older than n2), and an orchestrator "Weekly" ran with a
 * worker of its own, which goes with it.
 */
function scheduled() {
  const list = [
    session("a", "By hand"),
    session("g1", "Grouped", { group: "Work" }),
    session("g2", "Grouped too", { group: "Work", status: "running" }),
    session("n1", "Nightly · Mon 09:00", { scheduled_task_id: "t1", scheduled_task_name: "Nightly", created_at: "2026-11-16T09:00:00Z" }),
    session("n2", "Nightly · Tue 09:00", { scheduled_task_id: "t1", scheduled_task_name: "Nightly", created_at: "2026-11-17T09:00:00Z", pending_count: 2, attention: "waiting" }),
    session("o", "Weekly · Mon 08:00", { scheduled_task_id: "t2", scheduled_task_name: "Weekly", orchestrator: true, created_at: "2026-11-16T08:00:00Z", status: "running" }),
    session("ow", "Weekly's worker", { orchestrator_id: "o", created_at: "2026-11-16T08:05:00Z" }),
  ];
  useStore.setState({ sessions: Object.fromEntries(list.map((s) => [s.id, s])), sessionOrder: list.map((s) => s.id), client: null });
}
const tab = (name: RegExp) => screen.getByRole("tab", { name });
const heading = (label: string) => document.querySelector<HTMLButtonElement>(`.section-toggle[aria-label^="${label},"]`)!;

it("lists the sessions scheduled tasks started on a tab of their own, by task, newest first", () => {
  scheduled();
  render(<Sidebar />);
  expect(rows()).toEqual(["g2", "a", "g1"]);
  expect(tab(/^Sessions/).getAttribute("aria-selected")).toBe("true");
  // The Scheduled tab says how many it lists, that one works, and what waits on the user there.
  expect(tab(/^Scheduled/).textContent).toContain("4");
  expect(tab(/^Scheduled/).querySelector(".badge")?.textContent).toBe("2");
  expect(tab(/^Scheduled/).querySelector(".attention.waiting")).not.toBeNull();
  expect(tab(/^Scheduled/).querySelector(".dot.pulse")).not.toBeNull();

  fireEvent.click(tab(/^Scheduled/));
  expect(tab(/^Scheduled/).getAttribute("aria-selected")).toBe("true");
  expect(localStorage.getItem("aura.sidebar-tab.v1")).toBe("scheduled");
  // The task that ran last first; its runs newest first; the worker under its orchestrator.
  expect(rows()).toEqual(["n2", "n1", "o", "ow"]);
  expect([...document.querySelectorAll(".section-label")].map((el) => el.textContent)).toEqual(["Nightly", "Weekly"]);
  // Rows keep their role marks, and drop the task's name the heading already shows.
  expect(document.querySelector('[data-session-id="o"] .orchestrator-mark')).not.toBeNull();
  expect(document.querySelector('[data-session-id="n2"] .title')?.textContent).toBe("Tue 09:00");
  // ⌘-numbers count this tab's rows; the Sessions tab now carries nothing waiting.
  expect(document.querySelector('[data-session-id="n2"] kbd')?.textContent).toBe("1");
  expect(tab(/^Sessions/).querySelector(".badge")).toBeNull();

  // Another window switched back; this one follows.
  localStorage.setItem("aura.sidebar-tab.v1", "sessions");
  act(() => { window.dispatchEvent(new StorageEvent("storage", { key: "aura.sidebar-tab.v1" })); });
  expect(rows()).toEqual(["g2", "a", "g1"]);
});

it("switches tabs with the arrow keys on the tabs and from the command, and shows the tab of a session selected elsewhere", () => {
  scheduled();
  render(<Sidebar />);
  fireEvent.keyDown(tab(/^Sessions/), { key: "ArrowRight" });
  expect(useStore.getState().sidebarTab).toBe("scheduled");
  expect(document.activeElement).toBe(tab(/^Scheduled/));
  fireEvent.keyDown(tab(/^Scheduled/), { key: "Home" });
  expect(useStore.getState().sidebarTab).toBe("sessions");
  press("sidebar.tab.next");
  expect(useStore.getState().sidebarTab).toBe("scheduled");
  // ⌘K, a notification or an orchestrator's link selects a session on the other tab.
  act(() => useStore.getState().select("a"));
  expect(useStore.getState().sidebarTab).toBe("sessions");
  act(() => useStore.getState().select("ow"));
  expect(useStore.getState().sidebarTab).toBe("scheduled");
  expect(rows()).toContain("ow");
});

it("folds a section by its heading, says what is in it, and keeps that across a restart", () => {
  scheduled();
  render(<Sidebar />);
  expect(heading("Idle").getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(heading("Idle"));
  expect(rows()).toEqual(["g2"]);
  expect(heading("Idle").getAttribute("aria-expanded")).toBe("false");
  expect(heading("Idle").querySelector(".section-count")?.textContent).toBe("2");
  expect(JSON.parse(localStorage.getItem("aura.sidebar-collapsed-groups.v1")!)).toEqual(["sessions:\u0000state:idle"]);
  act(() => useStore.setState({ collapsedGroups: [] }));
  expect(rows()).toEqual(["g2", "a", "g1"]);
  act(() => { window.dispatchEvent(new StorageEvent("storage", { key: "aura.sidebar-collapsed-groups.v1" })); });
  expect(rows()).toEqual(["g2"]);

  // Each tab folds its own; a folded task shows what waits on the user in it.
  fireEvent.click(tab(/^Scheduled/));
  fireEvent.click(heading("Nightly"));
  expect(rows()).toEqual(["o", "ow"]);
  expect(heading("Nightly").querySelector(".badge")?.textContent).toBe("2");
  expect(heading("Nightly").querySelector(".attention.waiting")).not.toBeNull();
  expect(JSON.parse(localStorage.getItem("aura.sidebar-collapsed-groups.v1")!)).toEqual(["sessions:\u0000state:idle", "scheduled:\u0000task:t1"]);
  // A filter shows what matches in folded sections too.
  act(() => useStore.setState({ sidebarFilter: "nightly" }));
  expect(rows()).toEqual(["n2", "n1"]);
  act(() => useStore.setState({ sidebarFilter: "" }));

  // Selecting a session in a folded section, from ⌘K or a notification, unfolds it.
  act(() => useStore.getState().select("g1"));
  expect(useStore.getState().sidebarTab).toBe("sessions");
  expect(rows()).toEqual(["g2", "a", "g1"]);
  expect(useStore.getState().collapsedGroups).toEqual(["scheduled:\u0000task:t1"]);
});

it("folds and unfolds sections with left and right, and steps past a folded one", () => {
  scheduled();
  render(<Sidebar />);
  act(() => useStore.getState().select("g1"));
  press("sidebar.nav.collapse");
  expect(rows()).toEqual(["g2"]);
  // The cursor stays on its row; the heading stands in for it.
  expect(useStore.getState().sidebarCursor).toBe("g1");
  expect(heading("Idle").closest(".section-heading")?.classList.contains("cursor")).toBe(true);
  press("sidebar.nav.up");
  expect(current()).toBe("g2");
  // Selecting by keyboard does not unfold what the cursor only passes.
  expect(rows()).toEqual(["g2"]);
  act(() => useStore.getState().setSidebarCursor("g1"));
  press("sidebar.nav.expand");
  expect(rows()).toEqual(["g2", "a", "g1"]);
  // On a focused heading, left and right fold and unfold that section.
  act(() => heading("Idle").focus());
  press("sidebar.nav.collapse");
  expect(heading("Idle").getAttribute("aria-expanded")).toBe("false");
  press("sidebar.nav.expand");
  expect(heading("Idle").getAttribute("aria-expanded")).toBe("true");
});

it("opens the scheduled task from its heading on the Scheduled tab", () => {
  scheduled();
  render(<Sidebar />);
  fireEvent.click(tab(/^Scheduled/));
  // Only tasks the app knows of get the button; a deleted task keeps its name.
  expect(document.querySelector(".section-action")).toBeNull();
  act(() => useSchedules.setState({ tasks: [{ id: "t2", name: "Weekly plan" } as ScheduledTask], loaded: true }));
  expect([...document.querySelectorAll(".section-label")].map((el) => el.textContent)).toEqual(["Nightly", "Weekly plan"]);
  fireEvent.click(screen.getByRole("button", { name: "Edit the scheduled task Weekly plan" }));
  expect(useStore.getState().dialog).toEqual({ kind: "schedules", taskId: "t2", create: false });
  act(() => useSchedules.setState({ tasks: [], loaded: false }));
});

it("lets ⌘K pick from both tabs, folded sections included", () => {
  scheduled();
  useStore.setState({ collapsedGroups: ["sessions:\u0000state:idle"] });
  render(<Sidebar />);
  expect(rows()).toEqual(["g2"]);
  expect(selectListedSessions(useStore.getState()).map((s) => s.id)).toEqual(["g2", "a", "g1", "n2", "n1", "o", "ow"]);
});
