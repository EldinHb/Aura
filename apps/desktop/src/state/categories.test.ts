import { beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../gen";
import { categoryOf, selectSessionSections, STATE_SECTION, useStore } from "./store";
import { newlyWaiting, snapshot } from "./waitingSound";

function session(id: string, patch: Partial<Session> = {}): Session {
  return { id, title: id, cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false, pending_count: 0, attention: null,
    created_at: "2026-09-30T00:00:00Z", last_activity: "2026-09-30T00:00:00Z", group: null, worktree: null, model: null, orchestrator: false, orchestrator_id: null, ...patch } as Session;
}

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ sessions: {}, sessionOrder: [], sidebarFilter: "", showArchived: false, collapsedOrchestras: [], collapsedGroups: [], sidebarTab: "sessions" });
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

  it("keeps a worker under its orchestrator only while both are in the same state", () => {
    useStore.getState().setSessions([
      session("lead", { orchestrator: true, status: "running" }),
      session("w1", { orchestrator_id: "lead", status: "running" }),
      session("w2", { orchestrator_id: "lead", attention: "done" }),
    ]);
    const sections = Object.fromEntries(selectSessionSections(useStore.getState()).map(([k, list]) => [k.slice(STATE_SECTION.length), list.map((s) => s.id)]));
    expect(sections).toEqual({ waiting: ["w2"], working: ["lead", "w1"] });
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
