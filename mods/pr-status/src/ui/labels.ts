// Readable text for every state the cards show; colour always comes with one of these.
import type { Blocker, Checks, ChecksState, PrState, Readiness, ReviewState } from "../shared/types";

export const STATE_LABEL: Record<PrState, string> = { draft: "Draft", open: "Open", merged: "Merged", closed: "Closed" };

export const REVIEW_LABEL: Record<ReviewState, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  COMMENTED: "Commented",
  DISMISSED: "Dismissed",
  PENDING: "Pending",
};

export const BLOCKER_LABEL: Record<Blocker, string> = {
  draft: "Draft",
  changes_requested: "Changes requested",
  review_required: "Required reviews missing",
  checks_failing: "Checks failing",
  checks_pending: "Checks pending",
  conflicts: "Merge conflicts",
  behind: "Behind base branch",
  blocked: "Blocked by branch protection",
  unstable: "Checks not passing",
  unknown: "GitHub is still checking mergeability",
};

export const CHECKS_LABEL: Record<ChecksState, string> = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks pending",
  none: "No checks",
};

/** "2 failing · 1 pending · 7 passing", leaving out the zeros; checks not read are "+N more". */
export function checkCounts(c: Checks): string {
  const parts = [
    c.failing ? `${c.failing} failing` : "",
    c.pending ? `${c.pending} pending` : "",
    c.passing ? `${c.passing} passing` : "",
  ].filter(Boolean);
  const more = c.total - c.failing - c.pending - c.passing;
  if (more > 0) parts.push(`+${more} more`);
  return parts.join(" · ");
}

/** Tone of a state, for its colour: ok, err, warn, merged, or none. */
export const reviewTone = (s: ReviewState) => (s === "APPROVED" ? "ok" : s === "CHANGES_REQUESTED" ? "err" : s === "PENDING" ? "warn" : "");
/** Red when something must be fixed, amber when it only waits (reviews, running checks, GitHub). */
export function readinessTone(r: Readiness): string {
  if (r.ready) return "ok";
  return r.reasons.some((x) => x === "changes_requested" || x === "checks_failing" || x === "conflicts") ? "err" : "warn";
}
export const checksTone = (s: ChecksState) => (s === "passing" ? "ok" : s === "failing" ? "err" : s === "pending" ? "warn" : "");

/** "just now", "12s ago", "3m ago", "2h ago", "4d ago". */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(s)) return "";
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}
