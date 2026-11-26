/**
 * The git branch of each session folder and the pull request opened from it
 * (the PR half of the former state/branchStatus.ts). Git comes from core
 * (`git.branch_status`), or from the status core hands a branch decoration;
 * the pull request comes from GitHub and is read again when the branch moves
 * or its copy gets old.
 */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { BranchStatus, Session } from "@aura/mod-sdk";
import type { BranchPull } from "@aura/github-client";
import { useStore } from "@aura/host";
import { coreCall, rpc } from "./ctx";
import { folderOf, useGithubRepo } from "./repos";

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

/** A branch status from core, as a decoration got it: kept so rows need not read it again. */
export function seedGit(cwd: string, status: BranchStatus | null) {
  const read = gitReads.get(cwd) ?? { last: 0, running: false };
  read.last = Date.now();
  gitReads.set(cwd, read);
  if (useBranches.getState().git[cwd] !== status) useBranches.setState((state) => ({ git: { ...state.git, [cwd]: status } }));
}

/** Read the folder's branch state now, or once the last read is GIT_MIN_GAP old. */
export function refreshGit(cwd: string) {
  const read = gitReads.get(cwd) ?? { last: 0, running: false };
  gitReads.set(cwd, read);
  if (read.timer) return;
  const wait = read.running ? GIT_MIN_GAP : read.last + GIT_MIN_GAP - Date.now();
  if (wait > 0) {
    read.timer = setTimeout(() => {
      read.timer = undefined;
      refreshGit(cwd);
    }, wait);
    return;
  }
  read.last = Date.now();
  read.running = true;
  void coreCall<BranchStatus | null>("git.branch_status", { cwd })
    .then((status) => useBranches.setState((state) => ({ git: { ...state.git, [cwd]: status ?? null } })))
    .catch((error: unknown) => console.warn(`Could not read the git branch of ${cwd}:`, error))
    .finally(() => {
      read.running = false;
    });
}

export const pullKey = (target: PullTarget) => `${target.repo}\n${target.headRepo}\n${target.branch}`.toLowerCase();

/** A PR as a daemon may send it: one from before reviews were read has none. */
function normalize(pull: BranchPull | null): BranchPull | null {
  return pull ? { ...pull, reviews: pull.reviews ?? [] } : null;
}

/**
 * Read the branch's pull request unless the saved one is younger than `ttl`
 * and was read at the same local `stamp` (head commit and unpushed count, so
 * a commit or push reads it again).
 */
export async function refreshPull(target: PullTarget, ttl: number, stamp: string) {
  const key = pullKey(target);
  const saved = useBranches.getState().pulls[key];
  if (pullReads.has(key) || (saved && saved.stamp === stamp && Date.now() - saved.at < ttl)) return;
  pullReads.add(key);
  const at = Date.now();
  let pull = saved?.pull ?? null;
  try {
    pull = normalize(await rpc<BranchPull | null>("branch_pull", { repo: target.repo, head_repo: target.headRepo, branch: target.branch }));
  } catch (error) {
    // Keep what was shown; the next read is `ttl` away so a missing gh is not asked every render.
    console.warn(`Could not read the pull request of ${target.branch}:`, error);
  } finally {
    pullReads.delete(key);
  }
  useBranches.setState((state) => ({ pulls: { ...state.pulls, [key]: { pull, stamp, at } } }));
}

/** The pull request of `git`'s branch in the folder `cwd`, kept up to date while mounted. */
export function useBranchPull(cwd: string | undefined, git: BranchStatus | null | undefined, selected: boolean): BranchPull | null {
  const open = useStore((state) => state.connection === "open");
  const repo = useGithubRepo(cwd);
  const branch = git?.upstream_branch ?? git?.branch;
  const headRepo = git?.upstream_repo;
  // Without a GitHub upstream the pull request can only come from the repository itself.
  const target = useMemo<PullTarget | null>(() => (repo && branch ? { repo, headRepo: headRepo ?? repo, branch } : null), [repo, branch, headRepo]);
  const key = target && pullKey(target);
  const pull = useBranches((state) => (key ? state.pulls[key]?.pull ?? null : null));
  const stamp = `${git?.head ?? ""}|${git?.ahead ?? 0}`;
  useEffect(() => {
    if (!open || !target) return;
    const ttl = selected ? PULL_TTL.selected : PULL_TTL.other;
    const read = () => void refreshPull(target, ttl, stamp);
    read();
    const timer = setInterval(read, ttl);
    return () => clearInterval(timer);
  }, [open, target, stamp, selected]);
  return pull;
}

/**
 * Branch state and pull request of a session's folder, kept up to date while
 * mounted. `selected` reads them more often. An orchestrator without a folder has neither.
 */
export function useSessionBranch(session: (Pick<Session, "cwd" | "last_activity" | "status"> & { folderless?: boolean }) | null | undefined, selected = false) {
  const open = useStore((state) => state.connection === "open");
  const cwd = session ? folderOf(session) ?? undefined : undefined;
  const git = useBranches((state) => (cwd ? state.git[cwd] : undefined));
  useEffect(() => {
    if (!open || !cwd) return;
    const read = () => refreshGit(cwd);
    read();
    const timer = setInterval(read, selected ? GIT_POLL.selected : GIT_POLL.other);
    // Pushes and commits made outside Aura show up when the window comes back.
    window.addEventListener("focus", read);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, [open, cwd, selected, session?.last_activity, session?.status]);
  const pull = useBranchPull(cwd, git, selected);
  return { git, pull };
}

/** Forget every read and saved state; for tests. */
export function resetBranches() {
  for (const read of gitReads.values()) clearTimeout(read.timer);
  gitReads.clear();
  pullReads.clear();
  useBranches.setState({ git: {}, pulls: {} });
}
