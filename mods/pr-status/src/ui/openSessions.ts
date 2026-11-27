// The PR cards of every session open in the UI (`ctx.sessions.open()`: a main-area tab, or the
// selected one), kept in memory so switching back shows them at once; the daemon half keeps their
// data too, through a background watch per open session. Both go when the session's tab closes
// or it is deleted.
import type { UiApi } from "@aura/mod-sdk/ui";
import type { SessionView } from "../shared/types";
import { getCtx } from "./ctx";
import { RENEW_MS } from "./usePullStatus";

const views = new Map<string, SessionView>();

/** The cards last shown for a session, if it is still open. */
export const cachedView = (sessionId: string): SessionView | null => views.get(sessionId) ?? null;

export function cacheView(view: SessionView): void {
  if (getCtx()?.sessions.open().includes(view.sessionId)) views.set(view.sessionId, view);
}

/** Keep a background watch on each open session, and forget a session once it is closed. */
export function keepOpenSessions(ctx: UiApi): () => void {
  const base = crypto.randomUUID();
  let open = new Set<string>();
  const viewer = (id: string) => `${base}:${id}`;
  const watch = (id: string) => void ctx.rpc("watch", { viewer: viewer(id), sessionId: id, background: true }).catch(() => {});
  const sync = (ids: string[]) => {
    const now = new Set(ids);
    for (const id of now) if (!open.has(id)) watch(id);
    for (const id of open) {
      if (now.has(id)) continue;
      views.delete(id);
      void ctx.rpc("unwatch", { viewer: viewer(id) }).catch(() => {});
    }
    open = now;
  };
  sync(ctx.sessions.open());
  const offOpen = ctx.sessions.onOpenChange(sync);
  const renew = setInterval(() => open.forEach(watch), RENEW_MS);
  const offConnection = ctx.onConnection((state) => {
    if (state === "open") open.forEach(watch);
  });
  return () => {
    offOpen();
    offConnection();
    clearInterval(renew);
    for (const id of open) void ctx.rpc("unwatch", { viewer: viewer(id) }).catch(() => {});
    open = new Set();
    views.clear();
  };
}
