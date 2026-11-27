import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Session } from "../gen";
import { useStore } from "../state/store";
import { modTabKey } from "../state/tabs";
import { slots } from "../mods/registry";
import { registerTabCommands } from "../commands/tabs";
import { MainTabs, TabPane } from "./MainTabs";
import { useTabActive } from "./tabActive";

function session(id: string, patch: Partial<Session> = {}): Session {
  return { id, title: `Title ${id}`, cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false, pending_count: 0,
    created_at: "2026-09-30T00:00:00Z", last_activity: "2026-09-30T00:00:00Z", group: null, worktree: null, model: null, ...patch } as Session;
}

const st = () => useStore.getState();
const keys = () => st().tabs.map((t) => t.key);
const tabEl = (key: string) => document.querySelector<HTMLElement>(`[data-tab-key="${key}"]`)!;
const prKey = modTabKey("pull-requests", "pull", { number: 7 });
let off: () => void;

beforeAll(() => {
  off = registerTabCommands();
  // Switching tabs puts the keyboard in the main area on the next frame.
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0));
});
afterAll(() => {
  off();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  useStore.setState({
    sessions: { a: session("a", { status: "running" }), b: session("b") }, sessionOrder: ["a", "b"],
    selectedId: null, modView: null, tabs: [], activeTab: null, recentTabs: [], closedTabs: [],
    sidebarFilter: "", showArchived: false, expandedOrchestras: [], collapsedSubOrchestras: [], workspaces: [], collapsedGroups: [], transcripts: {},
  });
  st().openTab({ kind: "session", sessionId: "a" }, { preview: false });
  st().openTab({ kind: "mod", modId: "pull-requests", viewId: "pull", props: { number: 7 } }, { preview: false });
  st().select("b");
});
afterEach(cleanup);

it("shows a tab per open session and view, the preview in italics, sessions with their status", () => {
  render(<MainTabs />);
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Title a", "pull", "Title b"]);
  expect(tabEl("s:b").classList.contains("preview")).toBe(true);
  expect(tabEl("s:a").classList.contains("preview")).toBe(false);
  expect(tabEl("s:b").classList.contains("active")).toBe(true);
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Title b");
  expect(tabEl("s:a").querySelector(".dot")?.className).toContain("pulse");
  expect(tabEl(prKey).querySelector(".dot")).toBeNull();
  // Hint mode reaches every tab and close button.
  expect(tabEl("s:a").querySelectorAll("[data-hint][data-command]")).toHaveLength(2);
});

it("titles a mod's tab by its props' title, else by the view's registered title", () => {
  const unregister = slots.view.register("pull-requests", "pull", { title: "Pull request", component: () => null });
  render(<MainTabs />);
  expect(tabEl(prKey).textContent).toContain("Pull request");
  act(() => st().openTab({ kind: "mod", modId: "pull-requests", viewId: "pull", props: { number: 8, title: "#8 Fix the build" } }));
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toContain("#8 Fix the build");
  act(() => unregister());
});

it("activates, keeps and closes tabs with the mouse through their commands", async () => {
  render(<MainTabs />);
  fireEvent.click(screen.getByRole("tab", { name: /Title a/ }));
  await vi.waitFor(() => expect(st().activeTab).toBe("s:a"));
  expect(st().selectedId).toBe("a");
  expect(st().focus).toBe("main");

  fireEvent.doubleClick(screen.getByRole("tab", { name: /Title b/ }));
  await vi.waitFor(() => expect(st().tabs.find((t) => t.key === "s:b")?.preview).toBe(false));

  fireEvent.click(screen.getByRole("button", { name: "Close Title a" }));
  await vi.waitFor(() => expect(keys()).toEqual([prKey, "s:b"]));
  // The closed tab was active: its right neighbour shows.
  expect(st().activeTab).toBe(prKey);
  expect(st().modView).toEqual({ modId: "pull-requests", id: "pull", props: { number: 7 } });

  // Middle click closes too.
  fireEvent(tabEl("s:b"), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  await vi.waitFor(() => expect(keys()).toEqual([prKey]));
});

it("shows nothing without tabs", () => {
  useStore.setState({ tabs: [], activeTab: null });
  const { container } = render(<MainTabs />);
  expect(container.innerHTML).toBe("");
});

it("keeps every pane mounted and tells each whether it is shown", () => {
  function Probe({ name }: { name: string }) {
    return <span data-probe={name}>{useTabActive() ? "shown" : "hidden"}</span>;
  }
  render(
    <>
      <TabPane tabKey="s:a" active={false}><Probe name="a" /></TabPane>
      <TabPane tabKey="s:b" active><Probe name="b" /></TabPane>
    </>,
  );
  const a = document.querySelector("[data-probe=a]")!;
  expect(a.textContent).toBe("hidden");
  expect(a.closest("[data-tab-pane]")!.hasAttribute("hidden")).toBe(true);
  expect(document.querySelector("[data-probe=b]")!.textContent).toBe("shown");
  expect(document.querySelector("[data-probe=b]")!.closest("[data-tab-pane]")!.hasAttribute("hidden")).toBe(false);
});
