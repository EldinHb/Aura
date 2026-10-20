/**
 * The sessions that worked on a pull request, for the PR page and the PR list.
 * A session counts when it links the PR (the links the user chose, else the
 * ones detected in its conversation, as its sidebar row shows them), when its
 * branch is the PR's head now, or when it was once: the daemon remembers the
 * PRs found for a session's branch in `Session.pulls`, so deleting the branch
 * or moving on to another one does not lose the session. Orchestrators show
 * with the workers that did the work under them.
 */
import { useEffect, useMemo } from "react";
import type { BranchPull, BranchStatus, PullRequest, Session } from "../gen";
import { selectedSessionLinks, type LinkPreferences, type SessionLink } from "../views/issueLinks";
import { pullKey, useBranches } from "./branchStatus";
import { folderOf } from "../lib/sessionFolder";
import { loadGithubRepo, useGithubRepos } from "./githubRepos";
import { loadDetectedLinks, loadLinkPreferences, useDetectedLinksStore, useLinkPreferencesStore } from "./sessionLinkPreferences";
import { useStore } from "./store";

/** Why a session is listed: it links the PR, or its branch is or was the PR's head. */
export type PullSessionReason = "linked" | "branch";
/** A listed session; an orchestrator without reasons of its own is there for its workers. */
export type PullSession = { session: Session; reasons: PullSessionReason[]; workers: PullSession[] };
export type PullRef = Pick<PullRequest, "repo" | "number" | "head_ref">;

export type PullSessionSources = {
  sessions: Record<string, Session>;
  preferences: Record<string, LinkPreferences | undefined>;
  detected: Record<string, SessionLink[] | undefined>;
  git: Record<string, BranchStatus | null>;
  branchPulls: Record<string, { pull: BranchPull | null } | undefined>;
  repos: Record<string, string | null>;
};

/** `owner/repo` and number of a pull request URL, on github.com or an Enterprise host. */
export function pullOfUrl(url: string): { repo: string; number: number } | null {
  const match = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/i.exec(url.trim());
  return match ? { repo: match[1], number: Number(match[2]) } : null;
}

const isPull = (pull: PullRef, other: { repo: string; number: number | string } | null | undefined) =>
  !!other && Number(other.number) === pull.number && other.repo.toLowerCase() === pull.repo.toLowerCase();

/** The pull request of the branch checked out in the session's folder, as its sidebar row last read it. */
function currentBranchPull(session: Session, sources: PullSessionSources): BranchPull | null {
  // An orchestrator without a folder has no branch.
  const folder = folderOf(session);
  if (folder === null) return null;
  const git = sources.git[folder];
  const repo = sources.repos[folder];
  const branch = git?.upstream_branch ?? git?.branch;
  if (!git || !repo || !branch) return null;
  return sources.branchPulls[pullKey({ repo, headRepo: git.upstream_repo ?? repo, branch })]?.pull ?? null;
}

function reasonsFor(pull: PullRef, session: Session, sources: PullSessionSources): PullSessionReason[] {
  const reasons: PullSessionReason[] = [];
  const links = selectedSessionLinks(sources.detected[session.id] ?? [], sources.preferences[session.id]);
  if (links.some((link) => link.kind === "PR" && isPull(pull, link))) reasons.push("linked");
  const folder = folderOf(session);
  const repo = folder !== null ? sources.repos[folder] : undefined;
  const branch = (session.pulls ?? []).some((url) => isPull(pull, pullOfUrl(url)))
    || isPull(pull, currentBranchPull(session, sources))
    // A worktree's branch is the session's own; this finds workers whose rows were never shown.
    || (!!session.worktree && session.worktree.branch === pull.head_ref && !!repo && repo.toLowerCase() === pull.repo.toLowerCase());
  if (branch) reasons.push("branch");
  return reasons;
}

/** Sessions still in use first, then the most recently active. */
const byActivity = (a: PullSession, b: PullSession) =>
  Number(a.session.archived) - Number(b.session.archived) || b.session.last_activity.localeCompare(a.session.last_activity);

