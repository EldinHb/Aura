import { useEffect } from "react";
import { create } from "zustand";
import type { RpcClient } from "../lib/rpc";
import { parseSessionLink, type LinkPreferences } from "../views/issueLinks";
import { useStore } from "./store";

type Entry = { preferences: LinkPreferences; error?: string };
export const useLinkPreferencesStore = create<{ entries: Record<string, Entry> }>(() => ({ entries: {} }));
const revisions = new Map<string, number>();
export const linkPreferencesKey = (id: string) => `session.links.v1.${id}`;

function decode(raw: string | null): LinkPreferences {
  if (!raw) return {};
  const value = JSON.parse(raw) as LinkPreferences;
  if (!value || typeof value !== "object") throw new Error("Invalid saved issue and PR selection");
  const preferences: LinkPreferences = {};
  for (const key of ["issue", "pr"] as const) {
    if (value[key] === undefined) continue;
    if (value[key] === null) preferences[key] = null;
    else if (typeof value[key] === "string") {
      const link = parseSessionLink(value[key], key === "issue" ? "Issue" : "PR");
      if (!link) throw new Error("Invalid saved issue or PR URL");
      preferences[key] = link.url;
    } else throw new Error("Invalid saved issue or PR selection");
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
