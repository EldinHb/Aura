/**
 * A pull request's conversation in the order GitHub's Conversation tab shows it: the
 * description, then comments, reviews with their threads, pushed commits and events by time.
 */
import type { PullRequest, PullTimeline, ReviewThread, TimelineItem } from "../../gen";
import type { Conversation, PullDetail } from "../../lib/pulls";

export type Entry =
  | { kind: "description"; key: string; at: string }
  | { kind: "comment" | "event"; key: string; at: string; item: TimelineItem }
  | { kind: "review"; key: string; at: string; item: TimelineItem; threads: ReviewThread[] }
  /** A thread whose review is not in the timeline. */
  | { kind: "thread"; key: string; at: string; thread: ReviewThread }
  /** Commits pushed one after another, with nothing in between. */
  | { kind: "commits"; key: string; at: string; items: TimelineItem[] };

/** Event kinds the timeline knows how to word; a newer daemon may send others. */
export const EVENT_KINDS = new Set(["force_pushed", "review_requested", "review_request_removed", "labeled", "unlabeled", "assigned", "unassigned", "ready_for_review", "converted_to_draft", "merged", "closed", "reopened", "head_ref_deleted", "head_ref_restored", "renamed", "milestoned", "demilestoned", "referenced", "review_dismissed"]);

const login = (c: Conversation) => c.user?.login ?? "ghost";
const blank: Omit<TimelineItem, "kind" | "id" | "at"> = { actor: "", body: "", url: "", state: "", review_id: null, subject: "", previous: "", color: "", sha: "", before: "" };

/**
 * The timeline from the REST lists of a daemon up to 0.2.10. Review comments become threads
 * by their reply chain. REST does not say whether a thread is resolved, so none are.
 */
export function legacyTimeline(d: Pick<PullDetail, "comments" | "reviews" | "threads">): PullTimeline {
  const roots = new Map<string, Conversation[]>();
  for (const c of d.threads) {
    const root = String(c.in_reply_to_id ?? c.id);
    roots.set(root, [...(roots.get(root) ?? []), c]);
  }
  const threads: ReviewThread[] = [...roots.values()].map((chain) => {
    const sorted = [...chain].sort((a, b) => time(a.created_at) - time(b.created_at));
    const first = chain.find((c) => c.in_reply_to_id == null) ?? sorted[0];
    const line = first.line ?? null;
    return {
      id: String(first.id), path: first.path ?? "", line, original_line: first.original_line ?? null, resolved: false, outdated: line === null,
      resolved_by: "", diff_hunk: first.diff_hunk ?? "", review_id: typeof first.pull_request_review_id === "number" ? first.pull_request_review_id : null, more: 0,
      comments: sorted.map((c) => ({ id: String(c.id), author: login(c), at: c.created_at ?? "", body: c.body ?? "", url: c.html_url ?? "" })),
    };
  });
  const started = new Set(threads.map((t) => t.review_id));
  const items: TimelineItem[] = [
    ...d.comments.map((c) => ({ ...blank, kind: "comment", id: String(c.id), at: c.created_at ?? "", actor: login(c), body: c.body ?? "", url: c.html_url ?? "" })),
    ...d.reviews
      .map((r) => ({ ...blank, kind: "review", id: String(r.id), at: r.submitted_at ?? r.created_at ?? "", actor: login(r), body: r.body ?? "", url: r.html_url ?? "", state: r.state ?? "", review_id: typeof r.id === "number" ? r.id : null }))
      // A reply to a thread is a review of its own on GitHub, which its timeline leaves out.
      .filter((r) => !(r.state === "COMMENTED" && !r.body.trim() && !started.has(r.review_id))),
  ];
  return { items, threads, commits: 0 };
}

/** Milliseconds since the epoch; NaN when missing or invalid. */
const time = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN);

/**
 * Every entry after the description, by time. Threads go under the review that started them;
 * consecutive commits are grouped. Entries without a valid time keep their place after the
 * one before them, and equal times keep their order.
 */
export function buildTimeline(pull: Pick<PullRequest, "created_at">, detail: Pick<PullDetail, "timeline" | "comments" | "reviews" | "threads">): Entry[] {
  const source = detail.timeline ?? legacyTimeline(detail);
  const reviews = new Set(source.items.filter((i) => i.kind === "review" && i.review_id !== null).map((i) => i.review_id));
  const byReview = new Map<number, ReviewThread[]>();
  const orphans: ReviewThread[] = [];
  for (const thread of source.threads) {
    if (!thread.comments.length) continue;
    if (thread.review_id !== null && reviews.has(thread.review_id)) byReview.set(thread.review_id, [...(byReview.get(thread.review_id) ?? []), thread]);
    else orphans.push(thread);
  }
  const firstAt = (t: ReviewThread) => t.comments[0]?.at ?? "";
  const entries: Entry[] = [];
  for (const item of source.items) {
    const key = `${item.kind}:${item.id}`;
    if (item.kind === "comment") entries.push({ kind: "comment", key, at: item.at, item });
    else if (item.kind === "review") {
      const threads = [...(item.review_id !== null ? byReview.get(item.review_id) ?? [] : [])].sort((a, b) => time(firstAt(a)) - time(firstAt(b)) || 0);
      // A review GitHub kept but with nothing to show, such as an emptied pending one, is skipped.
      if (item.state === "COMMENTED" && !item.body.trim() && !threads.length) continue;
      entries.push({ kind: "review", key, at: item.at, item, threads });
    } else if (item.kind === "commit") entries.push({ kind: "commits", key, at: item.at, items: [item] });
    else if (EVENT_KINDS.has(item.kind)) entries.push({ kind: "event", key, at: item.at, item });
  }
  for (const thread of orphans) entries.push({ kind: "thread", key: `thread:${thread.id}`, at: firstAt(thread), thread });

  let last = time(pull.created_at);
  const sorted = entries
    .map((entry, index) => {
      const t = time(entry.at);
      if (!Number.isNaN(t)) last = t;
      return { entry, index, t: Number.isNaN(last) ? -Infinity : last };
    })
    .sort((a, b) => a.t - b.t || a.index - b.index)
    .map((x) => x.entry);

  const grouped: Entry[] = [];
  for (const entry of sorted) {
    const prev = grouped[grouped.length - 1];
    if (entry.kind === "commits" && prev?.kind === "commits") grouped[grouped.length - 1] = { ...prev, items: [...prev.items, ...entry.items] };
    else grouped.push(entry);
  }
  return [{ kind: "description", key: "description", at: pull.created_at }, ...grouped];
}

/** The number of commits GitHub counted, else those in the timeline; null when unknown. */
export function commitCount(detail: Pick<PullDetail, "timeline"> | null): number | null {
  if (!detail?.timeline) return null;
  return detail.timeline.commits || detail.timeline.items.filter((i) => i.kind === "commit").length || null;
}
