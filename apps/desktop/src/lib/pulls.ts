/**
 * Pull request data as the UI reads it, whichever daemon sent it. An app update
 * can leave the previous daemon running, whose replies lack the fields added
 * since; a missing list would throw where the UI filters or maps it, and blank
 * the window. Every reply carrying pull requests passes through here.
 */
import type { BranchPull, PreReview, PullRequest, PullTimeline, ReviewInbox, ReviewThread, Session, SubmittedReview, ThreadComment, TimelineItem } from "../gen";

const list = <T>(value: T[] | null | undefined): T[] => (Array.isArray(value) ? value : []);

const review = (r: SubmittedReview): SubmittedReview => ({ ...r, reviewer: r.reviewer ?? "", bot: r.bot ?? false, commit_sha: r.commit_sha ?? "" });

export function normalizePull(pull: PullRequest): PullRequest {
  return {
    ...pull,
    assignees: list(pull.assignees),
    labels: list(pull.labels),
    merge_methods: list(pull.merge_methods),
    my_review: pull.my_review ? review(pull.my_review) : null,
    reviews: list(pull.reviews).map(review),
    requested: list(pull.requested),
    unanswered_threads: pull.unanswered_threads ?? 0,
    milestone_title: pull.milestone_title ?? "",
  };
}

export const normalizeBranchPull = (pull: BranchPull | null): BranchPull | null =>
  pull && { ...pull, reviews: list(pull.reviews).map(review) };

export const normalizePreReview = (r: PreReview): PreReview => ({ ...r, pull: normalizePull(r.pull), log_tail: list(r.log_tail) });

export function normalizeInbox(inbox: ReviewInbox): ReviewInbox {
  return {
    ...inbox,
    pulls: list(inbox.pulls).map(normalizePull),
    mine: list(inbox.mine).map(normalizePull),
    reviewed: list(inbox.reviewed).map(normalizePull),
    reviews: list(inbox.reviews).map(normalizePreReview),
  };
}

/** Sessions carry the pull requests found for their branch; older daemons send none. */
export const normalizeSession = (session: Session): Session => ({ ...session, pulls: list(session.pulls) });

/**
 * A REST comment, review or review comment, as `pulls.get` lists them for apps up to
 * 0.2.10, and as daemons up to 0.2.10 and their cached details hold nothing else.
 */
export type Conversation = { id: number | string; body: string; html_url: string; created_at?: string; submitted_at?: string; state?: string; path?: string; line?: number | null; original_line?: number | null; diff_hunk?: string; in_reply_to_id?: number; pull_request_review_id?: number | null; user: { login: string } | null };
export type ProjectField = { text?: string; number?: number; date?: string; name?: string; title?: string; optionId?: string; iterationId?: string; field?: { id: string; name: string; dataType: string; options?: { id: string; name: string }[]; configuration?: { iterations: { id: string; title: string }[]; completedIterations: { id: string; title: string }[] } } };
export type ProjectItem = { id: string; project: { id: string; title: string; viewerCanUpdate: boolean }; fieldValues: ProjectField[] };
/** A `pulls.get` or `pulls.cached` reply. `timeline` is null from daemons up to 0.2.10. */
export type PullDetail = { pull: PullRequest; timeline: PullTimeline | null; comments: Conversation[]; reviews: Conversation[]; threads: Conversation[]; projects: ProjectItem[]; project_error: string | null };

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

const timelineItem = (i: Partial<TimelineItem>): TimelineItem => ({
  kind: str(i.kind), id: str(i.id), at: str(i.at), actor: str(i.actor), body: str(i.body), url: str(i.url), state: str(i.state),
  review_id: num(i.review_id), subject: str(i.subject), previous: str(i.previous), color: str(i.color), sha: str(i.sha), before: str(i.before),
});
const threadComment = (c: Partial<ThreadComment>): ThreadComment => ({ id: str(c.id), author: str(c.author) || "ghost", at: str(c.at), body: str(c.body), url: str(c.url) });
const reviewThread = (t: Partial<ReviewThread>): ReviewThread => ({
  id: str(t.id), path: str(t.path), line: num(t.line), original_line: num(t.original_line), resolved: t.resolved === true, outdated: t.outdated === true,
  resolved_by: str(t.resolved_by), diff_hunk: str(t.diff_hunk), review_id: num(t.review_id), comments: list(t.comments).map(threadComment), more: num(t.more) ?? 0,
});

export function normalizeTimeline(t: PullTimeline | null | undefined): PullTimeline | null {
  if (!t || typeof t !== "object") return null;
  return { items: list(t.items).map(timelineItem), threads: list(t.threads).map(reviewThread), commits: num(t.commits) ?? 0 };
}

export function normalizeDetail(d: PullDetail): PullDetail {
  return {
    ...d,
    pull: normalizePull(d.pull),
    timeline: normalizeTimeline(d.timeline),
    comments: list(d.comments),
    reviews: list(d.reviews),
    threads: list(d.threads),
    projects: list(d.projects).map((item) => ({ ...item, fieldValues: list(item.fieldValues) })),
    project_error: d.project_error ?? null,
  };
}
