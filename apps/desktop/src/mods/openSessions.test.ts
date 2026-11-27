import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../gen";
import { useStore } from "../state/store";
import { onOpenSessionsChange, openSessionIds } from "./openSessions";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });

const session = (id: string) => ({ id, title: id, cwd: `/w/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false, pending_count: 0, created_at: "2026-11-27T00:00:00Z", last_activity: "2026-11-27T00:00:00Z", group: null, worktree: null, model: null }) as unknown as Session;
const st = () => useStore.getState();

beforeEach(() => {
  localStorage.clear();
  const ids = ["a", "b", "c"];
  useStore.setState({ sessions: Object.fromEntries(ids.map((id) => [id, session(id)])), sessionOrder: ids, selectedId: null, modView: null, tabs: [], activeTab: null, recentTabs: [], closedTabs: [] });
  st().restoreTabs();
});

describe("open sessions for mods", () => {
  it("lists session tabs in order and the selected session, not mod tabs", () => {
    st().openTab({ kind: "session", sessionId: "a" }, { preview: false });
    st().openTab({ kind: "mod", modId: "pr-status", viewId: "pr", props: { key: "x" } }, { preview: false });
    st().openTab({ kind: "session", sessionId: "b" }, { preview: false });
    expect(openSessionIds()).toEqual(["a", "b"]);
    // A session shown in the preview tab is open too.
    st().select("c");
    expect(openSessionIds()).toEqual(["a", "b", "c"]);
  });

  it("tells when the list changes, and only then", () => {
    const fn = vi.fn();
    const off = onOpenSessionsChange(fn);
    st().openTab({ kind: "session", sessionId: "a" }, { preview: false });
    expect(fn).toHaveBeenLastCalledWith(["a"]);
    useStore.setState({ sidebarFilter: "x" });
    expect(fn).toHaveBeenCalledTimes(1);
    st().openTab({ kind: "session", sessionId: "b" }, { preview: false });
    st().closeTab(st().tabs.find((t) => t.kind === "session" && t.sessionId === "a")!.key);
    expect(fn).toHaveBeenLastCalledWith(["b"]);
    off();
    st().openTab({ kind: "session", sessionId: "c" }, { preview: false });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
