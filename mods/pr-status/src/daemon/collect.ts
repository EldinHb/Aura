// Which pull requests a session tree works on: the session's and every worker's links
// (as the github mod keeps them) and the PR of each one's branch, deduplicated by URL.
import type { Session } from "@aura/mod-sdk";
import type { PrRef } from "../shared/types";

export interface TreeSession {
  session: Session;
  worker: boolean;
}

/** The session `rootId` and every session whose `orchestrator_id` chain leads to it, root first. */
export function sessionTree(sessions: Session[], rootId: string): TreeSession[] {
  const root = sessions.find((s) => s.id === rootId);
  if (!root) return [];
  const out: TreeSession[] = [{ session: root, worker: false }];
  const seen = new Set([root.id]);
  for (let i = 0; i < out.length; i++) {
    const parent = out[i].session.id;
    for (const s of sessions) {
      if (s.orchestrator_id !== parent || seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({ session: s, worker: true });
    }
  }
  return out;
}

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

/** A github.com PR URL as `{url, repo, number}`, in its canonical form; null otherwise. */
export function parsePr(url: string): { url: string; repo: string; number: number } | null {
  const m = PR_URL.exec(url.trim());
  if (!m) return null;
  const number = Number(m[2]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { url: `https://github.com/${m[1]}/pull/${number}`, repo: m[1], number };
}

export const prKey = (url: string) => url.toLowerCase();

/** What the github mod knows of one session's PRs. */
export interface SessionPrs {
  /** `sessions.prs`: the PRs the user chose, else the ones detected in the conversation. */
  linked: string[];
  /** `pulls`: PRs opened from the session's branch. */
  pulls: string[];
  /** `branch_pull` of the session's current branch. */
  branch: string | null;
}

/** The PRs of `tree`, deduplicated by URL, in tree order, with the sessions each came from. */
export function collectPulls(tree: TreeSession[], prsOf: (sessionId: string) => SessionPrs): PrRef[] {
  const byKey = new Map<string, PrRef>();
  for (const { session, worker } of tree) {
    const prs = prsOf(session.id);
    for (const url of [...prs.linked, ...prs.pulls, ...(prs.branch ? [prs.branch] : [])]) {
      const pr = parsePr(url);
      if (!pr) continue;
      const key = prKey(pr.url);
      const ref = byKey.get(key) ?? { ...pr, sources: [] };
      byKey.set(key, ref);
      if (!ref.sources.some((s) => s.sessionId === session.id)) ref.sources.push({ sessionId: session.id, title: session.title, worker });
    }
  }
  return [...byKey.values()];
}
