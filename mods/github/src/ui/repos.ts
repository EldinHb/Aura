/**
 * The GitHub repository each session folder works against, so a request such
 * as "work on #12" can be linked. Resolved once per folder by the daemon half
 * (former state/githubRepos.ts over `git.github_repo`).
 */
import { useEffect } from "react";
import { create } from "zustand";
import { useStore } from "@aura/host";
import { rpc } from "./ctx";

export const useGithubRepos = create<{ repos: Record<string, string | null> }>(() => ({ repos: {} }));
const pending = new Set<string>();

export async function loadGithubRepo(cwd: string) {
  if (cwd in useGithubRepos.getState().repos || pending.has(cwd)) return;
  pending.add(cwd);
  try {
    const repo = await rpc<string | null>("repo", { cwd });
    useGithubRepos.setState((state) => ({ repos: { ...state.repos, [cwd]: repo } }));
  } catch (error) {
    // Links by URL still work; only bare numbers such as "#12" stay unlinked.
    console.warn(`Could not find the GitHub repository for ${cwd}:`, error);
  } finally {
    pending.delete(cwd);
  }
}

/** `owner/repo` for a session folder; undefined until known or when there is none. */
export function useGithubRepo(cwd: string | undefined) {
  const connection = useStore((state) => state.connection);
  useEffect(() => {
    if (cwd && connection === "open") void loadGithubRepo(cwd);
  }, [connection, cwd]);
  return useGithubRepos((state) => (cwd ? state.repos[cwd] ?? undefined : undefined));
}

/** The folder a session works in, or null for an orchestrator that belongs to none (former lib/sessionFolder). */
export function folderOf(s: { cwd: string; folderless?: boolean }): string | null {
  return s.folderless ? null : s.cwd;
}

/** Forget every resolved folder; for tests. */
export function resetGithubRepos() {
  pending.clear();
  useGithubRepos.setState({ repos: {} });
}
