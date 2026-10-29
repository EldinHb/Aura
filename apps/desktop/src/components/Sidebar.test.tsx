import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Item, Session } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { runCommand } from "../lib/commands";
import { emptyTranscript, useStore } from "../state/store";
import { useDetectedLinksStore, useDetectedLinksSync, useLinkPreferencesStore } from "../state/sessionLinkPreferences";
import { useGithubRepos } from "../state/githubRepos";
import { setFeature, useFeatures } from "../state/features";
import { Sidebar } from "./Sidebar";

vi.mock("../features/reviews/ReviewSidebar", () => ({ ReviewSidebar: () => null }));

const issue = "https://github.com/owner/repo/issues/7";
const pr = "https://github.com/owner/repo/pull/42";
const settings = new Map<string, string>();
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });
const getSetting = vi.fn(async (key: string) => settings.get(key) ?? null);
const setSetting = vi.fn(async (key: string, value: string) => { settings.set(key, value); return true; });
const gitGithubRepo = vi.fn(async (cwd: string) => cwd === "/work/a" ? "owner/repo" : null);

function session(id: string, title: string, patch: Partial<Session> = {}): Session {
  return { id, title, cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false,
    pending_count: 0, last_activity: "2026-09-30T00:00:00Z", group: null, worktree: null, model: null, orchestrator: false, orchestrator_id: null, ...patch } as Session;
}

function item(text: string, kind: Item["kind"] = "agent_message"): Item {
  return { id: "message", session_id: "a", turn_id: null, kind, status: "completed", title: null,
    text, data: {}, parent_id: null, started_at: "2026-09-30T00:00:00Z", ended_at: null };
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

const rowLinks = (id: string) => [...document.querySelectorAll(`[data-session-id="${id}"] .session-row-link`)].map((el) => el.textContent);

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  settings.clear();
  getSetting.mockClear();
  setSetting.mockClear();
  useLinkPreferencesStore.setState({ entries: {} });
  useDetectedLinksStore.setState({ links: {} });
  useGithubRepos.setState({ repos: {} });
  useStore.setState({
    client: { getSetting, setSetting, gitGithubRepo } as unknown as RpcClient,
    sessions: { a: session("a", "Hours page"), b: session("b", "Other") },
    sessionOrder: ["a", "b"], transcripts: {}, sidebarFilter: "", showArchived: false,
    collapsedOrchestras: [], selectedId: null, sidebarCursor: null, prSelection: null, focus: "sidebar",
  });
});
afterEach(cleanup);

it("shows links detected in an opened session and saved selections for unopened ones", async () => {
  settings.set("session.links.v1.b", JSON.stringify({ issue }));
  useStore.setState({ transcripts: { a: { ...emptyTranscript(), loaded: true, items: { message: item(`Created PR: ${pr}`) }, order: ["message"] } } });
  render(<Sidebar />);
  await waitFor(() => expect(rowLinks("b")).toEqual(["Issue #7"]));
  expect(rowLinks("a")).toEqual(["PR #42"]);
  expect(screen.getByTitle(pr)).toBeTruthy();
});

it("saves detected links so the sidebar shows them before the session is opened again", async () => {
  useStore.setState({ transcripts: { a: { ...emptyTranscript(), loaded: true, items: { message: item(`Created PR: ${pr}`) }, order: ["message"] } } });
  const { unmount } = renderHook(() => useDetectedLinksSync());
  await waitFor(() => expect(setSetting).toHaveBeenCalledWith("session.links.detected.v1.a", JSON.stringify([pr])));
  unmount();

  useDetectedLinksStore.setState({ links: {} });
  useStore.setState({ transcripts: {} });
  render(<Sidebar />);
  await waitFor(() => expect(rowLinks("a")).toEqual(["PR #42"]));
  expect(rowLinks("b")).toEqual([]);
});

it("prefers None over a saved detected link", async () => {
  settings.set("session.links.detected.v1.a", JSON.stringify([pr]));
  settings.set("session.links.v1.a", JSON.stringify({ pr: null }));
  render(<Sidebar />);
  await waitFor(() => expect(getSetting).toHaveBeenCalledWith("session.links.v1.a"));
  await waitFor(() => expect(useLinkPreferencesStore.getState().entries.a).toBeTruthy());
  expect(rowLinks("a")).toEqual([]);
});

