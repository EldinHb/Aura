import { beforeEach, describe, expect, it } from "vitest";
import type { Session, Workspace } from "../gen";
import {
  STATE_SECTION, TASK_SECTION, selectListedSessions, selectNestedRows, selectRail, selectScheduledRail, selectSessionSections,
  selectTabActivity, selectVisibleSessions, selectWorkspaceActivity, useStore,
} from "./store";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });

function session(id: string, patch: Partial<Session> = {}): Session {
  return { id, title: id, cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false, pending_count: 0, attention: null, workspace: "one",
    created_at: "2026-11-20T00:00:00Z", last_activity: "2026-11-20T00:00:00Z", group: null, worktree: null, model: null, orchestrator: false, orchestrator_id: null, ...patch } as Session;
}
const ws = (id: string): Workspace => ({ id, name: id, position: 0, created_at: "" });
const st = () => useStore.getState();
const ids = (list: { id: string }[]) => list.map((s) => s.id);
const nested = (leader: string) => selectNestedRows(st(), leader).rows.map((r) => [r.session.id, r.depth]);

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    sessions: {}, sessionOrder: [], sidebarFilter: "", showArchived: false, expandedOrchestras: [], collapsedSubOrchestras: [], collapsedGroups: [],
    sidebarTab: "sessions", workspaces: [ws("one"), ws("two")], activeWorkspace: "one", selectedId: null, sidebarCursor: null, transcripts: {},
    tabs: [], activeTab: null, recentTabs: [], closedTabs: [], lastSelectedByWorkspace: {}, client: null,
  });
});

describe("scheduled runs keep their provenance", () => {
  it("keeps a run's worker on the Scheduled tab when the run's orchestrator is deleted", () => {
    st().setSessions([
      session("here"),
      session("run", { workspace: "two", orchestrator: true, scheduled_task_id: "t", scheduled_task_name: "Nightly", scheduled_run: "t" }),
      session("w", { workspace: "two", orchestrator_id: "run", scheduled_run: "t", pending_count: 1 }),
      session("hand", { workspace: "two", orchestrator: true }),
      session("hw", { workspace: "two", orchestrator_id: "hand", attention: "waiting" }),
    ]);
    const outOfStatus = () => {
      const rail = selectRail(st())!;
      expect([...rail.needsYou, ...rail.idle].map((r) => r.leader.id)).toEqual(["hand"]);
      useStore.setState({ activeWorkspace: "two" });
      expect(selectSessionSections(st()).flatMap(([, list]) => ids(list))).toEqual(["hand"]);
      useStore.setState({ activeWorkspace: "one" });
    };
    outOfStatus();
    expect(ids(selectScheduledRail(st()).map((r) => r.leader))).toEqual(["run"]);
    // The run's orchestrator goes; its worker, now heading nothing, stays a scheduled run.
    st().removeSession("run");
    outOfStatus();
    expect(ids(selectScheduledRail(st()).map((r) => r.leader))).toEqual(["w"]);
    useStore.setState({ activeWorkspace: "two" });
    expect(selectSessionSections(st(), false, "scheduled").map(([k, list]) => [k, ids(list)])).toEqual([[TASK_SECTION + "t", ["w"]]]);
    expect(selectTabActivity(st(), "sessions").pending).toBe(0);
    expect(selectWorkspaceActivity(st()).two.pending).toBe(0);
  });

  it("falls back to the orchestrator chain against a daemon without scheduled_run", () => {
    st().setSessions([session("run", { orchestrator: true, scheduled_task_id: "t" }), session("w", { orchestrator_id: "run", pending_count: 1 })]);
    expect(selectSessionSections(st())).toEqual([]);
    expect(ids(selectSessionSections(st(), false, "scheduled").flatMap(([, list]) => list))).toEqual(["run"]);
  });
});

describe("archived workers in the tree", () => {
  // lead ─ sub (archived orchestrator) ─ grand (waits on the user); lead ─ w
  const setup = () => st().setSessions([
    session("lead", { orchestrator: true }),
    session("sub", { orchestrator_id: "lead", orchestrator: true, archived: true, created_at: "2026-11-20T01:00:00Z" }),
    session("grand", { orchestrator_id: "sub", attention: "waiting" }),
    session("w", { orchestrator_id: "lead", created_at: "2026-11-20T02:00:00Z" }),
  ]);

  it("keeps a live worker under an archived one reachable, collapsed and expanded", () => {
    setup();
    expect(selectSessionSections(st()).map(([k]) => k)).toEqual([STATE_SECTION + "waiting"]);
    expect(nested("lead")).toEqual([["grand", 1]]);
    st().setOrchestraExpanded("lead", true);
    // The archived orchestrator is hidden; its worker takes its place.
    expect(nested("lead")).toEqual([["grand", 1], ["w", 1]]);
    // Showing archived sessions shows it, with its worker under it.
    st().setShowArchived(true);
    expect(nested("lead")).toEqual([["sub", 1], ["grand", 2], ["w", 1]]);
    st().setShowArchived(false);
    expect(nested("lead")).toEqual([["grand", 1], ["w", 1]]);
  });
});

