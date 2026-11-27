/**
 * Keeps the store in step with a connected daemon: events (held while a
 * snapshot loads, see EventGate), the connection state, and a full refresh
 * on every (re)connect. Listeners are registered before the first fetch, so a
 * connection that drops during it is followed, and the reconnect refreshes.
 */
import type { Event, Session, Workspace } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { EventGate } from "./eventGate";
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

/** Start following `client`; returns what stops it. The first refresh starts at once. */
export function syncWithDaemon(client: SyncClient, opts: SyncOptions): () => void {
  const st = useStore.getState;
  const gate = new EventGate<Event>((ev) => st().applyEvent(ev));
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
        sessions = list;
        workspaces = spaces;
        st().setProviders(providers);
        st().setWorkspaces(spaces);
        st().setSessions(list);
        useStore.setState({ daemonVersion: info.version });
      },
    );
    const active = st().activeWorkspace;
    if (workspaces.length && active) client.touchWorkspace(active).catch((error: unknown) => console.warn("Could not tell the daemon the active workspace:", error));
    // A daemon from before feature owners has none to list.
    client.features().then(setFeatures, () => {});
    client.roleSuggestions().then(setRoleSuggestions, () => {});
    if (opts.initialSession && sessions.some((s) => s.id === opts.initialSession)) st().select(opts.initialSession);
    else if (!st().selectedId && !st().modView && sessions.length > 0 && opts.selectFirst) {
      const first = selectVisibleSessions(st())[0];
      if (first) st().select(first.id);
    }
  };
  // A refresh that fails because the connection dropped is redone on the reconnect; any other failure is said.
  const run = () =>
    refresh().catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      if (client.state === "open") st().toast(`Could not load sessions: ${message}`, "error");
      else console.warn("Refresh stopped by the connection dropping; the reconnect refreshes:", message);
    });
  const offState = client.onState((s) => {
    st().setConnection(s);
    if (s === "open") void run();
  });
  st().setConnection(client.state);
  void run();
  return () => {
    offEvent();
    offState();
  };
}
