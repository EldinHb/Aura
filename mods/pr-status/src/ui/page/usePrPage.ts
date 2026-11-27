// The PR page's data, kept up to date while its tab is shown: read again when the daemon half's
// pace says (about every 60 s), at once on a GitHub notification for the PR, and when the tab
// or window shows again; nothing while hidden. The files are read when first asked for.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PageFile, PrPage } from "../../shared/page";
import { getCtx } from "../ctx";

/** How often a shown page asks whether GitHub notified about the PR. */
export const NOTIFY_CHECK_MS = 15_000;
/** A notification this much older than the last read may still be news to it (GitHub's clocks). */
const NOTIFY_SKEW_MS = 2 * 60_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function usePrPage(repo: string, number: number, active: boolean) {
  const [page, setPage] = useState<PrPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pageRef = useRef<PrPage | null>(null);
  const running = useRef(false);

  const load = useCallback(async () => {
    const ctx = getCtx();
    if (!ctx || running.current) return;
    running.current = true;
    setLoading(true);
    try {
      const next = await ctx.rpc<PrPage>("page.get", { repo, number });
      pageRef.current = next;
      setPage(next);
      setError(null);
    } catch (e) {
      setError(message(e));
    } finally {
      running.current = false;
      setLoading(false);
    }
  }, [repo, number]);

  // Read on show, then on the paced schedule; stop while the tab or the window is hidden.
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const stale = () => {
      const p = pageRef.current;
      return !p || Date.now() - Date.parse(p.readAt) >= p.nextMs;
    };
    const schedule = () => {
      clearTimeout(timer);
      if (stopped || document.hidden) return;
      const p = pageRef.current;
      const wait = p ? Math.max(1_000, Date.parse(p.readAt) + p.nextMs - Date.now()) : 1_000;
      timer = setTimeout(() => void load().then(schedule), wait);
    };
    const shown = () => {
      if (document.hidden) return clearTimeout(timer);
      if (stale()) void load().then(schedule);
      else schedule();
    };
    shown();
    document.addEventListener("visibilitychange", shown);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [active, load]);

  // A notification for the PR reads it again at once (each notification once).
  useEffect(() => {
    if (!active) return;
    const ctx = getCtx();
    let handled: string | null = null;
    const check = async () => {
      if (!ctx || document.hidden || !pageRef.current) return;
      const at = await ctx.rpc<string | null>("page.notified", { repo, number }).catch(() => null);
      if (!at || at === handled) return;
      handled = at;
      if (Date.parse(at) > Date.parse(pageRef.current.readAt) - NOTIFY_SKEW_MS) void load();
    };
    const timer = setInterval(() => void check(), NOTIFY_CHECK_MS);
    return () => clearInterval(timer);
  }, [active, repo, number, load]);

  return { page, error, loading, reload: load };
}

/** The changed files, read once `wanted` and again when the head commit moves. */
export function usePrFiles(repo: string, number: number, head: string | undefined, wanted: boolean) {
  const [files, setFiles] = useState<PageFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readFor = useRef<string | null>(null);
  useEffect(() => {
    const ctx = getCtx();
    if (!wanted || !ctx || head === undefined || readFor.current === head) return;
    let current = true;
    ctx.rpc<PageFile[]>("page.files", { repo, number })
      .then((f) => {
        if (!current) return;
        readFor.current = head;
        setFiles(f);
        setError(null);
      })
      .catch((e) => current && setError(message(e)));
    return () => {
      current = false;
    };
  }, [repo, number, head, wanted]);
  return { files, error };
}
