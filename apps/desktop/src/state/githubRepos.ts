/**
 * The GitHub repository each session folder works against, so a request such
 * as "work on #12" can be linked. Resolved once per folder by the daemon.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { RpcClient } from "../lib/rpc";
import { useStore } from "./store";

export const useGithubRepos = create<{ repos: Record<string, string | null> }>(() => ({ repos: {} }));
const pending = new Set<string>();

export async function loadGithubRepo(client: RpcClient, cwd: string) {
  if (cwd in useGithubRepos.getState().repos || pending.has(cwd)) return;
  pending.add(cwd);
  try {
    const repo = await client.gitGithubRepo(cwd);
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
  const client = useStore((state) => state.client);
  const connection = useStore((state) => state.connection);
  useEffect(() => {
    if (client && cwd) void loadGithubRepo(client, cwd);
  }, [client, connection, cwd]);
  return useGithubRepos((state) => (cwd ? state.repos[cwd] ?? undefined : undefined));
}
