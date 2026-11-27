import { beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../gen";
import { categoryOf, rollupOf, selectSessionSections, STATE_SECTION, useStore } from "./store";
import { newlyWaiting, snapshot } from "./waitingSound";

function session(id: string, patch: Partial<Session> = {}): Session {
  return { id, title: id, cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false, pending_count: 0, attention: null,
    created_at: "2026-09-30T00:00:00Z", last_activity: "2026-09-30T00:00:00Z", group: null, worktree: null, model: null, orchestrator: false, orchestrator_id: null, ...patch } as Session;
}

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ sessions: {}, sessionOrder: [], sidebarFilter: "", showArchived: false, expandedOrchestras: [], collapsedSubOrchestras: [], workspaces: [], collapsedGroups: [], sidebarTab: "sessions" });
});

describe("session categories", () => {
  it("waits for the user on a question, an approval, or news not yet seen", () => {
    expect(categoryOf(session("a", { pending_count: 1, status: "running" }))).toBe("waiting");
    expect(categoryOf(session("a", { status: "waiting_input" }))).toBe("waiting");
    expect(categoryOf(session("a", { status: "waiting_approval" }))).toBe("waiting");
    expect(categoryOf(session("a", { attention: "done" }))).toBe("waiting");
    expect(categoryOf(session("a", { attention: "failed", status: "error" }))).toBe("waiting");
  });

  it("works while its agent is busy, and is idle otherwise", () => {
    expect(categoryOf(session("a", { status: "running" }))).toBe("working");
    expect(categoryOf(session("a"))).toBe("idle");
    expect(categoryOf(session("a", { status: "exited" }))).toBe("idle");
    expect(categoryOf(session("a", { status: "error" }))).toBe("idle");
  });

  it("lists the Sessions tab as waiting, working, idle — empty ones left out", () => {
    useStore.getState().setSessions([
      session("idle1"),
      session("busy", { status: "running" }),
      session("asks", { pending_count: 2 }),
      session("idle2", { group: "web" }),
    ]);
    const sections = selectSessionSections(useStore.getState());
    expect(sections.map(([k, list]) => [k.slice(STATE_SECTION.length), list.map((s) => s.id)])).toEqual([
      ["waiting", ["asks"]],
      ["working", ["busy"]],
      ["idle", ["idle1", "idle2"]],
    ]);
  });

  it("sections leaders only, by the state of their whole tree", () => {
    useStore.getState().setSessions([
      session("lead", { orchestrator: true }),
      session("w1", { orchestrator_id: "lead", status: "running" }),
      session("w2", { orchestrator_id: "lead", attention: "done" }),
      session("idle"),
    ]);
    const sections = () => Object.fromEntries(selectSessionSections(useStore.getState()).map(([k, list]) => [k.slice(STATE_SECTION.length), list.map((s) => s.id)]));
    // A working worker makes its idle leader working; its finished worker does not make it wait.
    expect(sections()).toEqual({ working: ["lead"], idle: ["idle"] });
    // A worker that waits on the user, at any depth, puts its leader in Waiting for you.
    useStore.getState().upsertSession(session("sub", { orchestrator_id: "w1", orchestrator: true }));
    useStore.getState().upsertSession(session("deep", { orchestrator_id: "sub", status: "waiting_input" }));
    expect(sections()).toEqual({ waiting: ["lead"], idle: ["idle"] });
  });

  it("rolls up needs you > working > idle", () => {
    const sessions = (list: ReturnType<typeof session>[]) => Object.fromEntries(list.map((s) => [s.id, s]));
    const lead = session("lead");
    expect(rollupOf(lead, sessions([lead, session("w", { orchestrator_id: "lead" })]))).toBe("idle");
    expect(rollupOf(lead, sessions([lead, session("w", { orchestrator_id: "lead", status: "running" })]))).toBe("working");
    expect(rollupOf(lead, sessions([lead, session("w", { orchestrator_id: "lead", status: "running" }), session("x", { orchestrator_id: "lead", pending_count: 1 })]))).toBe("waiting");
    expect(rollupOf(lead, sessions([lead, session("w", { orchestrator_id: "lead", attention: "waiting" })]))).toBe("waiting");
    expect(rollupOf(lead, sessions([lead, session("w", { orchestrator_id: "lead", attention: "failed" })]))).toBe("idle");
    // The leader's own news counts, as before.
    expect(rollupOf(session("lead", { attention: "done" }), sessions([lead]))).toBe("waiting");
    // An archived worker does not count.
    expect(rollupOf(lead, sessions([lead, session("w", { orchestrator_id: "lead", status: "running", archived: true })]))).toBe("idle");
  });
});

describe("the waiting sound", () => {
  it("is for sessions that went from working to waiting, nothing else", () => {
    const before = snapshot({
      a: session("a", { status: "running" }),
      b: session("b", { status: "running" }),
      c: session("c"),
      d: session("d", { status: "running" }),
    });
    const after = {
      a: session("a", { attention: "done" }), // finished
      b: session("b", { status: "running", pending_count: 1 }), // asks while working
      c: session("c", { attention: "done" }), // was idle: not a transition from working
      d: session("d", { status: "running" }), // still working
      e: session("e", { attention: "done" }), // new
    };
    expect(newlyWaiting(before, after).sort()).toEqual(["a", "b"]);
  });
});
