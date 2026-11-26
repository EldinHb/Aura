/**
 * The issue and PR links of sessions, as the daemon half keeps them: the links the user
 * chose, the ones last detected in each transcript, and the PRs of each session's branch.
 * (former state/sessionLinkPreferences.ts over core settings, and `Session.pulls`).
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { Session } from "@aura/mod-sdk";
import { useStore } from "@aura/host";
import { rpc } from "./ctx";
import { folderOf, loadGithubRepo, useGithubRepos } from "./repos";
import { decodeDetected, decodePreferences, sessionLinks, type LinkPreferences, type SessionLink, type StoredLinks } from "../shared/links";

type Entry = { preferences: LinkPreferences; error?: string };
export const useLinkPreferencesStore = create<{ entries: Record<string, Entry> }>(() => ({ entries: {} }));
/**
 * Automatic links need the whole transcript, which loads only when a session
 * is opened. The last detected links are saved so the sidebar can show them
 * for sessions that have not been opened in this window.
 */
export const useDetectedLinksStore = create<{ links: Record<string, SessionLink[]> }>(() => ({ links: {} }));
/** PR URLs opened from each session's branch (former `Session.pulls`). */
export const useSessionPullsStore = create<{ pulls: Record<string, string[]> }>(() => ({ pulls: {} }));

const revisions = new Map<string, number>();
const bump = (id: string) => {
  const next = (revisions.get(id) ?? 0) + 1;
  revisions.set(id, next);
  return next;
};

function setEntry(id: string, entry: Entry) {
  useLinkPreferencesStore.setState((state) => ({ entries: { ...state.entries, [id]: entry } }));
}

function setDetected(id: string, links: SessionLink[]) {
  useDetectedLinksStore.setState((state) => ({ links: { ...state.links, [id]: links } }));
}

/** Take what the daemon keeps for a session into the stores. */
export function applyStored(id: string, stored: StoredLinks) {
  try {
    setEntry(id, { preferences: decodePreferences(stored.links) });
  } catch (error) {
    setEntry(id, { preferences: useLinkPreferencesStore.getState().entries[id]?.preferences ?? {}, error: String(error) });
  }
  try {
    setDetected(id, decodeDetected(stored.detected));
  } catch (error) {
    // The cache is only a hint for the sidebar; the Inspector recomputes it.
    console.warn(`Could not load detected links for session ${id}:`, error);
  }
  useSessionPullsStore.setState((state) => ({ pulls: { ...state.pulls, [id]: stored.pulls ?? [] } }));
}

export async function loadLinkPreferences(id: string) {
  const revision = bump(id);
  try {
    const stored = await rpc<StoredLinks>("links.get", { sessionId: id });
    if (revisions.get(id) === revision) applyStored(id, stored);
  } catch (error) {
    if (revisions.get(id) === revision) {
      setEntry(id, { preferences: useLinkPreferencesStore.getState().entries[id]?.preferences ?? {}, error: String(error) });
    }
  }
}

/** A notification from the daemon half: a session's links changed (here or in another window). */
export function linksChanged(payload: StoredLinks & { sessionId: string }) {
  if (!payload || typeof payload.sessionId !== "string") return;
  // Invalidate any read that started before this change.
  bump(payload.sessionId);
  applyStored(payload.sessionId, payload);
}

let allLoaded: Promise<void> | null = null;

/** Every session's links in one call, once per connection (the sidebar's rows). */
export function loadAllLinks(): Promise<void> {
  allLoaded ??= (async () => {
    const started = new Map([...revisions]);
    try {
      const all = await rpc<Record<string, StoredLinks>>("links.all", {});
      for (const [id, stored] of Object.entries(all ?? {})) {
        // A session read or changed meanwhile has newer links than this answer.
        if ((revisions.get(id) ?? 0) === (started.get(id) ?? 0)) applyStored(id, stored);
      }
    } catch (error) {
      allLoaded = null;
      console.warn("Could not load the links of sessions:", error);
    }
  })();
  return allLoaded;
}

/** Read everything again, as after the daemon connection reopened. */
export function reloadLinks() {
  allLoaded = null;
  void loadAllLinks();
  for (const id of Object.keys(useLinkPreferencesStore.getState().entries)) void loadLinkPreferences(id);
}

export async function saveLinkPreferences(id: string, preferences: LinkPreferences) {
  const validated = decodePreferences(JSON.parse(JSON.stringify(preferences)));
  // Invalidate any read that started before this save.
  bump(id);
  await rpc("links.set", { sessionId: id, links: validated });
  bump(id);
  setEntry(id, { preferences: validated });
}

