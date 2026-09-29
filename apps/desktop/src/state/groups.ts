import { useCallback, useEffect, useMemo, useState } from "react";
import type { Group, Session } from "../gen";
import { useStore } from "./store";

/** Names of the remembered groups plus any group a session is in, sorted. */
export function groupNames(groups: Group[], sessions: Record<string, Session>): string[] {
  const names = new Set(groups.map((g) => g.name));
  for (const s of Object.values(sessions)) if (s.group) names.add(s.group);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** The daemon's group registry, fetched on mount. `reload` fetches it again. */
export function useGroups(): { groups: Group[]; names: string[]; reload: () => Promise<void> } {
  const client = useStore((s) => s.client);
  const sessions = useStore((s) => s.sessions);
  const toast = useStore((s) => s.toast);
  const [groups, setGroups] = useState<Group[]>([]);
  const reload = useCallback(async () => {
    if (!client) return;
    try {
      setGroups(await client.groups());
    } catch (e) {
      toast(`Could not load groups: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [client, toast]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const names = useMemo(() => groupNames(groups, sessions), [groups, sessions]);
  return { groups, names, reload };
}