/** The sessions that worked on `pull`, workers grouped under their orchestrator. */
export function sessionsOfPull(pull: PullRef, sources: PullSessionSources): PullSession[] {
  const entries = new Map<string, PullSession>();
  for (const session of Object.values(sources.sessions)) {
    const reasons = reasonsFor(pull, session, sources);
    if (reasons.length) entries.set(session.id, { session, reasons, workers: [] });
  }
  // Orchestrators are set when a worker starts, so they cannot loop; a damaged store is still no reason to hang.
  const loops = (session: Session) => {
    const seen = new Set([session.id]);
    for (let id = session.orchestrator_id; id; id = sources.sessions[id]?.orchestrator_id ?? null) {
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
    const orchestrator = entry.session.orchestrator_id ? sources.sessions[entry.session.orchestrator_id] : undefined;
    if (!orchestrator || loops(entry.session)) { top.push(entry); return; }
    let parent = entries.get(orchestrator.id);
    if (!parent) {
      parent = { session: orchestrator, reasons: [], workers: [] };
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

/** The sessions that worked on `pull`, kept up to date. */
export function usePullSessions(pull: PullRef): PullSession[] {
  const sessions = useStore((s) => s.sessions);
  const entries = useLinkPreferencesStore((s) => s.entries);
  const detected = useDetectedLinksStore((s) => s.links);
  const git = useBranches((s) => s.git);
  const branchPulls = useBranches((s) => s.pulls);
  const repos = useGithubRepos((s) => s.repos);
  const preferences = useMemo(() => Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, entry.preferences])), [entries]);
  return useMemo(() => sessionsOfPull(pull, { sessions, preferences, detected, git, branchPulls, repos }),
    [pull, sessions, preferences, detected, git, branchPulls, repos]);
}

/**
 * Load what the association reads for sessions the sidebar does not list
 * (archived ones, collapsed workers): their links, and the repository of each
 * worktree. The sidebar keeps the links of the sessions it lists fresh.
 */
export function useLoadPullSessionSources() {
  const client = useStore((s) => s.client);
  const connection = useStore((s) => s.connection);
  const sessions = useStore((s) => s.sessions);
  useEffect(() => {
    if (!client || connection !== "open") return;
    const { entries } = useLinkPreferencesStore.getState();
    const { links } = useDetectedLinksStore.getState();
    for (const session of Object.values(sessions)) {
      // Sessions update many times a second while running; ask for each once.
      if (requestedLinks.has(session.id)) continue;
      requestedLinks.add(session.id);
      if (!entries[session.id]) void loadLinkPreferences(client, session.id);
      if (!links[session.id]) void loadDetectedLinks(client, session.id);
      if (session.worktree) void loadGithubRepo(client, session.cwd);
    }
  }, [client, connection, sessions]);
}
const requestedLinks = new Set<string>();

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

const recorded = new Set<string>();

/** Have the daemon remember the PR of the session's branch, once per session and PR. */
export function useRecordBranchPull(session: Session, pull: BranchPull | null) {
  const client = useStore((s) => s.client);
  const url = pull?.url;
  const known = !!url && (session.pulls ?? []).some((other) => other.toLowerCase() === url.toLowerCase());
  const worked = workedOnBranch(session);
  useEffect(() => {
    if (!client || !url || known || !worked || !pullOfUrl(url)) return;
    const key = `${session.id}\n${url.toLowerCase()}`;
    if (recorded.has(key)) return;
    recorded.add(key);
    // A daemon without `session.record_pull` still shows the session while the branch is checked out.
    client.recordSessionPull(session.id, url).catch((error: unknown) => console.warn(`Could not record ${url} on session ${session.id}:`, error));
  }, [client, session.id, url, known, worked]);
}

/** Forget which PRs were recorded and which links were asked for; for tests. */
export function resetPullSessions() {
  recorded.clear();
  requestedLinks.clear();
}
