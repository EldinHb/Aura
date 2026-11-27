import { beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../gen";
import { STATE_SECTION, rollupOf, selectListedSessions, treeOf, selectNestedRows, selectSessionSections, selectVisibleSessions, useStore } from "./store";

function session(id: string, patch: Partial<Session> = {}): Session {
  return { id, title: id, cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false, pending_count: 0,
    created_at: `2026-09-30T00:00:${String(id.charCodeAt(0) - 90).padStart(2, "0")}Z`, last_activity: "2026-09-30T00:00:00Z", group: null, worktree: null, model: null, ...patch } as Session;
}
const visible = () => selectVisibleSessions(useStore.getState()).map((s) => s.id);

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ sessions: {}, sessionOrder: [], sidebarFilter: "", showArchived: false, expandedOrchestras: [], collapsedSubOrchestras: [], workspaces: [] });
});

describe("session order", () => {
  it("starts oldest first and appends new sessions instead of pushing others down", () => {
    useStore.getState().setSessions([session("b"), session("a")]);
    expect(visible()).toEqual(["a", "b"]);
    useStore.getState().upsertSession(session("c"));
    expect(visible()).toEqual(["a", "b", "c"]);
  });

  it("does not reorder on activity within a state", () => {
    useStore.getState().setSessions([session("a"), session("b")]);
    useStore.getState().upsertSession(session("b", { last_activity: "2026-10-01T00:00:00Z" }));
    expect(visible()).toEqual(["a", "b"]);
    // Starting to work moves it to the Working section, above the idle ones.
    useStore.getState().upsertSession(session("b", { status: "running" }));
    expect(visible()).toEqual(["b", "a"]);
  });

  it("keeps the saved order across a reload and drops removed sessions", () => {
    useStore.getState().setSessions([session("a"), session("b"), session("c")]);
    useStore.getState().moveSessionTo("c", "a");
    expect(visible()).toEqual(["c", "a", "b"]);
    useStore.setState({ sessionOrder: JSON.parse(localStorage.getItem("aura.session-order.v1")!) });
    useStore.getState().setSessions([session("a"), session("c")]);
    expect(visible()).toEqual(["c", "a"]);
  });

  it("moves up and down only within the same state", () => {
    useStore.getState().setSessions([session("a"), session("b", { status: "running" }), session("c", { status: "running" }), session("d")]);
    // Working first, then idle; the displayed order is the ⌘-number order.
    expect(visible()).toEqual(["b", "c", "a", "d"]);
    useStore.getState().moveSessionBy("a", -1);
    expect(visible()).toEqual(["b", "c", "a", "d"]);
    useStore.getState().moveSessionTo("a", "c");
    expect(visible()).toEqual(["b", "c", "a", "d"]);
    useStore.getState().moveSessionBy("c", -1);
    useStore.getState().moveSessionBy("a", 1);
    expect(visible()).toEqual(["c", "b", "d", "a"]);
  });

  it("puts a new group below the existing ones", () => {
    useStore.getState().setSessions([session("a", { group: "z" }), session("b", { group: "a" })]);
    expect(visible()).toEqual(["a", "b"]);
  });

  it("lists leaders only, and reorders only leaders", () => {
    useStore.getState().setSessions([
      session("a", { orchestrator: true }),
      session("b"),
      session("c", { orchestrator_id: "a" }),
      session("d", { orchestrator_id: "a" }),
    ].map((s) => ({ ...s, group: "g" })));
    expect(visible()).toEqual(["a", "b"]);
    // A worker has no row of its own to move.
    useStore.getState().moveSessionBy("d", -1);
    expect(visible()).toEqual(["a", "b"]);
    useStore.getState().moveSessionTo("b", "a");
    expect(visible()).toEqual(["b", "a"]);
  });

  it("groups no longer make sections: every idle leader is in one", () => {
    useStore.getState().setSessions([
      session("a"),
      session("b", { orchestrator: true }),
      session("c", { orchestrator_id: "b" }),
      session("d", { group: "g", orchestrator: true }),
      session("e", { orchestrator_id: "d" }),
    ]);
    expect(selectSessionSections(useStore.getState()).map(([key, list]) => [key, list.map((s) => s.id)])).toEqual([
      [STATE_SECTION + "idle", ["a", "b", "d"]],
    ]);
  });

  it("nests a leader's whole tree in worker order while expanded, and only what waits on the user while collapsed", () => {
    useStore.getState().setSessions([
      session("a"),
      session("b", { orchestrator_id: "a", orchestrator: true }),
      session("c", { orchestrator_id: "b" }),
      session("d", { orchestrator_id: "a", pending_count: 1 }),
      session("e"),
    ]);
    const nested = () => selectNestedRows(useStore.getState(), "a");
    // Collapsed by default: the peek, and how many it leaves out.
    expect(nested()).toMatchObject({ expanded: false, more: 2, total: 3 });
    expect(nested().rows.map((r) => [r.session.id, r.depth])).toEqual([["d", 1]]);
    useStore.getState().setOrchestraExpanded("a", true);
    expect(nested().rows.map((r) => [r.session.id, r.depth])).toEqual([["b", 1], ["c", 2], ["d", 1]]);
    // An orchestrator under the leader closes on its own.
    useStore.getState().setOrchestraExpanded("b", false);
    expect(nested().rows.map((r) => r.session.id)).toEqual(["b", "d"]);
    expect(visible()).toEqual(["a", "e"]);
  });

  it("stops the nested list at 8 rows and says so", () => {
    useStore.getState().setSessions([session("a"), ...Array.from({ length: 9 }, (_, i) => session(`w${i}`, { orchestrator_id: "a", created_at: `2026-09-30T00:01:0${i}Z` }))]);
    useStore.getState().setOrchestraExpanded("a", true);
    const n = selectNestedRows(useStore.getState(), "a");
    expect(n.rows).toHaveLength(8);
    expect(n.overflow).toBe(true);
  });

  it("breaks an orchestrator cycle at its oldest session: one leader, each session listed and counted once", () => {
    // a and b point at each other, c works under a; a is the oldest.
    useStore.getState().setSessions([session("b", { orchestrator_id: "a" }), session("a", { orchestrator_id: "b" }), session("c", { orchestrator_id: "a", pending_count: 1 }), session("d")]);
    expect(visible()).toEqual(["a", "d"]);
    const st = useStore.getState();
    expect(selectListedSessions(st).map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
    expect(treeOf("a", st.sessions).map((s) => s.id)).toEqual(["b", "c"]);
    expect(rollupOf(st.sessions.a, st.sessions)).toBe("waiting");
    // b's own report of the loop changes nothing: the cycle still breaks at a.
    useStore.getState().upsertSession(session("b", { orchestrator_id: "a", status: "running" }));
    expect(visible()).toEqual(["a", "d"]);
    expect(selectListedSessions(useStore.getState()).map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("forgets expanded leaders that no longer exist", () => {
    useStore.getState().setSessions([session("a"), session("b", { orchestrator_id: "a" })]);
    useStore.getState().setOrchestraExpanded("a", true);
    useStore.getState().setOrchestraExpanded("z", true);
    useStore.getState().setSessions([session("a"), session("b", { orchestrator_id: "a" })]);
    expect(JSON.parse(localStorage.getItem("aura.sidebar-expanded.v1")!)).toEqual(["a"]);
  });
});
