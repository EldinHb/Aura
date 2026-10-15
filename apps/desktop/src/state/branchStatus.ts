/**
 * The git branch of each session folder (ahead, behind, uncommitted changes)
 * and the pull request opened from it, for the sidebar and status bar. Git is
 * read locally by the daemon and often; the pull request comes from GitHub and
 * is read again when the branch moves or its copy gets old.
 */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { BranchPull, BranchStatus, Session } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { useGithubRepo } from "./githubRepos";
import { useStore } from "./store";

/** Where to look for a branch's pull request. */
export type PullTarget = { repo: string; headRepo: string; branch: string };
type PullEntry = { pull: BranchPull | null; stamp: string; at: number };

export const useBranches = create<{ git: Record<string, BranchStatus | null>; pulls: Record<string, PullEntry> }>(() => ({ git: {}, pulls: {} }));

/** Session activity can arrive many times a second; git is read at most this often per folder. */
const GIT_MIN_GAP = 3_000;
export const GIT_POLL = { selected: 10_000, other: 60_000 };
export const PULL_TTL = { selected: 60_000, other: 5 * 60_000 };

const gitReads = new Map<string, { last: number; running: boolean; timer?: ReturnType<typeof setTimeout> }>();
const pullReads = new Set<string>();

/** Read the folder's branch state now, or once the last read is GIT_MIN_GAP old. */
export function refreshGit(client: RpcClient, cwd: string) {
  const read = gitReads.get(cwd) ?? { last: 0, running: false };
  gitReads.set(cwd, read);
  if (read.timer) return;
  const wait = read.running ? GIT_MIN_GAP : read.last + GIT_MIN_GAP - Date.now();
  if (wait > 0) {
    read.timer = setTimeout(() => { read.timer = undefined; refreshGit(client, cwd); }, wait);
    return;
  }
  read.last = Date.now();
  read.running = true;
  void client.gitBranchStatus(cwd)
    .then((status) => useBranches.setState((state) => ({ git: { ...state.git, [cwd]: status } })))
    .catch((error: unknown) => console.warn(`Could not read the git branch of ${cwd}:`, error))
    .finally(() => { read.running = false; });
}

export const pullKey = (target: PullTarget) => `${target.repo}\n${target.headRepo}\n${target.branch}`.toLowerCase();

/**
 * Read the branch's pull request unless the saved one is younger than `ttl`
 * and was read at the same local `stamp` (head commit and unpushed count, so
 * a commit or push reads it again).
 */
export async function refreshPull(client: RpcClient, target: PullTarget, ttl: number, stamp: string) {
  const key = pullKey(target);
  const saved = useBranches.getState().pulls[key];
  if (pullReads.has(key) || (saved && saved.stamp === stamp && Date.now() - saved.at < ttl)) return;
  pullReads.add(key);
  const at = Date.now();
  let pull = saved?.pull ?? null;
  try {
    pull = await client.githubBranchPull(target.repo, target.headRepo, target.branch);
  } catch (error) {
    // Keep what was shown; the next read is `ttl` away so a missing gh is not asked every render.
    console.warn(`Could not read the pull request of ${target.branch}:`, error);
  } finally {
    pullReads.delete(key);
  }
  useBranches.setState((state) => ({ pulls: { ...state.pulls, [key]: { pull, stamp, at } } }));
}

/**
 * Branch state and pull request of a session's folder, kept up to date while
 * mounted. `selected` reads them more often.
 */
export function useSessionBranch(session: Pick<Session, "cwd" | "last_activity" | "status"> | null | undefined, selected = false) {
  const client = useStore((state) => state.client);
  const open = useStore((state) => state.connection === "open");
  const cwd = session?.cwd;
  const repo = useGithubRepo(cwd);
  const git = useBranches((state) => (cwd ? state.git[cwd] : undefined));
  const branch = git?.upstream_branch ?? git?.branch;
  const headRepo = git?.upstream_repo;
  // Without a GitHub upstream the pull request can only come from the repository itself.
  const target = useMemo<PullTarget | null>(() => (repo && branch ? { repo, headRepo: headRepo ?? repo, branch } : null), [repo, branch, headRepo]);
  const key = target && pullKey(target);
  const pull = useBranches((state) => (key ? state.pulls[key]?.pull ?? null : null));
  const stamp = `${git?.head ?? ""}|${git?.ahead ?? 0}`;

  useEffect(() => {
    if (!client || !open || !cwd) return;
    const read = () => refreshGit(client, cwd);
    read();
    const timer = setInterval(read, selected ? GIT_POLL.selected : GIT_POLL.other);
    // Pushes and commits made outside Aura show up when the window comes back.
    window.addEventListener("focus", read);
    return () => { clearInterval(timer); window.removeEventListener("focus", read); };
  }, [client, open, cwd, selected, session?.last_activity, session?.status]);

  useEffect(() => {
    if (!client || !open || !target) return;
    const ttl = selected ? PULL_TTL.selected : PULL_TTL.other;
    const read = () => void refreshPull(client, target, ttl, stamp);
    read();
    const timer = setInterval(read, ttl);
    return () => clearInterval(timer);
  }, [client, open, target, stamp, selected]);

  return { git, pull };
}

/** Forget every read and saved state; for tests. */
export function resetBranches() {
  for (const read of gitReads.values()) clearTimeout(read.timer);
  gitReads.clear();
  pullReads.clear();
  useBranches.setState({ git: {}, pulls: {} });
}
