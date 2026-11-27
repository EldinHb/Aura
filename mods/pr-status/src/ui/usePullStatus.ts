// The PRs of a session tree, kept up to date while shown: the hook watches the session in
// the daemon half (which polls), renews the watch, and lets go when unmounted or hidden.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionView } from "../shared/types";
import { getCtx } from "./ctx";
import { cacheView, cachedView } from "./openSessions";

/** The daemon half drops a watch not renewed within 90 s. */
export const RENEW_MS = 30_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function usePullStatus(sessionId: string) {
  // A session open in a tab shows its cards at once, as last read, and refreshes them below.
  const [view, setView] = useState<SessionView | null>(() => cachedView(sessionId));
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const shown = useRef(sessionId);
  shown.current = sessionId;

  useEffect(() => {
    const ctx = getCtx();
    if (!ctx) return;
    const viewer = crypto.randomUUID();
    let active = true;
    setView(cachedView(sessionId));
    setError(null);
    const take = (v: SessionView) => {
      if (!active || v.sessionId !== sessionId) return;
      cacheView(v);
      setView(v);
      setError(null);
    };
    const fail = (e: unknown) => active && setError(message(e));
    const watch = (refresh: boolean) => {
      if (document.hidden) return;
      ctx.rpc<SessionView>("watch", { viewer, sessionId, refresh }).then(take, fail);
    };
    const unwatch = () => void ctx.rpc("unwatch", { viewer }).catch(() => {});
    watch(true);
    const renew = setInterval(() => watch(false), RENEW_MS);
    // Nobody looks at a hidden window: stop its polling, and catch up when it shows again.
    const visibility = () => (document.hidden ? unwatch() : watch(true));
    document.addEventListener("visibilitychange", visibility);
    const offs = [
      ctx.on("changed", (p: { sessionIds?: string[] }) => {
        if (p?.sessionIds?.includes(sessionId)) ctx.rpc<SessionView>("view", { sessionId }).then(take, fail);
      }),
      ctx.onConnection((state) => {
        if (state === "open") watch(true);
      }),
    ];
    return () => {
      active = false;
      clearInterval(renew);
      document.removeEventListener("visibilitychange", visibility);
      offs.forEach((off) => off());
      unwatch();
    };
  }, [sessionId]);

  const refresh = useCallback(async () => {
    const ctx = getCtx();
    if (!ctx) return;
    setRefreshing(true);
    try {
      const v = await ctx.rpc<SessionView>("refresh", { sessionId });
      cacheView(v);
      if (shown.current !== sessionId) return;
      setView(v);
      setError(null);
    } catch (e) {
      if (shown.current === sessionId) setError(message(e));
    } finally {
      setRefreshing(false);
    }
  }, [sessionId]);

  return { view, error, refreshing, refresh };
}

/** The current time, ticking every `everyMs` while mounted (for "updated 12s ago"). */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
