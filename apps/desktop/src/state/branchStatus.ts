/**
 * The git branch of each session folder (ahead, behind, uncommitted changes),
 * for the sidebar and status bar. Git is read locally by the daemon and often.
 * Anything else about a branch (its pull request, say) is a mod's, shown
 * through the branch decoration slot.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { BranchStatus, Session } from "../gen";
import type { RpcClient } from "../lib/rpc";
import { folderOf } from "../lib/sessionFolder";
import { useStore } from "./store";

export const useBranches = create<{ git: Record<string, BranchStatus | null> }>(() => ({ git: {} }));

/** Session activity can arrive many times a second; git is read at most this often per folder. */
const GIT_MIN_GAP = 3_000;
export const GIT_POLL = { selected: 10_000, other: 60_000 };

const gitReads = new Map<string, { last: number; running: boolean; timer?: ReturnType<typeof setTimeout> }>();

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

/**
 * Branch state of a session's folder, kept up to date while mounted.
 * `selected` reads it more often. An orchestrator without a folder has none.
 */
export function useSessionBranch(session: (Pick<Session, "cwd" | "last_activity" | "status"> & { folderless?: boolean }) | null | undefined, selected = false) {
  const client = useStore((state) => state.client);
  const open = useStore((state) => state.connection === "open");
  const cwd = session ? folderOf(session) ?? undefined : undefined;
  const git = useBranches((state) => (cwd ? state.git[cwd] : undefined));

  useEffect(() => {
    if (!client || !open || !cwd) return;
    const read = () => refreshGit(client, cwd);
    read();
    const timer = setInterval(read, selected ? GIT_POLL.selected : GIT_POLL.other);
    // Pushes and commits made outside Aura show up when the window comes back.
    window.addEventListener("focus", read);
    return () => { clearInterval(timer); window.removeEventListener("focus", read); };
  }, [client, open, cwd, selected, session?.last_activity, session?.status]);

  return { git, cwd };
}

/** Forget every read and saved state; for tests. */
export function resetBranches() {
  for (const read of gitReads.values()) clearTimeout(read.timer);
  gitReads.clear();
  useBranches.setState({ git: {} });
}