const sameLinks = (a: SessionLink[] | undefined, b: SessionLink[]) =>
  !!a && a.length === b.length && a.every((link, i) => link.url === b[i].url);

export async function saveDetectedLinks(id: string, links: SessionLink[]) {
  if (sameLinks(useDetectedLinksStore.getState().links[id], links)) return;
  setDetected(id, links);
  try {
    await rpc("detected.set", { sessionId: id, urls: links.map((link) => link.url) });
  } catch (error) {
    console.warn(`Could not save detected links for session ${id}:`, error);
  }
}

export function useSessionLinkPreferences(id: string | null) {
  const connection = useStore((state) => state.connection);
  const entry = useLinkPreferencesStore((state) => (id ? state.entries[id] : undefined));
  useEffect(() => {
    if (!id || connection !== "open") return;
    void loadLinkPreferences(id);
  }, [id, connection]);
  return entry;
}

/** Load saved and detected links of every session (rows ask for all of them at once). */
export function useSidebarLinks() {
  const connection = useStore((state) => state.connection);
  useEffect(() => {
    if (connection === "open") void loadAllLinks();
  }, [connection]);
}

/** Save the automatic links of every fully loaded transcript as it changes (former useDetectedLinksSync). */
export function startDetectedLinksSync(): () => void {
  const seen = new Map<string, { items: unknown; title: string; repo?: string }>();
  const sync = () => {
    const { transcripts, sessions } = useStore.getState() as { transcripts: Record<string, { loaded: boolean; items: Record<string, any> }>; sessions: Record<string, Session> };
    const { repos } = useGithubRepos.getState();
    for (const [id, transcript] of Object.entries(transcripts)) {
      const session = sessions[id];
      // A partial transcript (live events only) can pick the wrong target.
      if (!session || !transcript.loaded) continue;
      const folder = folderOf(session);
      if (folder !== null && !(folder in repos)) void loadGithubRepo(folder);
      const repo = folder !== null ? repos[folder] ?? undefined : undefined;
      const last = seen.get(id);
      if (last?.items === transcript.items && last.title === session.title && last.repo === repo) continue;
      seen.set(id, { items: transcript.items, title: session.title, repo });
      void saveDetectedLinks(id, sessionLinks(transcript.items, session.title, repo));
    }
  };
  sync();
  const offRepos = useGithubRepos.subscribe(sync);
  const offStore = useStore.subscribe(sync);
  return () => {
    offRepos();
    offStore();
  };
}

const recorded = new Set<string>();

/** Non-worktree sessions count as working on their folder's branch while active, or this soon after. */
export const RECENT_ACTIVITY = 10 * 60_000;

/**
 * Whether the session worked on the branch now checked out in its folder.
 * A worktree's branch is the session's own. A plain checkout is shared, and
 * the user may switch it under an idle session: that one has not worked on it.
 */
export function workedOnBranch(session: Pick<Session, "worktree" | "status" | "last_activity">, now = Date.now()): boolean {
  if (session.worktree) return true;
  if (session.status === "running" || session.status === "waiting_approval" || session.status === "waiting_input") return true;
  return now - Date.parse(session.last_activity) < RECENT_ACTIVITY;
}

/** Have the daemon remember the PR of the session's branch, once per session and PR (former useRecordBranchPull). */
export function useRecordBranchPull(session: Session | null, pull: { url: string } | null) {
  const url = pull?.url;
  const id = session?.id;
  const known = useSessionPullsStore((state) => !!url && !!id && (state.pulls[id] ?? []).some((other) => other.toLowerCase() === url.toLowerCase()));
  const worked = !!session && workedOnBranch(session);
  useEffect(() => {
    if (!id || !url || known || !worked || !/^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#]|$)/i.test(url)) return;
    const key = `${id}\n${url.toLowerCase()}`;
    if (recorded.has(key)) return;
    recorded.add(key);
    rpc<string[]>("pulls.record", { sessionId: id, url })
      .then((pulls) => useSessionPullsStore.setState((state) => ({ pulls: { ...state.pulls, [id]: pulls } })))
      .catch((error: unknown) => console.warn(`Could not record ${url} on session ${id}:`, error));
  }, [id, url, known, worked]);
}

/** Forget every link, read and recorded PR; for tests. */
export function resetLinks() {
  revisions.clear();
  recorded.clear();
  allLoaded = null;
  useLinkPreferencesStore.setState({ entries: {} });
  useDetectedLinksStore.setState({ links: {} });
  useSessionPullsStore.setState({ pulls: {} });
}
