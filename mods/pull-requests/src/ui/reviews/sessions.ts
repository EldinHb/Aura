/**
 * The sessions that worked on a pull request, for the PR page and the PR list. Which ones
 * did is the github mod's to say (`pulls.sessions`: the sessions that link the PR, or whose
 * branch is or was its head; formerly core's `Session.pulls` and link preferences).
 * Orchestrators show with the workers that did the work under them.
 */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { InspectorSectionProps } from "@aura/mod-sdk/ui";
import type { PullRequest } from "@aura/github-client";
import { ctx } from "../ctx";
import { useStore } from "../host";

export type Session = InspectorSectionProps["session"];

/** A listed session; `direct` is false for an orchestrator listed only for its workers. */
export type PullSession = { session: Session; direct: boolean; workers: PullSession[] };
export type PullRef = Pick<PullRequest, "url">;

/** Session ids per PR URL, as the github mod last said, and the session count they were read at. */
export const usePullSessionIds = create<{ ids: Record<string, string[]>; read: Record<string, number> }>(() => ({ ids: {}, read: {} }));
const inflight = new Set<string>();

/** Ask the github mod which sessions worked on `url`, unless it was asked for this many sessions. */
export function loadPullSessions(url: string, sessionCount: number, force = false) {
  const key = url.toLowerCase();
  if (!url || inflight.has(key) || (!force && usePullSessionIds.getState().read[key] === sessionCount)) return;
  inflight.add(key);
  usePullSessionIds.setState((s) => ({ read: { ...s.read, [key]: sessionCount } }));
  let reply: Promise<unknown>;
  try { reply = ctx().call<unknown>("github", "pulls.sessions", { url }); } catch (e) { reply = Promise.reject(e); }
  void reply
    .then((ids) => usePullSessionIds.setState((s) => ({ ids: { ...s.ids, [key]: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [] } })))
    // Without the github mod no session is known to have worked on it.
    .catch(() => {})
    .finally(() => inflight.delete(key));
}

/** Sessions still in use first, then the most recently active. */
const byActivity = (a: PullSession, b: PullSession) =>
  Number(a.session.archived) - Number(b.session.archived) || b.session.last_activity.localeCompare(a.session.last_activity);

/** The sessions `ids` names, workers grouped under their orchestrator. */
export function sessionsOfPull(ids: string[], sessions: Record<string, Session>): PullSession[] {
  const entries = new Map<string, PullSession>();
  for (const id of ids) {
    const session = sessions[id];
    if (session) entries.set(id, { session, direct: true, workers: [] });
  }
  // Orchestrators are set when a worker starts, so they cannot loop; a damaged store is still no reason to hang.
  const loops = (session: Session) => {
    const seen = new Set([session.id]);
    for (let id = session.orchestrator_id; id; id = sessions[id]?.orchestrator_id ?? null) {
      if (seen.has(id)) return true;
      seen.add(id);
    }
    return false;
  };
  const top: PullSession[] = [];
  const placed = new Set<string>();
  // A worker can orchestrate workers of its own; each goes under its orchestrator, up to the top one.
  const place = (entry: PullSession) => {
    if (placed.has(entry.session.id)) return;
    placed.add(entry.session.id);
    const orchestrator = entry.session.orchestrator_id ? sessions[entry.session.orchestrator_id] : undefined;
    if (!orchestrator || loops(entry.session)) { top.push(entry); return; }
    let parent = entries.get(orchestrator.id);
    if (!parent) {
      parent = { session: orchestrator, direct: false, workers: [] };
      entries.set(orchestrator.id, parent);
    }
    place(parent);
    parent.workers.push(entry);
  };
  for (const entry of [...entries.values()]) place(entry);
  const sort = (list: PullSession[]): PullSession[] => {
    for (const entry of list) sort(entry.workers);
    return list.sort(byActivity);
  };
  return sort(top);
}

/** Every session in the list, workers included, in the order shown. */
export const flattenPullSessions = (entries: PullSession[]): PullSession[] =>
  entries.flatMap((entry) => [entry, ...flattenPullSessions(entry.workers)]);

/** The sessions that worked on `pull`, read again when sessions come or go. */
export function usePullSessions(pull: PullRef): PullSession[] {
  const sessions = useStore((s) => s.sessions);
  const connection = useStore((s) => s.connection);
  const count = Object.keys(sessions).length;
  const ids = usePullSessionIds((s) => s.ids[pull.url.toLowerCase()]);
  useEffect(() => { if (connection === "open") loadPullSessions(pull.url, count); }, [pull.url, count, connection]);
  return useMemo(() => sessionsOfPull(ids ?? [], sessions), [ids, sessions]);
}