describe("the nested list's cap", () => {
  it("shows the selected worker past the cap, with the orchestrators above it", () => {
    st().setSessions([
      session("lead", { orchestrator: true }),
      ...Array.from({ length: 9 }, (_, i) => session(`w${i}`, { orchestrator_id: "lead", created_at: `2026-11-20T00:0${i}:00Z` })),
      session("sub", { orchestrator_id: "lead", orchestrator: true, created_at: "2026-11-20T01:00:00Z" }),
      session("deep", { orchestrator_id: "sub" }),
    ]);
    st().setOrchestraExpanded("lead", true);
    expect(nested("lead").map(([id]) => id)).toEqual(["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7"]);
    // From ⌘K, the inbox or the rail.
    st().select("deep");
    const rows = selectNestedRows(st(), "lead");
    expect(rows.rows.map((r) => [r.session.id, r.depth])).toEqual([["w0", 1], ["w1", 1], ["w2", 1], ["w3", 1], ["w4", 1], ["w5", 1], ["w6", 1], ["w7", 1], ["sub", 1], ["deep", 2]]);
    expect(rows.overflow).toBe(true);
    st().select("w8");
    expect(nested("lead").map(([id]) => id)).toContain("w8");
    expect(nested("lead").map(([id]) => id)).not.toContain("deep");
  });
});

describe("selectors at scale", () => {
  /** 2,000 sessions: 400 leaders in two workspaces, each with three workers and a sub-worker; every tenth a scheduled run. */
  function big(): Session[] {
    const list: Session[] = [];
    for (let i = 0; i < 400; i++) {
      const lead = `l${i}`;
      const scheduled = i % 10 === 0 ? { scheduled_task_id: `t${i % 7}`, scheduled_run: `t${i % 7}` } : {};
      const workspace = i % 2 ? "two" : "one";
      list.push(session(lead, { orchestrator: true, workspace, status: i % 3 ? "idle" : "running", ...scheduled }));
      for (let w = 0; w < 3; w++) list.push(session(`${lead}w${w}`, { orchestrator_id: lead, workspace, orchestrator: w === 0, pending_count: i % 11 === w ? 1 : 0, scheduled_run: scheduled.scheduled_run }));
      list.push(session(`${lead}s`, { orchestrator_id: `${lead}w0`, workspace, attention: i % 5 ? null : "done", scheduled_run: scheduled.scheduled_run }));
    }
    return list;
  }
  const time = (f: () => unknown) => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };

  it("builds each list well under 20 ms from a fresh snapshot of 2,000 sessions, and not again on unrelated changes", () => {
    const list = big();
    expect(list).toHaveLength(2000);
    st().setSessions(list);
    useStore.setState({ expandedOrchestras: list.filter((s) => !s.orchestrator_id).slice(0, 50).map((s) => s.id) });
    // A fresh sessions object, as every daemon event makes one.
    useStore.setState({ sessions: { ...st().sessions } });
    const cold = {
      visible: time(() => selectVisibleSessions(st())),
      listed: time(() => selectListedSessions(st())),
      nested: time(() => selectVisibleSessions(st()).forEach((l) => selectNestedRows(st(), l.id))),
      rail: time(() => selectRail(st())),
      scheduled: time(() => selectScheduledRail(st())),
      tabs: time(() => selectTabActivity(st(), "sessions")),
      workspaces: time(() => selectWorkspaceActivity(st())),
    };
    for (const [name, ms] of Object.entries(cold)) expect(ms, `${name}: ${ms.toFixed(1)} ms`).toBeLessThan(20);
    expect(selectListedSessions(st())).toHaveLength(2000);
    // A transcript growing changes none of it: the same lists, at no cost.
    const visible = selectVisibleSessions(st());
    const listed = selectListedSessions(st());
    useStore.setState({ transcripts: { l1: { ...st().transcripts.l1 } as never } });
    expect(selectVisibleSessions(st())).toBe(visible);
    expect(selectListedSessions(st())).toBe(listed);
  });
});
