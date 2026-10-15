import clsx from "clsx";
import type { BranchPull, BranchStatus, Session } from "../gen";
import { isStale, pullStatus, reviewStatus } from "../features/reviews/state";
import { useSessionBranch } from "../state/branchStatus";
import { ExternalLink } from "./ExternalLink";

type Label = { label: string; tone?: "ok" | "err" | "merged" };

/** The checked-out branch, or the short commit of a detached HEAD. */
export function branchName(git: BranchStatus): string | null {
  return git.branch ?? git.head?.slice(0, 7) ?? null;
}

/** Unpushed (↑), unpulled (↓) and uncommitted (±) counts; nothing when all are zero. */
export function GitCounts({ git }: { git: BranchStatus }) {
  return (
    <>
      {git.ahead > 0 && <span className="git-count" title={`${git.ahead} commit${git.ahead === 1 ? "" : "s"} not pushed`}> ↑{git.ahead}</span>}
      {git.behind > 0 && <span className="git-count warn" title={`${git.behind} commit${git.behind === 1 ? "" : "s"} to pull`}> ↓{git.behind}</span>}
      {git.changed > 0 && <span className="git-count" title={`${git.changed} file${git.changed === 1 ? "" : "s"} with uncommitted changes`}> ±{git.changed}</span>}
    </>
  );
}

/** Readable state of a branch's pull request: merged or closed, else draft, checks and review. */
export function branchPullLabels(pull: BranchPull): Label[] {
  if (pull.state === "merged") return [{ label: "merged", tone: "merged" }];
  if (pull.state === "closed") return [{ label: "closed" }];
  return [{ label: "open" }, ...pullStatus(pull)];
}

/** The shortest form, for a sidebar row: merged/closed, or draft plus a checks mark, the review state once someone reviewed, and ↻ for new commits since the latest review. */
function compactLabels(pull: BranchPull): Label[] {
  if (pull.state !== "open") return branchPullLabels(pull);
  const checks = ({ SUCCESS: { label: "✓", tone: "ok" }, FAILURE: { label: "✗", tone: "err" }, ERROR: { label: "✗", tone: "err" }, PENDING: { label: "…" }, EXPECTED: { label: "…" } } as const)[pull.checks as "SUCCESS"];
  const review = reviewStatus(pull);
  return [...(pull.draft ? [{ label: "draft" }] : []), ...(checks ? [checks] : []), ...(review && review.label !== "review required" ? [review] : []),
    ...(changedSinceReview(pull) ? [{ label: "↻" }] : [])];
}

/** New commits arrived since the latest review by a person. */
function changedSinceReview(pull: BranchPull) {
  const latest = pull.reviews.filter((r) => !r.bot).sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))[0];
  return !!latest && isStale(latest, pull.head_sha);
}

/** The tooltip of a branch's pull request: number, state and title. */
export const describeBranchPull = (pull: BranchPull) => `${pull.repo}#${pull.number} · ${branchPullLabels(pull).map((l) => l.label).join(" · ")}${pull.state === "open" && changedSinceReview(pull) ? " · new commits since the latest review" : ""}\n${pull.title}`;

/** The branch's pull request in a sidebar row. */
export function BranchPullChip({ pull }: { pull: BranchPull }) {
  return (
    <span className="session-row-link branch-pull" title={describeBranchPull(pull)}>
      PR #{pull.number}
      {compactLabels(pull).map((l) => <span key={l.label} className={clsx("pull-label", l.tone)}> {l.label}</span>)}
    </span>
  );
}

/** Branch and pull request of the selected session, for the status bar. */
export function StatusBarBranch({ session }: { session: Session }) {
  const { git, pull } = useSessionBranch(session, true);
  const name = git && branchName(git);
  if (!name) return null;
  return (
    <span className="statusbar-branch">
      <span title={git.upstream ? `tracking ${git.upstream}` : "not pushed"}>⎇ {name}</span>
      <GitCounts git={git} />
      {pull && (
        <ExternalLink href={pull.url} className="statusbar-pull" title={describeBranchPull(pull)}>
          PR #{pull.number}
          {branchPullLabels(pull).map((l) => <span key={l.label} className={clsx("pull-label", l.tone)}> · {l.label}</span>)}
        </ExternalLink>
      )}
    </span>
  );
}
