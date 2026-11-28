import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Event, Session } from "../gen";
import type { RpcClient } from "../lib/rpc";
import type { RemoteComputer } from "../lib/remoteComputers";

// The shell is not here: its commands and the bridge client are fakes.
const shell = vi.hoisted(() => ({
  list: [] as unknown[],
  onChange: null as null | ((list: unknown[]) => void),
  clients: [] as unknown[],
  make: null as null | ((id: string) => unknown),
}));
vi.mock("../lib/remoteComputers", async (orig) => ({
  ...(await orig<typeof import("../lib/remoteComputers")>()),
  remotesApi: {
    list: () => Promise.resolve(shell.list),
    bridge: (id: string) => Promise.resolve({ port: 1, token: id }),
    retry: () => Promise.resolve(),
    onChange: (f: (list: unknown[]) => void) => {
      shell.onChange = f;
      return Promise.resolve(() => {});
    },
  },
}));
vi.mock("../lib/remoteClient", () => ({
  RemoteRpcClient: function (this: unknown, id: string) {
    const c = shell.make!(id);
    shell.clients.push(c);
    return c;
  },
  isRemoteClient: (c: { remote?: boolean }) => !!c?.remote,
}));

const { LOCAL, otherComputersPending, startComputers, switchComputer, trackSessions, useComputers, resetComputersForTests } = await import("./computers");
const { useStore } = await import("./store");
const { inboxCount } = await import("./attention");

const writes: string[] = [];
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { writes.push(k); values.set(k, v); }, removeItem: (k: string) => values.delete(k), clear: () => values.clear() },
});

function session(id: string, patch: Partial<Session> = {}): Session {
  return { id, title: id.toUpperCase(), cwd: `/work/${id}`, provider: "claude", status: "idle", mode: "structured", archived: false, pinned: false, workspace: "w",
    pending_count: 0, attention: null, created_at: "2026-11-20T00:00:00Z", last_activity: "2026-11-20T00:00:00Z", group: null, worktree: null, model: null, orchestrator: false, orchestrator_id: null, ...patch } as Session;
}

type Fake = RpcClient & { emit: (ev: Event) => void; list: Session[]; closed: boolean };
function fake(list: Session[], remote = false): Fake {
  const events = new Set<(ev: Event) => void>();
  const c = {
    remote,
    list,
    closed: false,
    state: "open",
    connect: () => Promise.resolve(),
    close() { c.closed = true; },
    onEvent: (l: (ev: Event) => void) => { events.add(l); return () => events.delete(l); },
    onState: () => () => {},
    onNotification: () => () => {},
    emit: (ev: Event) => events.forEach((l) => l(ev)),
    sessions: () => Promise.resolve(c.list),
    providers: () => Promise.resolve([]),
    daemonInfo: () => Promise.resolve({ version: "0.6.3" }),
    workspaces: () => Promise.resolve([{ id: "w", name: "Default", position: 0, created_at: "" }]),
    touchWorkspace: vi.fn(() => Promise.resolve(true)),
    features: () => Promise.resolve([]),
    roleSuggestions: () => Promise.resolve([]),
  };
  return c as unknown as Fake;
}

const remote = (id: string, name: string, state: RemoteComputer["state"] = { kind: "online", serverName: name, version: "0.6.3" }): RemoteComputer => ({
  id, name, label: null, serverName: name, host: "10.0.0.2", alt: [], port: 7443, fingerprint: "ab".repeat(32), deviceId: "d", pairedAt: "", state,
});

