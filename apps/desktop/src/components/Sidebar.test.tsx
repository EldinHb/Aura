import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Item, Session } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { runCommand } from "../lib/commands";
import { emptyTranscript, useStore } from "../state/store";
import { useDetectedLinksStore, useDetectedLinksSync, useLinkPreferencesStore } from "../state/sessionLinkPreferences";
import { useGithubRepos } from "../state/githubRepos";
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
 * Two orchestras between plain sessions: o1 with w1 and w2 (which runs w3), o2 with v1.
 * No daemon, so the rows do not load links behind the test's back.
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
  ];
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
  expect(document.querySelector('[data-session-id="o1"] .meta')?.textContent).toContain("+3");
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

it("keeps the arrow keys inside an open orchestra", () => {
  orchestras();
  render(<Sidebar />);
  act(() => useStore.getState().select("o1"));
  press("sidebar.nav.up");
  expect(current()).toBe("o1");
  for (const id of ["w1", "w2", "w3", "w3"]) {
    press("sidebar.nav.down");
    expect(current()).toBe(id);
  }
  press("sidebar.nav.first");
  expect(current()).toBe("o1");
  press("sidebar.nav.last");
  expect(current()).toBe("w3");
  act(() => useStore.getState().select("v1"));
  press("sidebar.nav.down");
  expect(current()).toBe("v1");
  press("sidebar.nav.up");
  expect(current()).toBe("o2");
  press("sidebar.nav.up");
  expect(current()).toBe("o2");
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
  // A collapsed orchestrator is a single row: up and down leave it, into the next open orchestra.
  press("sidebar.nav.up");
  expect(current()).toBe("p");
  press("sidebar.nav.down");
  expect(current()).toBe("o1");
  press("sidebar.nav.down");
  expect(current()).toBe("o2");
  press("sidebar.nav.up");
  expect(current()).toBe("o2");
  act(() => useStore.getState().select("o1"));
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
