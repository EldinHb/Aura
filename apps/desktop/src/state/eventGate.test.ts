import { beforeEach, expect, it } from "vitest";
import type { Event, Session, Workspace } from "../gen";
import { EventGate } from "./eventGate";
import { useStore } from "./store";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });

const ws = (id: string, name: string): Workspace => ({ id, name, position: 0, created_at: "" });
const session = (id: string, title: string) => ({ id, title, workspace: "one", status: "idle", archived: false, pinned: false, pending_count: 0, attention: null, orchestrator_id: null, created_at: "", last_activity: "" }) as Session;
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ workspaces: [], activeWorkspace: null, sessions: {}, sessionOrder: [], tabs: [], activeTab: null, recentTabs: [], closedTabs: [], client: null });
});

it("replays events that arrive while the snapshot loads over the snapshot, so a newer event is not lost or overwritten", async () => {
  const st = useStore.getState;
  const gate = new EventGate<Event>((ev) => st().applyEvent(ev));
  const fetch = deferred<{ workspaces: Workspace[]; sessions: Session[] }>();
  const refreshing = gate.during(() => fetch.promise, (snap) => {
    st().setWorkspaces(snap.workspaces);
    st().setSessions(snap.sessions);
  });
  // While the lists are fetched, the user creates a workspace and a session is renamed.
  gate.push({ type: "workspaces_changed", workspaces: [ws("one", "One"), ws("two", "Two")] });
  gate.push({ type: "session_updated", session: session("a", "Renamed") });
  expect(st().workspaces).toEqual([]);
  // The fetched lists are older than those events.
  fetch.resolve({ workspaces: [ws("one", "One")], sessions: [session("a", "Old title")] });
  await refreshing;
  expect(st().workspaces.map((w) => w.id)).toEqual(["one", "two"]);
  expect(st().sessions.a.title).toBe("Renamed");
  // Afterwards events apply at once.
  gate.push({ type: "workspaces_changed", workspaces: [ws("two", "Two")] });
  expect(st().workspaces.map((w) => w.id)).toEqual(["two"]);
});

it("releases held events when the fetch fails, as on a reconnect that drops again", async () => {
  const st = useStore.getState;
  const gate = new EventGate<Event>((ev) => st().applyEvent(ev));
  const fetch = deferred<Workspace[]>();
  const refreshing = gate.during(() => fetch.promise, (w) => st().setWorkspaces(w));
  gate.push({ type: "workspaces_changed", workspaces: [ws("one", "One")] });
  fetch.reject(new Error("closed"));
  await expect(refreshing).rejects.toThrow("closed");
  expect(st().workspaces.map((w) => w.id)).toEqual(["one"]);
});
