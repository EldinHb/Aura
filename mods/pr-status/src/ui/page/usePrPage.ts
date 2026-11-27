// The PR page's data, kept up to date while its tab is shown: read again when the daemon half's
// pace says (about every 60 s), at once on a GitHub notification for the PR, and when the tab
// or window shows again; nothing while hidden or after the tab closed. Failures back off. The
// files are read when first asked for, per comparison (base and head), while the page shows.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PageFile, PrPage } from "../../shared/page";
import { getCtx } from "../ctx";

/** How often a shown page asks whether GitHub notified about the PR. */
export const NOTIFY_CHECK_MS = 15_000;
/** A notification this much older than the last read may still be news to it (GitHub's clocks). */
const NOTIFY_SKEW_MS = 2 * 60_000;
/** After a failed read: this, doubling per failure, up to MAX_RETRY_MS. */
export const RETRY_BASE_MS = 5_000;
export const MAX_RETRY_MS = 15 * 60_000;

type RpcError = Error & { code?: string; data?: { waitMs?: number | null } };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The wait before trying again after `failures` failed reads; longer while GitHub is blocked or rate-limited. */
export function retryDelay(failures: number, error: RpcError | null): number {
  const backoff = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), MAX_RETRY_MS);
  if (error?.code === "rate_limited") return Math.max(backoff, error.data?.waitMs ?? 60_000);
  if (error?.code === "blocked") return Math.max(backoff, 60_000);
  return backoff;
}

/** Whether the window is shown (not minimised or on another space). */
export function useWindowVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

export function usePrPage(repo: string, number: number, active: boolean) {
  const [page, setPage] = useState<PrPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pageRef = useRef<PrPage | null>(null);
  const running = useRef(false);
  const alive = useRef(true);
  const failures = useRef(0);
  /** After a failure, no read before this (ms); one deadline for scheduled and notified reads. */
  const retryAt = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Read the page; before the retry deadline only when `force`d (the Refresh button). */
  const load = useCallback(async (force = false) => {
    const ctx = getCtx();
    if (!ctx || running.current || !alive.current) return;
    if (!force && Date.now() < retryAt.current) return;
    running.current = true;
    setLoading(true);
    try {
      const next = await ctx.rpc<PrPage>("page.get", { repo, number });
      if (!alive.current) return;
      pageRef.current = next;
      failures.current = 0;
      retryAt.current = 0;
      setPage(next);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      failures.current++;
      retryAt.current = Date.now() + retryDelay(failures.current, e as RpcError);
      setError(message(e));
    } finally {
      running.current = false;
      if (alive.current) setLoading(false);
    }
  }, [repo, number]);

  // Read on show, then on the paced schedule (or the back-off after a failure); stop while hidden.
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const wait = () => {
      if (failures.current > 0) return Math.max(0, retryAt.current - Date.now());
      const p = pageRef.current;
      return p ? Math.max(1_000, Date.parse(p.readAt) + p.nextMs - Date.now()) : 0;
    };
    const schedule = () => {
      clearTimeout(timer);
      if (stopped || document.hidden) return;
      timer = setTimeout(() => void load().then(() => !stopped && schedule()), wait());
    };
    const shown = () => {
      if (document.hidden) return clearTimeout(timer);
      // Shown again: read at once if due (a failure keeps its back-off).
      if (failures.current === 0 && wait() <= 1_000) void load().then(() => !stopped && schedule());
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
    let stopped = false;
    const check = async () => {
      if (!ctx || document.hidden || !pageRef.current) return;
      const at = await ctx.rpc<string | null>("page.notified", { repo, number }).catch(() => null);
      if (stopped || !at || at === handled) return;
      handled = at;
      if (Date.parse(at) <= Date.parse(pageRef.current.readAt) - NOTIFY_SKEW_MS) return;
      // Backing off after a failure: the read scheduled at the deadline covers this notification
      // (and any later one), so it does not read now.
      if (Date.now() >= retryAt.current) void load();
    };
    const timer = setInterval(() => void check(), NOTIFY_CHECK_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, repo, number, load]);

  return { page, error, loading, reload: () => load(true) };
}

/** What a files read is for: one comparison of one PR, and the times it was asked to be read again. */
export const filesKey = (repo: string, number: number, base: string, head: string, version: number) => `${repo}#${number}:${base}...${head}:${version}`;

/** The changed files of the comparison `key`, read while `wanted` (the Files tab shows), again for a new key. */
export function usePrFiles(repo: string, number: number, key: string | null, wanted: boolean) {
  const [read, setRead] = useState<{ key: string; files: PageFile[] } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => {
    const ctx = getCtx();
    if (!wanted || !ctx || key === null || read?.key === key || error?.key === key) return;
    let current = true;
    ctx.rpc<PageFile[]>("page.files", { repo, number })
      .then((files) => current && setRead({ key, files }))
      .catch((e) => current && setError({ key, message: message(e) }));
    return () => {
      current = false;
    };
  }, [repo, number, key, wanted, read?.key, error?.key]);
  // Files of another comparison are not shown for this one.
  return { files: read?.key === key ? read.files : null, error: error?.key === key ? error.message : null };
}
