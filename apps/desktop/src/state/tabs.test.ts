import { beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../gen";
import { useStore } from "./store";
import { MAX_TABS, TABS_KEY, modTabKey, sessionTabKey, stableJson } from "./tabs";

function session(id: string, patch: Partial<Session> = {}): Session {
  return { id, title: `Title ${id}`, cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false, pending_count: 0,
    created_at: "2026-09-30T00:00:00Z", last_activity: "2026-09-30T00:00:00Z", group: null, worktree: null, model: null, ...patch } as Session;
}

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });

const st = () => useStore.getState();
const keys = () => st().tabs.map((t) => t.key);
const previews = () => st().tabs.filter((t) => t.preview).map((t) => t.key);
const pr = (n: number) => ({ modId: "pull-requests", id: "pull", props: { number: n } });

beforeEach(() => {
  localStorage.clear();
  const ids = ["a", "b", "c", "d", "e"];
  useStore.setState({
    sessions: Object.fromEntries(ids.map((id) => [id, session(id)])), sessionOrder: ids,
    selectedId: null, modView: null, tabs: [], activeTab: null, recentTabs: [], closedTabs: [],
    sidebarFilter: "", showArchived: false, collapsedOrchestras: [], collapsedGroups: [], transcripts: {},
  });
  // The first `setSessions` of a run restores the saved tabs; get that out of the way.
  st().restoreTabs();
});

