// Which cards come first, and how old the data on screen is.
import type { PrEntry } from "../shared/types";

const isDone = (e: PrEntry) => e.status?.state === "merged" || e.status?.state === "closed";

/** Open work first (not ready, then ready, then drafts; still loading with the not ready), merged and closed apart. */
export function splitPulls(pulls: PrEntry[]): { active: PrEntry[]; done: PrEntry[] } {
  const rank = (e: PrEntry) => (e.status?.state === "draft" ? 2 : e.status?.readiness?.ready ? 1 : 0);
  const active = pulls.filter((e) => !isDone(e)).map((e, i) => ({ e, i }));
  active.sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i);
  return { active: active.map((x) => x.e), done: pulls.filter(isDone) };
}

/**
 * When the data on screen was read: the oldest read of the PRs still polled (open and draft),
 * as that is how stale the live part can be. Merged and closed PRs are rarely read again, so
 * they count only when nothing else is listed (then the newest of them).
 */
export function updatedAt(pulls: PrEntry[]): string | null {
  const reads = (list: PrEntry[]) => list.flatMap((e) => (e.readAt ? [e.readAt] : [])).sort();
  const live = reads(pulls.filter((e) => !isDone(e)));
  if (live.length) return live[0];
  return reads(pulls).at(-1) ?? null;
}
