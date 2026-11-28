/**
 * Keeps the store in step with a connected daemon: events (held while a
 * snapshot loads, see EventGate), the connection state, and a full refresh
 * on every (re)connect. Listeners are registered before the first fetch, so a
 * connection that drops during it is followed, and the reconnect refreshes.
 */
import type { Event, Session, Workspace } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { EventGate } from "./eventGate";
import { isRemoteClient } from "../lib/remoteClient";
import { setFeatures, setRoleSuggestions } from "./features";
import { selectVisibleSessions, useStore } from "./store";

export type SyncOptions = {
  /** The session to show first (`?session=`), if it exists. */
  initialSession: string | null;
  /** Select the first row when nothing is selected (not in a detached session window). */
  selectFirst: boolean;
  /** Each event as it arrives, for desktop notifications. */
  onEvent?: (ev: Event) => void;
};

type SyncClient = Pick<RpcClient, "providers" | "sessions" | "daemonInfo" | "workspaces" | "touchWorkspace" | "features" | "roleSuggestions" | "onEvent" | "onState" | "state">;

/**
 * What stops following a client; `loaded` settles once the first refresh has
 * run (it never rejects: a failure is said, or redone on the reconnect).
 */
export type Sync = (() => void) & { loaded: Promise<void> };

/** Start following `client`; returns what stops it. The first refresh starts at once. */
export function syncWithDaemon(client: SyncClient, opts: SyncOptions): Sync {
  const st = useStore.getState;
  // Once stopped (another computer shown, or a new client), nothing this
  // sync fetched or held may reach the store: it is the previous daemon's.
  let stopped = false;
  const gate = new EventGate<Event>((ev) => {
    if (!stopped) st().applyEvent(ev);
  });
  const offEvent = client.onEvent((ev) => {
    gate.push(ev);
    opts.onEvent?.(ev);
  });
  const refresh = async () => {
    let sessions: Session[] = [];
    let workspaces: Workspace[] = [];
    await gate.during(
      // A daemon from before workspaces has none to list: the sidebar is then not scoped.
      () => Promise.all([client.providers(), client.sessions(), client.daemonInfo(), client.workspaces().catch(() => [])]),
      ([providers, list, info, spaces]) => {
        if (stopped) return;
        sessions = list;
        workspaces = spaces;
        st().setProviders(providers);
        st().setWorkspaces(spaces);
        st().setSessions(list);
        useStore.setState({ daemonVersion: info.version });
      },
    );
    if (stopped) return;
    const active = st().activeWorkspace;
    // `workspace.touch` is for this computer's daemon; a remote refuses it.
    if (workspaces.length && active && !isRemoteClient(client)) client.touchWorkspace(active).catch((error: unknown) => console.warn("Could not tell the daemon the active workspace:", error));
    // A daemon from before feature owners has none to list.
    client.features().then((f) => !stopped && setFeatures(f), () => {});
    client.roleSuggestions().then((r) => !stopped && setRoleSuggestions(r), () => {});
    if (opts.initialSession && sessions.some((s) => s.id === opts.initialSession)) st().select(opts.initialSession);
    else if (!st().selectedId && !st().modView && sessions.length > 0 && opts.selectFirst) {
      const first = selectVisibleSessions(st())[0];
      if (first) st().select(first.id);
    }
  };
  // A refresh that fails because the connection dropped is redone on the reconnect; any other failure is said.
  const run = () =>
    refresh().catch((e: unknown) => {
      if (stopped) return;
      const message = e instanceof Error ? e.message : String(e);
      if (client.state === "open") st().toast(`Could not load sessions: ${message}`, "error");
      else console.warn("Refresh stopped by the connection dropping; the reconnect refreshes:", message);
    });
  const offState = client.onState((s) => {
    st().setConnection(s);
    if (s === "open") void run();
  });
  st().setConnection(client.state);
  const loaded = run();
  const stop = () => {
    stopped = true;
    offEvent();
    offState();
  };
  return Object.assign(stop, { loaded });
}
