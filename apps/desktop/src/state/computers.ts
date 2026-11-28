/**
 * The computers the window can show: this one (its own daemon) and every
 * remote computer paired in the desktop shell. One is shown at a time — the
 * store's `client` and everything that follows it (sidebar, sessions,
 * transcripts, the new-session dialog) are that computer's — while every
 * computer stays connected in the background, so the inbox and the Dock
 * badge count what waits on the user everywhere.
 *
 * A remote computer's client goes through the shell's bridge
 * (lib/remoteClient.ts). It reconnects on its own; the shell paces the
 * attempts and reports why one fails (`RemoteComputer.state`). A remote that
 * goes away never touches this computer's connection: they are separate
 * clients.
 *
 * Switching keeps each computer's view (tabs, selection, workspace, open
 * orchestrators) in memory and puts it back on return; only this computer's
 * is saved across restarts.
 */
import { create } from "zustand";
import type { Approval, Event, Session, UserInputRequest } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { RemoteRpcClient } from "../lib/remoteClient";
import { needsPairing, remotesApi, type RemoteComputer } from "../lib/remoteComputers";
import { LOCAL, selectLocalClient, setPersistLocal, useStore, type AppState } from "./store";
import { syncWithDaemon, type Sync, type SyncOptions } from "./daemonSync";

export { LOCAL };

/** What the window knows of each computer it is connected to. */
export type ComputersState = {
  /** The paired remote computers, in the order they were added. */
  remotes: RemoteComputer[];
  /** Loaded from the shell (false outside the desktop app). */
  loaded: boolean;
  /** Each connected computer's sessions (`LOCAL` too), kept current in the background. */
  sessions: Record<string, Record<string, Session>>;
};

export const useComputers = create<ComputersState>(() => ({ remotes: [], loaded: false, sessions: {} }));

/** "This Mac", or "This computer" elsewhere. */
export function localName(): string {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? "") ? "This Mac" : "This computer";
}

/** A computer's name as the switcher shows it. */
export function computerName(id: string, remotes = useComputers.getState().remotes): string {
  return id === LOCAL ? localName() : remotes.find((r) => r.id === id)?.name ?? "Remote computer";
}

// ---- clients ---------------------------------------------------------------

const remoteClients = new Map<string, RemoteRpcClient>();
const untrack = new Map<string, () => void>();

/** The client of computer `id`, if connected. */
export function clientOf(id: string): RpcClient | null {
  return id === LOCAL ? selectLocalClient(useStore.getState()) : remoteClients.get(id) ?? null;
}

/** Every computer with a client: this one first, then the remotes. */
export function connectedComputers(): { id: string; client: RpcClient }[] {
  const out: { id: string; client: RpcClient }[] = [];
  const local = clientOf(LOCAL);
  if (local) out.push({ id: LOCAL, client: local });
  for (const [id, client] of remoteClients) out.push({ id, client });
  return out;
}

/** Things worth a desktop notification on a computer that is not shown. */
let backgroundNotify: ((computer: string, session: Session | undefined, ev: Event) => void) | null = null;
export function setBackgroundNotifier(f: typeof backgroundNotify) {
  backgroundNotify = f;
}

/**
 * Keep `useComputers.sessions[id]` current from `client`: the list on every
 * (re)connect and after a `lagged`, then `session_*` events. Returns what stops it.
 */
export function trackSessions(id: string, client: RpcClient): () => void {
  const put = (f: (cur: Record<string, Session>) => Record<string, Session>) =>
    useComputers.setState((s) => ({ sessions: { ...s.sessions, [id]: f(s.sessions[id] ?? {}) } }));
  const refresh = () =>
    client.sessions().then(
      (list) => put(() => Object.fromEntries(list.map((x) => [x.id, x]))),
      () => {},
    );
  const offEvent = client.onEvent((ev) => {
    if (ev.type === "session_created" || ev.type === "session_updated") put((cur) => ({ ...cur, [ev.session.id]: ev.session }));
    else if (ev.type === "session_removed")
      put((cur) => {
        const { [ev.session_id]: _gone, ...rest } = cur;
        void _gone;
        return rest;
      });
    else if ((ev.type === "approval_requested" || ev.type === "user_input_requested") && useStore.getState().computer !== id)
      backgroundNotify?.(id, useComputers.getState().sessions[id]?.[ev.session_id], ev);
  });
  const offNote = client.onNotification((method) => {
    if (method === "lagged") void refresh();
  });
  const offState = client.onState((s) => {
    if (s === "open") void refresh();
  });
  if (client.state === "open") void refresh();
  return () => {
    offEvent();
    offNote();
    offState();
    useComputers.setState((s) => {
      const { [id]: _gone, ...rest } = s.sessions;
      void _gone;
      return { sessions: rest };
    });
  };
}

