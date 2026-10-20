import { beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../gen";
import { ORCHESTRATORS_SECTION, selectSessionSections, selectVisibleSessions, useStore } from "./store";

function session(id: string, patch: Partial<Session> = {}): Session {
  return { id, title: id, cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false, pending_count: 0,
    created_at: `2026-09-30T00:00:${String(id.charCodeAt(0) - 90).padStart(2, "0")}Z`, last_activity: "2026-09-30T00:00:00Z", group: null, worktree: null, model: null, ...patch } as Session;
}
const visible = () => selectVisibleSessions(useStore.getState()).map((s) => s.id);

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ sessions: {}, sessionOrder: [], sidebarFilter: "", showArchived: false, collapsedOrchestras: [] });
});

describe("session order", () => {
  it("starts oldest first and appends new sessions instead of pushing others down", () => {
    useStore.getState().setSessions([session("b"), session("a")]);
    expect(visible()).toEqual(["a", "b"]);
    useStore.getState().upsertSession(session("c"));
    expect(visible()).toEqual(["a", "b", "c"]);
  });

  it("does not reorder on activity", () => {
    useStore.getState().setSessions([session("a"), session("b")]);
    useStore.getState().upsertSession(session("b", { last_activity: "2026-10-01T00:00:00Z", status: "running" }));
    expect(visible()).toEqual(["a", "b"]);
  });

  it("keeps the saved order across a reload and drops removed sessions", () => {
    useStore.getState().setSessions([session("a"), session("b"), session("c")]);
    useStore.getState().moveSessionTo("c", "a");
    expect(visible()).toEqual(["c", "a", "b"]);
    useStore.setState({ sessionOrder: JSON.parse(localStorage.getItem("aura.session-order.v1")!) });
    useStore.getState().setSessions([session("a"), session("c")]);
    expect(visible()).toEqual(["c", "a"]);
  });

  it("moves up and down only within the same group", () => {
    useStore.getState().setSessions([session("a"), session("b", { group: "x" }), session("c", { group: "x" }), session("d")]);
    // Ungrouped first, then groups; the displayed order is the ⌘-number order.
    expect(visible()).toEqual(["a", "d", "b", "c"]);
    useStore.getState().moveSessionBy("b", -1);
    expect(visible()).toEqual(["a", "d", "b", "c"]);
    useStore.getState().moveSessionTo("a", "b");
    expect(visible()).toEqual(["a", "d", "b", "c"]);
    useStore.getState().moveSessionBy("c", -1);
    useStore.getState().moveSessionBy("a", 1);
    expect(visible()).toEqual(["d", "a", "c", "b"]);
  });

  it("puts a new group below the existing ones", () => {
    useStore.getState().setSessions([session("a", { group: "z" }), session("b", { group: "a" })]);
    expect(visible()).toEqual(["a", "b"]);
  });

  it("shows workers under their orchestrator and reorders them only among each other", () => {
    useStore.getState().setSessions([
      session("a", { orchestrator: true }),
      session("b"),
      session("c", { orchestrator_id: "a" }),
      session("d", { orchestrator_id: "a" }),
      session("e", { orchestrator_id: "z" }),
    ].map((s) => ({ ...s, group: "g" })));
    // An orchestrator that is not shown leaves its worker where it is.
    expect(visible()).toEqual(["a", "c", "d", "b", "e"]);
    useStore.getState().moveSessionBy("d", -1);
    expect(visible()).toEqual(["a", "d", "c", "b", "e"]);
    useStore.getState().moveSessionTo("c", "b");
    expect(visible()).toEqual(["a", "d", "c", "b", "e"]);
    // Moving the orchestrator takes its workers along.
    useStore.getState().moveSessionTo("b", "a");
    expect(visible()).toEqual(["b", "a", "d", "c", "e"]);
  });

  it("puts orchestrators in no group first, in a section of their own with their workers", () => {
    useStore.getState().setSessions([
      session("a"),
      session("b", { orchestrator: true }),
      session("c", { orchestrator_id: "b" }),
      session("d", { group: "g", orchestrator: true }),
      session("e", { orchestrator_id: "d" }),
    ]);
    // A worker in another group than its orchestrator's stays in its own.
    expect(useStore.getState().sessions.e.group).toBeNull();
    expect(selectSessionSections(useStore.getState()).map(([key, list]) => [key, list.map((s) => s.id)])).toEqual([
      [ORCHESTRATORS_SECTION, ["b", "c"]],
      ["", ["a", "e"]],
      ["g", ["d"]],
    ]);
  });

  it("shows the workers of a worker that orchestrates in turn", () => {
    useStore.getState().setSessions([session("a"), session("b", { orchestrator_id: "a" }), session("c", { orchestrator_id: "b" }), session("d")]);
    expect(visible()).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps orchestrators that point at each other, below the others", () => {
    useStore.getState().setSessions([session("a", { orchestrator_id: "b" }), session("b", { orchestrator_id: "a" }), session("c")]);
    expect(visible()).toEqual(["c", "a", "b"]);
  });

  it("moves a session up and down past a whole orchestra", () => {
    useStore.getState().setSessions([session("a"), session("b", { orchestrator_id: "a" }), session("c", { orchestrator_id: "a" }), session("d")]);
    useStore.getState().moveSessionBy("d", -1);
    expect(visible()).toEqual(["d", "a", "b", "c"]);
    useStore.getState().moveSessionBy("d", 1);
    expect(visible()).toEqual(["a", "b", "c", "d"]);
    // The last worker has no worker of its orchestrator below it.
    useStore.getState().moveSessionBy("c", 1);
    expect(visible()).toEqual(["a", "b", "c", "d"]);
  });

  it("forgets collapsed orchestrators that no longer exist", () => {
    useStore.getState().setSessions([session("a"), session("b", { orchestrator_id: "a" })]);
    useStore.getState().setOrchestraCollapsed("a", true);
    useStore.getState().setOrchestraCollapsed("z", true);
    expect(visible()).toEqual(["a"]);
    useStore.getState().setSessions([session("a"), session("b", { orchestrator_id: "a" })]);
    expect(JSON.parse(localStorage.getItem("aura.sidebar-collapsed.v1")!)).toEqual(["a"]);
  });
});
