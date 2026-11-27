import { beforeEach, expect, it, vi } from "vitest";
import type { ConnectionState } from "../lib/rpc";
import type { Event, Session, Workspace } from "../gen";
import { syncWithDaemon } from "./daemonSync";
import { useStore } from "./store";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });

const session = (id: string) => ({ id, title: id, workspace: "one", status: "idle", archived: false, pinned: false, pending_count: 0, attention: null, orchestrator_id: null, created_at: "", last_activity: "" }) as Session;
const ws = (id: string): Workspace => ({ id, name: id, position: 0, created_at: "" });

/** A client whose connection the test drops and restores, as the RPC client's own reconnect does. */
function fakeClient() {
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const eventListeners = new Set<(ev: Event) => void>();
  let fail: ((e: Error) => void) | null = null;
  const client = {
    state: "open" as ConnectionState,
    providers: vi.fn(async () => []),
    // The first fetch hangs until the test drops the connection; later ones answer.
    sessions: vi.fn(() => (client.sessions.mock.calls.length === 1 ? new Promise<Session[]>((_, reject) => { fail = reject; }) : Promise.resolve([session("a")]))),
    daemonInfo: vi.fn(async () => ({ version: "0.5.0" })),
    workspaces: vi.fn(async () => [ws("one")]),
    touchWorkspace: vi.fn(async () => true),
    features: vi.fn(async () => []),
    roleSuggestions: vi.fn(async () => []),
    onState: (l: (s: ConnectionState) => void) => { stateListeners.add(l); return () => stateListeners.delete(l); },
    onEvent: (l: (ev: Event) => void) => { eventListeners.add(l); return () => eventListeners.delete(l); },
    setState(s: ConnectionState) {
      client.state = s;
      for (const l of stateListeners) l(s);
    },
    drop() {
      client.setState("closed");
      fail?.(new Error("connection closed"));
    },
  };
  return client;
}

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ connection: "closed", sessions: {}, sessionOrder: [], workspaces: [], activeWorkspace: null, selectedId: null, modView: null, tabs: [], activeTab: null, recentTabs: [], closedTabs: [], toasts: [] });
});

it("follows a connection that drops during the first snapshot, and loads on the reconnect", async () => {
  const client = fakeClient();
  const off = syncWithDaemon(client as never, { initialSession: null, selectFirst: true });
  expect(useStore.getState().connection).toBe("open");
  // The connection drops while the first lists load.
  client.drop();
  await vi.waitFor(() => expect(useStore.getState().connection).toBe("closed"));
  expect(useStore.getState().sessions).toEqual({});
  // Not an error for the user: the reconnect redoes it.
  expect(useStore.getState().toasts).toEqual([]);
  // The client reconnects on its own.
  client.setState("connecting");
  expect(useStore.getState().connection).toBe("connecting");
  client.setState("open");
  await vi.waitFor(() => expect(Object.keys(useStore.getState().sessions)).toEqual(["a"]));
  expect(useStore.getState().connection).toBe("open");
  expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(["one"]);
  expect(useStore.getState().selectedId).toBe("a");
  off();
});

it("says so when a refresh fails while the connection stays up", async () => {
  const client = fakeClient();
  client.sessions.mockImplementation(() => Promise.reject(new Error("boom")));
  const off = syncWithDaemon(client as never, { initialSession: null, selectFirst: true });
  await vi.waitFor(() => expect(useStore.getState().toasts.map((t) => t.message)).toEqual(["Could not load sessions: boom"]));
  off();
});

// The window's DaemonLink waits on `loaded` before a new client becomes the window's.
it("settles `loaded` once the first snapshot is in", async () => {
  const client = fakeClient();
  client.sessions.mockImplementation(async () => [session("a")]);
  const sync = syncWithDaemon(client as never, { initialSession: null, selectFirst: true });
  await sync.loaded;
  expect(Object.keys(useStore.getState().sessions)).toEqual(["a"]);
  sync();
});

it("settles `loaded` without rejecting when the first snapshot is cut off, so the client still takes over and reconnects", async () => {
  const client = fakeClient();
  const sync = syncWithDaemon(client as never, { initialSession: null, selectFirst: true });
  client.drop();
  await expect(sync.loaded).resolves.toBeUndefined();
  expect(useStore.getState().toasts).toEqual([]);
  sync();
});
