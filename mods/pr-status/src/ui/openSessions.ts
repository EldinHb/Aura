// The PR cards of every session open in the UI (a main-area tab, or the selected one), kept in
// memory so switching back shows them at once; the daemon half keeps their data too, through a
// background watch per open session. Both go when the session's tab closes or it is deleted.
import { useStore } from "@aura/host";
import type { UiApi } from "@aura/mod-sdk/ui";
import type { SessionView } from "../shared/types";
import { RENEW_MS } from "./usePullStatus";

const views = new Map<string, SessionView>();

/** The cards last shown for a session, if it is still open. */
export const cachedView = (sessionId: string): SessionView | null => views.get(sessionId) ?? null;

export function cacheView(view: SessionView): void {
  if (openIds().has(view.sessionId)) views.set(view.sessionId, view);
}

/** Sessions open in the UI: session tabs (Aura's own store, read through @aura/host) and the selected one. */
export function openIds(): Set<string> {
  const st = useStore.getState();
  const ids = new Set<string>();
  for (const tab of st.tabs ?? []) if (tab.kind === "session") ids.add(tab.sessionId);
  if (st.selectedId) ids.add(st.selectedId);
  return ids;
}

/** Keep a background watch on each open session, and forget a session once it is closed. */
export function keepOpenSessions(ctx: UiApi): () => void {
  const base = crypto.randomUUID();
  let open = new Set<string>();
  const viewer = (id: string) => `${base}:${id}`;
  const watch = (id: string) => void ctx.rpc("watch", { viewer: viewer(id), sessionId: id, background: true }).catch(() => {});
  const sync = () => {
    const now = openIds();
    for (const id of now) if (!open.has(id)) watch(id);
    for (const id of open) {
      if (now.has(id)) continue;
      views.delete(id);
      void ctx.rpc("unwatch", { viewer: viewer(id) }).catch(() => {});
    }
    open = now;
  };
  sync();
  const offStore = useStore.subscribe(sync);
  const renew = setInterval(() => open.forEach(watch), RENEW_MS);
  const offConnection = ctx.onConnection((state) => {
    if (state === "open") open.forEach(watch);
  });
  return () => {
    offStore();
    offConnection();
    clearInterval(renew);
    for (const id of open) void ctx.rpc("unwatch", { viewer: viewer(id) }).catch(() => {});
    open = new Set();
    views.clear();
  };
}
