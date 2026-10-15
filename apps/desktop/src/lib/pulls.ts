/**
 * Pull request data as the UI reads it, whichever daemon sent it. An app update
 * can leave the previous daemon running, whose replies lack the fields added
 * since; a missing list would throw where the UI filters or maps it, and blank
 * the window. Every reply carrying pull requests passes through here.
 */
import type { BranchPull, PreReview, PullRequest, ReviewInbox, SubmittedReview } from "../gen";

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
