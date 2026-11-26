import type { BranchStatus, Session } from "../gen";
import { useSessionBranch } from "../state/branchStatus";
import { BranchModDecorations } from "../mods/Slots";

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

/** Branch of the selected session for the status bar, with what mods add to it (its pull request, say). */
export function StatusBarBranch({ session }: { session: Session }) {
  const { git, cwd } = useSessionBranch(session, true);
  const name = git && branchName(git);
  if (!name || !cwd) return null;
  return (
    <span className="statusbar-branch">
      <span title={git.upstream ? `tracking ${git.upstream}` : "not pushed"}>⎇ {name}</span>
      <GitCounts git={git} />
      <BranchModDecorations cwd={cwd} status={git} place="statusbar" session={session} />
    </span>
  );
}