async function ensureRemoteClient(id: string): Promise<RemoteRpcClient> {
  const have = remoteClients.get(id);
  if (have) return have;
  const bridge = await remotesApi.bridge(id);
  // Another call may have made it meanwhile.
  const raced = remoteClients.get(id);
  if (raced) return raced;
  const client = new RemoteRpcClient(id, bridge.port, bridge.token);
  remoteClients.set(id, client);
  untrack.set(id, trackSessions(id, client));
  // It reconnects on its own after a failure; the shell says why it failed.
  client.connect().catch(() => {});
  return client;
}

function dropRemoteClient(id: string) {
  untrack.get(id)?.();
  untrack.delete(id);
  remoteClients.get(id)?.close();
  remoteClients.delete(id);
}

/** A fresh connection to remote `id` now (paired again, or "Retry now"), keeping it shown if it is. */
export async function reconnect(id: string): Promise<void> {
  await remotesApi.retry(id).catch(() => {});
  dropRemoteClient(id);
  const client = await ensureRemoteClient(id);
  if (useStore.getState().computer === id) {
    useStore.setState({ client, connection: client.state });
    void follow(client);
  }
}

// ---- following the shown computer -----------------------------------------

let syncOptions: SyncOptions = { initialSession: null, selectFirst: true };
let following: { client: RpcClient; stop: Sync } | null = null;

/** How the shown computer is followed (state/daemonSync.ts); set once by the app. */
export function configureSync(opts: SyncOptions) {
  syncOptions = opts;
}

/** Follow `client` as the shown computer's: stops following the one before. */
export function follow(client: RpcClient): Promise<void> {
  following?.stop();
  const stop = syncWithDaemon(client, syncOptions);
  following = { client, stop };
  return stop.loaded;
}

/** Stop following `client`, if it is the one followed. */
export function unfollow(client: RpcClient) {
  if (following?.client !== client) return;
  following.stop();
  following = null;
}

// ---- switching -------------------------------------------------------------

/** What each computer's view is made of; kept per computer while another is shown. */
const VIEW_FIELDS = [
  "sessions",
  "sessionOrder",
  "tabs",
  "activeTab",
  "recentTabs",
  "closedTabs",
  "selectedId",
  "modView",
  "sidebarCursor",
  "cursorItemId",
  "expandedOrchestras",
  "collapsedSubOrchestras",
  "workspaces",
  "activeWorkspace",
  "lastSelectedByWorkspace",
  "providers",
  "sidebarFilter",
  "daemonVersion",
] as const satisfies readonly (keyof AppState)[];

type View = Pick<AppState, (typeof VIEW_FIELDS)[number]>;

const views = new Map<string, View>();

function blankView(): View {
  return {
    sessions: {},
    sessionOrder: [],
    tabs: [],
    activeTab: null,
    recentTabs: [],
    closedTabs: [],
    selectedId: null,
    modView: null,
    sidebarCursor: null,
    cursorItemId: null,
    expandedOrchestras: [],
    collapsedSubOrchestras: [],
    workspaces: [],
    activeWorkspace: null,
    lastSelectedByWorkspace: {},
    providers: [],
    sidebarFilter: "",
    daemonVersion: null,
  };
}

function viewOf(st: AppState): View {
  const v = {} as Record<string, unknown>;
  for (const k of VIEW_FIELDS) v[k] = st[k];
  return v as View;
}

/**
 * Show computer `id`: its sessions, transcripts and dialogs from now on.
 * Resolves once its sessions are loaded (or the attempt to load them failed;
 * its client keeps reconnecting).
 */