it("links the issue number the user asked the agent to work on, using the session's GitHub repository", async () => {
  useStore.setState({ transcripts: { a: { ...emptyTranscript(), loaded: true, items: { message: item("Please work on issue #7", "user_message") }, order: ["message"] } } });
  render(<Sidebar />);
  await waitFor(() => expect(rowLinks("a")).toEqual(["Issue #7"]));
  expect(screen.getByTitle(issue)).toBeTruthy();
  const { unmount } = renderHook(() => useDetectedLinksSync());
  await waitFor(() => expect(setSetting).toHaveBeenCalledWith("session.links.detected.v1.a", JSON.stringify([issue])));
  unmount();
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
  useStore.setState({ collapsedOrchestras: ["o1"], sessions: { ...useStore.getState().sessions, w3: session("w3", "Worker 3", { group: "Work", orchestrator_id: "w2", pending_count: 1 }) } });
  render(<Sidebar />);
  const row = document.querySelector('[data-session-id="o1"]')!;
  expect(row.querySelector(".title")?.textContent).toBe("Lead");
  expect(row.querySelector(".sub .agent")?.textContent).toBe("claude");
  expect(row.querySelector(".sub [aria-label=Orchestrator]")).toBeTruthy();
  const workers = row.querySelector(".sub .workers")!;
  expect(workers.textContent).toBe("+3");
  // A hidden worker waits on the user.
  expect(workers.classList.contains("warn")).toBe(true);
  expect(workers.getAttribute("title")).toBe("Worker 1\nWorker 2\nWorker 3");
  expect(document.querySelector('[data-session-id="p"] [aria-label=Orchestrator]')).toBeNull();
});

it("lists orchestrators in no group in their own section above the other sessions, with their workers under them", () => {
  const list = [
    session("p", "Plain"),
    session("o", "Chat", { orchestrator: true, folderless: true, cwd: "/data/orchestrators/o" }),
    session("w", "Worker", { orchestrator_id: "o", cwd: "/work/repo" }),
    session("g", "Grouped", { group: "G" }),
    session("og", "Grouped lead", { group: "G", orchestrator: true }),
    session("gw", "Grouped worker", { group: "G", orchestrator_id: "og" }),
    session("old", "Lead with a folder", { orchestrator: true }),
  ];
  useStore.setState({ sessions: Object.fromEntries(list.map((s) => [s.id, s])), sessionOrder: list.map((s) => s.id), client: null });
  render(<Sidebar />);
  expect(rows()).toEqual(["o", "w", "old", "p", "g", "og", "gw"]);
  expect([...document.querySelectorAll(".section-title")].map((el) => el.textContent)).toEqual(["Orchestrators", "Sessions", "G"]);
  expect(document.querySelector('[data-session-id="w"]')?.classList.contains("worker")).toBe(true);
  // A plain session cannot be moved in among them, nor they out.
  act(() => useStore.getState().moveSessionTo("p", "o"));
  act(() => useStore.getState().moveSessionTo("old", "p"));
  expect(rows()).toEqual(["o", "w", "old", "p", "g", "og", "gw"]);
  act(() => useStore.getState().moveSessionTo("old", "o"));
  expect(rows()).toEqual(["old", "o", "w", "p", "g", "og", "gw"]);
});

it("gives the ungrouped sessions no heading while there is no orchestrators section", () => {
  orchestras();
  const sessions = { ...useStore.getState().sessions, p: session("p", "Plain") };
  useStore.setState({ sessions });
  render(<Sidebar />);
  expect([...document.querySelectorAll(".section-title")].map((el) => el.textContent)).toEqual(["Work"]);
  expect(rows()[0]).toBe("p");
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

it("shows only whole link chips that fit, then +N with the rest in its tooltip, and adapts as the sidebar resizes", async () => {
  const urls = [7, 8, 9, 10].map((n) => `https://github.com/owner/repo/issues/${n}`);
  settings.set("session.links.detected.v1.a", JSON.stringify(urls));
  // jsdom lays nothing out: chips are 60px wide, "+N" 24px, and the line as wide as `room`.
  let room = 150;
  let resized = () => {};
  vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { resized = cb; } observe() {} disconnect() {} });
  const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("link-slot") ? 60 : this.classList.contains("links-more") ? 24 : 0;
  });
  const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("links") ? room : 0;
  });
  try {
    render(<Sidebar />);
    const shown = () => [...document.querySelectorAll('[data-session-id="a"] .link-slot:not(.overflow)')].map((el) => el.textContent);
    const more = () => document.querySelector<HTMLElement>('[data-session-id="a"] .links-more')!;
    // 60 + 60 + "+2" fits in 150; a third chip with "+1" does not.
    await waitFor(() => expect(shown()).toEqual(["Issue #7", "Issue #8"]));
    expect(more().textContent).toBe("+2");
    expect(more().classList.contains("overflow")).toBe(false);
    expect(more().title).toBe(`${urls[2]}\n${urls[3]}`);

    room = 240;
    act(() => resized());
    expect(shown()).toEqual(["Issue #7", "Issue #8", "Issue #9", "Issue #10"]);
    expect(more().classList.contains("overflow")).toBe(true);

    // Too narrow for any chip: only the count.
    room = 40;
    act(() => resized());
    expect(shown()).toEqual([]);
    expect(more().textContent).toBe("+4");
  } finally {
    width.mockRestore();
    client.mockRestore();
    vi.unstubAllGlobals();
  }
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