describe("main-area tabs", () => {
  it("opens a session as a preview tab that the next selection replaces", () => {
    st().select("a");
    expect(keys()).toEqual(["s:a"]);
    expect(previews()).toEqual(["s:a"]);
    expect(st().activeTab).toBe("s:a");
    expect(st().selectedId).toBe("a");
    st().select("b");
    expect(keys()).toEqual(["s:b"]);
    expect(st().selectedId).toBe("b");
  });

  it("keeps a tab, after which the next preview opens beside it", () => {
    st().select("a");
    st().keepTab();
    expect(previews()).toEqual([]);
    st().select("b");
    st().select("c");
    expect(keys()).toEqual(["s:a", "s:c"]);
    expect(previews()).toEqual(["s:c"]);
    // Selecting a session whose tab is open shows that tab, and leaves it normal.
    st().select("a");
    expect(keys()).toEqual(["s:a", "s:c"]);
    expect(st().activeTab).toBe("s:a");
    expect(previews()).toEqual(["s:c"]);
  });

  it("opens a new preview right of the active tab, and a normal tab with `preview: false`", () => {
    st().openTab({ kind: "session", sessionId: "a" }, { preview: false });
    st().openTab({ kind: "session", sessionId: "b" }, { preview: false });
    st().activateTab("s:a");
    st().select("c");
    expect(keys()).toEqual(["s:a", "s:c", "s:b"]);
    st().openTab({ kind: "session", sessionId: "c" }, { preview: false });
    expect(previews()).toEqual([]);
  });

  it("allows at most one preview tab", () => {
    st().select("a");
    st().openModView(pr(1));
    st().select("b");
    expect(previews()).toHaveLength(1);
    expect(keys()).toHaveLength(1);
  });

  it("opens mod views in tabs, finds the same view again, and projects it onto modView", () => {
    st().select("a");
    st().keepTab();
    st().openModView(pr(1));
    const key = modTabKey("pull-requests", "pull", { number: 1 });
    expect(st().activeTab).toBe(key);
    expect(st().modView).toEqual(pr(1));
    // The last session stays selected underneath; nothing is selected as far as session commands go.
    expect(st().selectedId).toBe("a");
    st().keepTab();
    st().select("a");
    expect(st().modView).toBeNull();
    st().openModView(pr(1));
    expect(keys()).toEqual(["s:a", key]);
    st().openModView(pr(2));
    expect(keys()).toHaveLength(3);
    // closeModView closes the mod tab shown; its left neighbour shows as it was the last.
    st().closeModView();
    expect(keys()).toEqual(["s:a", key]);
    expect(st().activeTab).toBe(key);
  });

  it("keys mod tabs by stable props, or by a mod's own `props.key`", () => {
    expect(modTabKey("m", "v", { a: 1, b: 2 })).toBe(modTabKey("m", "v", { b: 2, a: 1 }));
    expect(modTabKey("m", "v", { a: 1 })).not.toBe(modTabKey("m", "v", { a: 2 }));
    expect(modTabKey("m", "v", { key: "pr-7", updated: 1 })).toBe("m:m:v:pr-7");
    expect(stableJson({ b: [{ d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
    expect(sessionTabKey("x")).toBe("s:x");
  });

  it("closing the active tab shows the one to its right, else the one to its left", () => {
    for (const id of ["a", "b", "c"]) st().openTab({ kind: "session", sessionId: id }, { preview: false });
    st().activateTab("s:b");
    st().closeTab();
    expect(keys()).toEqual(["s:a", "s:c"]);
    expect(st().activeTab).toBe("s:c");
    expect(st().selectedId).toBe("c");
    st().closeTab();
    expect(st().activeTab).toBe("s:a");
    st().closeTab();
    expect(st().activeTab).toBeNull();
    expect(st().selectedId).toBeNull();
    // Closing another tab leaves the active one alone.
    st().openTab({ kind: "session", sessionId: "a" }, { preview: false });
    st().openTab({ kind: "session", sessionId: "b" }, { preview: false });
    st().closeTab("s:a");
    expect(st().activeTab).toBe("s:b");
  });

  it("reopens closed tabs, latest first, as normal tabs", () => {
    st().openTab({ kind: "session", sessionId: "a" }, { preview: false });
    st().select("b");
    st().closeTab("s:a");
    st().closeTab("s:b");
    st().reopenClosedTab();
    expect(keys()).toEqual(["s:b"]);
    expect(previews()).toEqual([]);
    st().reopenClosedTab();
    expect(keys()).toEqual(["s:b", "s:a"]);
    expect(st().activeTab).toBe("s:a");
  });

  it("cycles through tabs and goes to the nth, 9 being the last", () => {
    for (const id of ["a", "b", "c"]) st().openTab({ kind: "session", sessionId: id }, { preview: false });
    st().cycleTab(1);
    expect(st().activeTab).toBe("s:a");
    st().cycleTab(-1);
    expect(st().activeTab).toBe("s:c");
    st().goToTab(2);
    expect(st().activeTab).toBe("s:b");
    st().goToTab(9);
    expect(st().activeTab).toBe("s:c");
    st().goToTab(5);
    expect(st().activeTab).toBe("s:c");
    st().moveTab("s:c", 0);
    expect(keys()).toEqual(["s:c", "s:a", "s:b"]);
  });

  it(`keeps at most ${MAX_TABS} tabs, closing the least recently used normal one`, () => {
    const sessions = Object.fromEntries(Array.from({ length: MAX_TABS + 2 }, (_, i) => [`x${i}`, session(`x${i}`)]));
    useStore.setState({ sessions });
    for (let i = 0; i < MAX_TABS; i++) st().openTab({ kind: "session", sessionId: `x${i}` }, { preview: false });
    // x0 was used again since, so x1 is the least recently used.
    st().activateTab("s:x0");
    st().openTab({ kind: "session", sessionId: `x${MAX_TABS}` }, { preview: false });
    expect(st().tabs).toHaveLength(MAX_TABS);
    expect(keys()).not.toContain("s:x1");
    expect(keys()).toContain("s:x0");
    expect(st().activeTab).toBe(`s:x${MAX_TABS}`);
  });

  it("closes a session's tab when it is deleted or archived", () => {
    for (const id of ["a", "b", "c"]) st().openTab({ kind: "session", sessionId: id }, { preview: false });
    st().activateTab("s:b");
    st().removeSession("b");
    expect(keys()).toEqual(["s:a", "s:c"]);
    expect(st().selectedId).toBe("c");
    st().upsertSession(session("c", { archived: true }));
    expect(keys()).toEqual(["s:a"]);
    expect(st().selectedId).toBe("a");
    // A deleted session's tab does not come back with reopen.
    st().reopenClosedTab();
    expect(keys()).toEqual(["s:a"]);
  });

  it("closes the tabs of a mod that unloads", () => {
    st().openTab({ kind: "session", sessionId: "a" }, { preview: false });
    st().openTab({ kind: "mod", modId: "pull-requests", viewId: "pull", props: { number: 1 } }, { preview: false });
    st().openTab({ kind: "mod", modId: "other", viewId: "v" }, { preview: false });
    st().closeModTabs("pull-requests");
    expect(keys()).toEqual(["s:a", modTabKey("other", "v", undefined)]);
  });

  it("saves the tabs and restores them once sessions load, without sessions that are gone", () => {
    st().openTab({ kind: "session", sessionId: "a" }, { preview: false });
    st().openTab({ kind: "mod", modId: "pull-requests", viewId: "pull", props: { number: 1, title: "Fix it" } }, { preview: false });
    st().openTab({ kind: "session", sessionId: "b" }, { preview: false });
    st().select("c");
    st().activateTab(modTabKey("pull-requests", "pull", { number: 1, title: "Fix it" }));
    const saved = JSON.parse(localStorage.getItem(TABS_KEY)!);
    expect(saved.tabs.map((t: { key: string }) => t.key)).toEqual(keys());
    expect(saved.active).toBe(st().activeTab);

    // A new run: no tabs yet, session "b" deleted meanwhile.
    useStore.setState({ tabs: [], activeTab: null, recentTabs: [], closedTabs: [], selectedId: null, modView: null });
    const { b: _gone, ...rest } = st().sessions;
    void _gone;
    useStore.setState({ sessions: rest });
    st().restoreTabs();
    const mod = modTabKey("pull-requests", "pull", { number: 1, title: "Fix it" });
    expect(keys()).toEqual(["s:a", mod, "s:c"]);
    expect(previews()).toEqual(["s:c"]);
    expect(st().activeTab).toBe(mod);
    expect(st().modView).toEqual({ modId: "pull-requests", id: "pull", props: { number: 1, title: "Fix it" } });
    expect(st().tabs.find((t) => t.key === mod)).toMatchObject({ title: "Fix it" });
  });

  it("drops tabs of sessions gone when the session list is reloaded", () => {
    st().openTab({ kind: "session", sessionId: "a" }, { preview: false });
    st().openTab({ kind: "session", sessionId: "b" }, { preview: false });
    st().setSessions([session("a"), session("c")]);
    expect(keys()).toEqual(["s:a"]);
    expect(st().selectedId).toBe("a");
  });
});
