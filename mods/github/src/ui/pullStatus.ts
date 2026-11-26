// Readable state of a pull request (copied from the former features/reviews/state.ts).
import type { BranchPull, SubmittedReview } from "@aura/github-client";

export type Label = { label: string; tone?: "ok" | "err" | "merged" };

/** New commits arrived since `review`. */
export const isStale = (review: Pick<SubmittedReview, "commit_sha">, headSha: string) => !!review.commit_sha && review.commit_sha !== headSha;

/**
 * Where reviews stand: GitHub's decision when it made one, else what other people's latest
 * reviews say. GitHub only decides on approvals and change requests, but a comment-only
 * review counts as reviewed, as it does on GitHub. A bot's review never counts.
 */
export function reviewStatus(pull: { review_decision: string; reviews: Pick<SubmittedReview, "state" | "bot">[] }): { label: string; tone?: "ok" | "err" } | undefined {
  if (pull.review_decision === "APPROVED") return { label: "approved", tone: "ok" };
  if (pull.review_decision === "CHANGES_REQUESTED") return { label: "changes requested", tone: "err" };
  const states = pull.reviews.filter((r) => !r.bot).map((r) => r.state);
  if (states.includes("CHANGES_REQUESTED")) return { label: "changes requested", tone: "err" };
  // Without a decision nothing more is needed; with one, the approvals do not suffice yet.
  if (states.includes("APPROVED")) return pull.review_decision ? { label: "approved, review required" } : { label: "approved", tone: "ok" };
  if (states.includes("COMMENTED")) return { label: "commented" };
  return pull.review_decision === "REVIEW_REQUIRED" ? { label: "review required" } : undefined;
}

/** Draft, check and review state as short labels; `tone` marks the ones that need attention or are done. */
export function pullStatus(pull: Pick<BranchPull, "draft" | "checks" | "review_decision" | "reviews">): { label: string; tone?: "ok" | "err" }[] {
  const checks = ({ SUCCESS: { label: "checks pass", tone: "ok" }, FAILURE: { label: "checks fail", tone: "err" }, ERROR: { label: "checks fail", tone: "err" }, PENDING: { label: "checks running" }, EXPECTED: { label: "checks running" } } as const)[pull.checks as "SUCCESS"];
  const review = reviewStatus(pull);
  return [...(pull.draft ? [{ label: "draft" }] : []), checks ?? { label: "no checks" }, ...(review ? [review] : [])];
}

/** Readable state of a branch's pull request: merged or closed, else draft, checks and review. */
export function branchPullLabels(pull: BranchPull): Label[] {
  if (pull.state === "merged") return [{ label: "merged", tone: "merged" }];
  if (pull.state === "closed") return [{ label: "closed" }];
  return [{ label: "open" }, ...pullStatus(pull)];
}

/** New commits arrived since the latest review by a person. */
export function changedSinceReview(pull: BranchPull) {
  const latest = pull.reviews.filter((r) => !r.bot).sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))[0];
  return !!latest && isStale(latest, pull.head_sha);
}

/** The shortest form, for a sidebar row: merged/closed, or draft plus a checks mark, the review state once someone reviewed, and ↻ for new commits since the latest review. */
export function compactLabels(pull: BranchPull): Label[] {
  if (pull.state !== "open") return branchPullLabels(pull);
  const checks = ({ SUCCESS: { label: "✓", tone: "ok" }, FAILURE: { label: "✗", tone: "err" }, ERROR: { label: "✗", tone: "err" }, PENDING: { label: "…" }, EXPECTED: { label: "…" } } as const)[pull.checks as "SUCCESS"];
  const review = reviewStatus(pull);
  return [...(pull.draft ? [{ label: "draft" }] : []), ...(checks ? [checks] : []), ...(review && review.label !== "review required" ? [review] : []),
    ...(changedSinceReview(pull) ? [{ label: "↻" }] : [])];
}

/** The tooltip of a branch's pull request: number, state and title. */
export const describeBranchPull = (pull: BranchPull) => `${pull.repo}#${pull.number} · ${branchPullLabels(pull).map((l) => l.label).join(" · ")}${pull.state === "open" && changedSinceReview(pull) ? " · new commits since the latest review" : ""}\n${pull.title}`;