export async function switchComputer(id: string): Promise<void> {
  const st = useStore.getState();
  if (st.computer === id) return;
  let client: RpcClient | null;
  if (id === LOCAL) client = selectLocalClient(st);
  else {
    if (!useComputers.getState().remotes.some((r) => r.id === id)) throw new Error("That remote computer is not paired");
    client = await ensureRemoteClient(id);
  }
  if (following) {
    following.stop();
    following = null;
  }
  views.set(st.computer, viewOf(useStore.getState()));
  const view = views.get(id) ?? blankView();
  setPersistLocal(id === LOCAL);
  // Transcripts load again on demand: what the hidden computer did meanwhile is not in them.
  useStore.setState({ ...view, transcripts: {}, computer: id, client, connection: client?.state ?? "closed", connectionError: null, paletteOpen: false, whichKey: null });
  if (client) await follow(client);
}

/** Show the computer `delta` places on in the switcher's order (this computer, then the remotes), wrapping. */
export function cycleComputer(delta: number): Promise<void> {
  const ids = [LOCAL, ...useComputers.getState().remotes.map((r) => r.id)];
  const i = ids.indexOf(useStore.getState().computer);
  return switchComputer(ids[(i + delta + ids.length) % ids.length]);
}

// ---- the shell's list ------------------------------------------------------

/** Follow the shell's paired computers and connect to each. Main window only; returns what stops it. */
export async function startComputers(): Promise<() => void> {
  const apply = (list: RemoteComputer[]) => {
    const before = useComputers.getState().remotes;
    useComputers.setState({ remotes: list, loaded: true });
    for (const r of list) {
      const was = before.find((b) => b.id === r.id);
      // Paired again (or the user retried): connect afresh rather than wait out the client's backoff.
      if (was && needsPairing(was.state) && !needsPairing(r.state)) void reconnect(r.id);
      else void ensureRemoteClient(r.id).catch((e: unknown) => console.warn(`Could not open the bridge to ${r.name}:`, e));
    }
    for (const b of before) {
      if (list.some((r) => r.id === b.id)) continue;
      // Removed: back to this computer first if it was shown.
      const shown = useStore.getState().computer === b.id;
      const done = shown ? switchComputer(LOCAL) : Promise.resolve();
      void done.finally(() => {
        dropRemoteClient(b.id);
        views.delete(b.id);
      });
    }
  };
  const off = await remotesApi.onChange(apply);
  try {
    apply(await remotesApi.list());
  } catch (e) {
    console.warn("Could not list remote computers:", e);
  }
  return () => {
    off();
    for (const id of [...remoteClients.keys()]) dropRemoteClient(id);
  };
}

// ---- the inbox across computers -------------------------------------------

/** What waits on the user on every computer but the one shown (whose count is the store's). */
export function otherComputersPending(shown: string, sessions = useComputers.getState().sessions): number {
  let n = 0;
  for (const [id, list] of Object.entries(sessions)) {
    if (id === shown) continue;
    for (const s of Object.values(list)) n += s.pending_count;
  }
  return n;
}

export function useOtherComputersPending(): number {
  const shown = useStore((s) => s.computer);
  return useComputers((s) => otherComputersPending(shown, s.sessions));
}

/** The approvals and questions waiting on each computer but the one shown, with their sessions. */
export async function pendingElsewhere(shown: string): Promise<{ computer: string; approvals: Approval[]; inputs: UserInputRequest[]; sessions: Record<string, Session> }[]> {
  const all = await Promise.all(
    connectedComputers()
      .filter((c) => c.id !== shown && c.client.state === "open")
      .map(async ({ id, client }) => {
        try {
          const p = await client.pending();
          return { computer: id, ...p, sessions: useComputers.getState().sessions[id] ?? {} };
        } catch {
          return null;
        }
      }),
  );
  return all.filter((x): x is NonNullable<typeof x> => x !== null);
}

/** Tests only: forget every client and view. */
export function resetComputersForTests() {
  for (const id of [...remoteClients.keys()]) dropRemoteClient(id);
  views.clear();
  following = null;
  setPersistLocal(true);
  useComputers.setState({ remotes: [], loaded: false, sessions: {} });
}
