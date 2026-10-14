import { useEffect } from "react";
import { create } from "zustand";
import type { RpcClient } from "../lib/rpc";
import { parseSessionLink, sessionLinks, type LinkPreferences, type SessionLink } from "../views/issueLinks";
import { useStore } from "./store";
import { loadGithubRepo, useGithubRepos } from "./githubRepos";

type Entry = { preferences: LinkPreferences; error?: string };
export const useLinkPreferencesStore = create<{ entries: Record<string, Entry> }>(() => ({ entries: {} }));
const revisions = new Map<string, number>();
export const linkPreferencesKey = (id: string) => `session.links.v1.${id}`;

/** Reads the current form and the older one, which held one issue and one PR (null for none). */
function decode(raw: string | null): LinkPreferences {
  if (!raw) return {};
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved issue and PR selection");
  const preferences: LinkPreferences = {};
  for (const [key, old, kind] of [["issues", "issue", "Issue"], ["prs", "pr", "PR"]] as const) {
    const list = value[key] ?? (value[old] === undefined ? undefined : value[old] === null ? [] : [value[old]]);
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error("Invalid saved issue or PR selection");
    const urls: string[] = [];
    for (const url of list) {
      const link = typeof url === "string" ? parseSessionLink(url, kind) : undefined;
      if (!link) throw new Error("Invalid saved issue or PR URL");
      if (!urls.some((other) => other.toLowerCase() === link.url.toLowerCase())) urls.push(link.url);
    }
    preferences[key] = urls;
  }
  if (value.reviews !== undefined) {
    if (typeof value.reviews !== "boolean") throw new Error("Invalid saved review follow-up setting");
    if (!value.reviews) preferences.reviews = false;
  }
  return preferences;
}

function update(id: string, entry: Entry) {
  useLinkPreferencesStore.setState((state) => ({ entries: { ...state.entries, [id]: entry } }));
}

export async function loadLinkPreferences(client: RpcClient, id: string) {
  const revision = (revisions.get(id) ?? 0) + 1;
  revisions.set(id, revision);
  try {
    const preferences = decode(await client.getSetting(linkPreferencesKey(id)));
    if (revisions.get(id) === revision) update(id, { preferences });
  } catch (error) {
    if (revisions.get(id) === revision) update(id, {
      preferences: useLinkPreferencesStore.getState().entries[id]?.preferences ?? {},
      error: String(error),
    });
  }
}

export async function saveLinkPreferences(client: RpcClient, id: string, preferences: LinkPreferences) {
  const validated = decode(JSON.stringify(preferences));
  // Invalidate any read that started before this save.
  revisions.set(id, (revisions.get(id) ?? 0) + 1);
  if (!await client.setSetting(linkPreferencesKey(id), JSON.stringify(validated))) throw new Error("The daemon did not save the links");
  revisions.set(id, (revisions.get(id) ?? 0) + 1);
  update(id, { preferences: validated });
}

export function useSessionLinkPreferences(id: string | null) {
  const client = useStore((state) => state.client);
  const connection = useStore((state) => state.connection);
  const entry = useLinkPreferencesStore((state) => id ? state.entries[id] : undefined);
  useEffect(() => {
    if (!id || !client) return;
    const refresh = () => { void loadLinkPreferences(client, id); };
    refresh();
    // Refresh when returning from another Aura window where links were edited.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [id, client, connection]);
  return entry;
}

/**
 * Automatic links need the whole transcript, which loads only when a session
 * is opened. The last detected links are saved so the sidebar can show them
 * for sessions that have not been opened in this window.
 */
export const detectedLinksKey = (id: string) => `session.links.detected.v1.${id}`;
export const useDetectedLinksStore = create<{ links: Record<string, SessionLink[]> }>(() => ({ links: {} }));
const detectedRevisions = new Map<string, number>();

function decodeDetected(raw: string | null): SessionLink[] {
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("Invalid saved detected links");
  return value.flatMap((url) => {
    const link = typeof url === "string" ? parseSessionLink(url, "Issue") ?? parseSessionLink(url, "PR") : undefined;
    if (!link) throw new Error("Invalid saved detected link");
    return [link];
  });
}

const sameLinks = (a: SessionLink[] | undefined, b: SessionLink[]) =>
  !!a && a.length === b.length && a.every((link, i) => link.url === b[i].url);

export async function loadDetectedLinks(client: RpcClient, id: string) {
  const revision = (detectedRevisions.get(id) ?? 0) + 1;
  detectedRevisions.set(id, revision);
  try {
    const links = decodeDetected(await client.getSetting(detectedLinksKey(id)));
    if (detectedRevisions.get(id) === revision) {
      useDetectedLinksStore.setState((state) => ({ links: { ...state.links, [id]: links } }));
    }
  } catch (error) {
    // The cache is only a hint for the sidebar; the Inspector recomputes it.
    console.warn(`Could not load detected links for session ${id}:`, error);
  }
}

export async function saveDetectedLinks(client: RpcClient, id: string, links: SessionLink[]) {
  if (sameLinks(useDetectedLinksStore.getState().links[id], links)) return;
  detectedRevisions.set(id, (detectedRevisions.get(id) ?? 0) + 1);
  useDetectedLinksStore.setState((state) => ({ links: { ...state.links, [id]: links } }));
  try {
    if (!await client.setSetting(detectedLinksKey(id), JSON.stringify(links.map((link) => link.url)))) throw new Error("The daemon did not save the links");
  } catch (error) {
    console.warn(`Could not save detected links for session ${id}:`, error);
  }
}

/** Load saved and detected links for every listed session, and refresh on focus. */
export function useSidebarLinks(ids: string[]) {
  const client = useStore((state) => state.client);
  const connection = useStore((state) => state.connection);
  const key = ids.join("\n");
  useEffect(() => {
    if (!client) return;
    const list = key ? key.split("\n") : [];
    const { entries } = useLinkPreferencesStore.getState();
    const { links } = useDetectedLinksStore.getState();
    for (const id of list) {
      if (!entries[id]) void loadLinkPreferences(client, id);
      if (!links[id]) void loadDetectedLinks(client, id);
    }
    const refresh = () => {
      for (const id of list) {
        void loadLinkPreferences(client, id);
        void loadDetectedLinks(client, id);
      }
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [key, client, connection]);
}

/** Save the automatic links of every fully loaded transcript as it changes. */
export function useDetectedLinksSync() {
  const client = useStore((state) => state.client);
  useEffect(() => {
    if (!client) return;
    const seen = new Map<string, { items: unknown; title: string; repo?: string }>();
    const sync = () => {
      const { transcripts, sessions } = useStore.getState();
      const { repos } = useGithubRepos.getState();
      for (const [id, transcript] of Object.entries(transcripts)) {
        const session = sessions[id];
        // A partial transcript (live events only) can pick the wrong target.
        if (!session || !transcript.loaded) continue;
        if (!(session.cwd in repos)) void loadGithubRepo(client, session.cwd);
        const repo = repos[session.cwd] ?? undefined;
        const last = seen.get(id);
        if (last?.items === transcript.items && last.title === session.title && last.repo === repo) continue;
        seen.set(id, { items: transcript.items, title: session.title, repo });
        void saveDetectedLinks(client, id, sessionLinks(transcript.items, session.title, repo));
      }
    };
    sync();
    const offRepos = useGithubRepos.subscribe(sync);
    const offStore = useStore.subscribe(sync);
    return () => { offRepos(); offStore(); };
  }, [client]);
}