let local: Fake;
let server: Fake;
beforeEach(() => {
  resetComputersForTests();
  writes.length = 0;
  local = fake([session("a"), session("b", { pending_count: 1 })]);
  server = fake([session("x", { pending_count: 2 }), session("y")], true);
  shell.clients = [];
  shell.make = () => server;
  shell.list = [remote("srv", "Home server")];
  useStore.setState({
    computer: LOCAL, client: local, localClient: local, connection: "open",
    sessions: { a: session("a"), b: session("b", { pending_count: 1 }) }, sessionOrder: ["a", "b"],
    tabs: [{ kind: "session", key: "s:a", sessionId: "a", preview: false }] as never, activeTab: "s:a", recentTabs: ["s:a"], closedTabs: [],
    selectedId: "a", workspaces: [{ id: "w", name: "Default", position: 0, created_at: "" }], activeWorkspace: "w", transcripts: {},
    expandedOrchestras: [], collapsedSubOrchestras: [], modView: null, dialog: { kind: "none" },
  });
  useComputers.setState({ remotes: shell.list as RemoteComputer[] });
});
afterEach(() => resetComputersForTests());

it("shows a remote's sessions, keeps this computer's view aside and saves nothing of the remote's", async () => {
  await switchComputer("srv");
  let st = useStore.getState();
  expect(st.computer).toBe("srv");
  expect(st.client).toBe(server);
  expect(Object.keys(st.sessions).sort()).toEqual(["x", "y"]);
  expect(st.tabs.every((t) => t.kind !== "session" || ["x", "y"].includes(t.sessionId))).toBe(true);
  // Nothing of this computer's saved state was overwritten.
  expect(writes.filter((k) => k !== "aura.sidebar-collapsed-groups.v1" && k !== "aura.sidebar-tab.v1")).toEqual([]);
  // A remote is never told which workspace is active (workspace.touch is this computer's).
  expect(server.touchWorkspace).not.toHaveBeenCalled();

  await switchComputer(LOCAL);
  st = useStore.getState();
  expect(st.computer).toBe(LOCAL);
  expect(st.client).toBe(local);
  expect(Object.keys(st.sessions).sort()).toEqual(["a", "b"]);
  expect(st.activeTab).toBe("s:a");
  expect(st.selectedId).toBe("a");
});

it("a remote that is not paired cannot be shown", async () => {
  await expect(switchComputer("nope")).rejects.toThrow("not paired");
  expect(useStore.getState().computer).toBe(LOCAL);
});

it("counts what waits on every other computer for the inbox", async () => {
  const offLocal = trackSessions(LOCAL, local);
  const offServer = trackSessions("srv", server);
  await vi.waitFor(() => expect(Object.keys(useComputers.getState().sessions)).toEqual([LOCAL, "srv"]));
  expect(otherComputersPending(LOCAL)).toBe(2);
  expect(otherComputersPending("srv")).toBe(1);
  // The store counts the computer shown (1 here); the others add theirs.
  expect(inboxCount(useStore.getState(), [])).toBe(3);

  // Kept current from the remote's events.
  server.emit({ type: "session_updated", session: session("y", { pending_count: 3 }) });
  expect(otherComputersPending(LOCAL)).toBe(5);
  server.emit({ type: "session_removed", session_id: "x" });
  expect(otherComputersPending(LOCAL)).toBe(3);
  offServer();
  expect(otherComputersPending(LOCAL)).toBe(0);
  offLocal();
});

it("connects to each paired remote, and goes back to this computer when the shown one is removed", async () => {
  const stop = await startComputers();
  expect(shell.clients).toHaveLength(1);
  await switchComputer("srv");
  expect(useStore.getState().computer).toBe("srv");
  shell.onChange!([]);
  await vi.waitFor(() => expect(useStore.getState().computer).toBe(LOCAL));
  await vi.waitFor(() => expect(server.closed).toBe(true));
  expect(useComputers.getState().remotes).toEqual([]);
  stop();
});

it("a remote coming back from needing pairing gets a fresh connection", async () => {
  shell.list = [remote("srv", "Home server", { kind: "revoked", reason: "removed" })];
  const stop = await startComputers();
  expect(shell.clients).toHaveLength(1);
  const first = shell.clients[0] as Fake;
  const next = fake([], true);
  shell.make = () => next;
  shell.onChange!([remote("srv", "Home server", { kind: "idle" })]);
  await vi.waitFor(() => expect(shell.clients).toHaveLength(2));
  expect(first.closed).toBe(true);
  stop();
});
