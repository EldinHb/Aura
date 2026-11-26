// The pull request of a session's branch, next to the branch (the PR half of the former
// components/BranchStatus.tsx).
import { useEffect } from "react";
import clsx from "clsx";
import type { BranchStatus } from "@aura/mod-sdk";
import type { BranchDecorationProps } from "@aura/mod-sdk/ui";
import type { BranchPull } from "@aura/github-client";
import { ExternalLink } from "@aura/host";
import { seedGit, useBranchPull } from "./branch";
import { useRecordBranchPull } from "./links";
import { branchPullLabels, compactLabels, describeBranchPull } from "./pullStatus";

/** The branch's pull request in a sidebar row. */
export function BranchPullChip({ pull }: { pull: BranchPull }) {
  return (
    <span className="session-row-link branch-pull" title={describeBranchPull(pull)}>
      PR #{pull.number}
      {compactLabels(pull).map((l) => <span key={l.label} className={clsx("pull-label", l.tone)}> {l.label}</span>)}
    </span>
  );
}

/** The branch's pull request with its state, as a link (status bar and inspector). */
export function BranchPullLink({ pull }: { pull: BranchPull }) {
  return (
    <ExternalLink href={pull.url} className="statusbar-pull" title={describeBranchPull(pull)}>
      PR #{pull.number}
      {branchPullLabels(pull).map((l) => <span key={l.label} className={clsx("pull-label", l.tone)}> · {l.label}</span>)}
    </ExternalLink>
  );
}

/**
 * What core shows next to a branch: its pull request, read for the branch core reports. In a
 * sidebar row the pull request shows with the session's links instead (see RowChips), so there
 * the decoration only keeps core's branch status for them.
 */
export function BranchDecoration({ cwd, status, place, session }: BranchDecorationProps) {
  const git = (status ?? null) as BranchStatus | null;
  useEffect(() => {
    if (cwd) seedGit(cwd, git);
  }, [cwd, git]);
  const pull = useBranchPull(cwd || undefined, git, place !== "row");
  useRecordBranchPull(session, pull);
  if (!pull || place === "row") return null;
  return <BranchPullLink pull={pull} />;
}
