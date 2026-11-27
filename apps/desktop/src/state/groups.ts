import { useCallback, useEffect, useMemo, useState } from "react";
import type { Group, Session } from "../gen";
import { activeWorkspaceId, useStore } from "./store";

/**
 * Names of the remembered groups plus any group a session is in, sorted; the
 * groups used in `workspace` first. Groups are shared by every workspace.
 */
export function groupNames(groups: Group[], sessions: Record<string, Session>, workspace: string | null = null): string[] {
  const names = new Set(groups.map((g) => g.name));
  const here = new Set<string>();
  for (const s of Object.values(sessions)) {
    if (!s.group) continue;
    names.add(s.group);
    if (workspace && s.workspace === workspace) here.add(s.group);
  }
  return [...names].sort((a, b) => Number(here.has(b)) - Number(here.has(a)) || a.localeCompare(b));
}

/** The daemon's group registry, fetched on mount. `reload` fetches it again. */
export function useGroups(): { groups: Group[]; names: string[]; reload: () => Promise<void> } {
  const client = useStore((s) => s.client);
  const sessions = useStore((s) => s.sessions);
  const workspace = useStore((s) => activeWorkspaceId(s));
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
  const names = useMemo(() => groupNames(groups, sessions, workspace), [groups, sessions, workspace]);
  return { groups, names, reload };
}
