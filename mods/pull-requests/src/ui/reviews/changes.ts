/**
 * Pull request changes the daemon found on its refresh: the daemon half lists the unread
 * ones in Aura's inbox (`aura.inbox.set`, each item's `data` the PullChange), each new one is
 * announced here, and opening one opens its PR.
 */
import type { PullChange, PullEvent, PullRequest } from "@aura/github-client";
import { rpc, toast } from "../ctx";
import { openPull } from "../nav";
import { tell } from "../notify";
import { normalizePull, normalizePullChange } from "../pulls";
import { usePrSettings } from "../settings";
import { announcedReviews } from "../watches/state";
import { listedPulls, useReviews } from "./state";

/** The kinds of change, as the settings offer them. */
export const PULL_CHANGE_KINDS: { kind: string; label: string }[] = [
  { kind: "commits", label: "New commits" },
  { kind: "review", label: "Reviews" },
  { kind: "comment", label: "Comments and review replies" },
  { kind: "review_requested", label: "Your review requested" },
  { kind: "checks", label: "Checks failed, or pass again" },
  { kind: "state", label: "Merged, closed or reopened" },
  { kind: "mergeable", label: "Merge conflicts, or ready to merge" },
];

/** Why the user follows the PR, as the inbox words it. */
export const ROLES: Record<string, string> = { authored: "your PR", requested: "review requested", reviewed: "you reviewed", linked: "linked" };

/** The events the user wants to hear about. */
export const shownEvents = (change: PullChange, muted: string[]) => change.events.filter((e) => !muted.includes(e.kind));

/** `alice approved · checks failed`, leaving out muted kinds. */
export const describeEvents = (events: PullEvent[]) => events.map((e) => e.text || e.kind.replaceAll("_", " ")).join(" · ");

/** Unread entries with something the user wants to hear about, the latest first. */
export function unreadChanges(changes: PullChange[], muted: string[]) {
  return changes.filter((c) => !c.read && shownEvents(c, muted).length);
}

export async function markChangesRead(ids: string[] | null) {
  try { await rpc("pulls.changes.read", ids ? { ids } : {}); } catch { /* the daemon's next refresh of the inbox shows its state */ }
}

export type Target = Pick<PullChange, "id" | "account" | "pull_id" | "repo" | "number">;

/** The PR as the sidebar lists it, else as last opened, else read from GitHub. */
async function findPull(c: Target): Promise<PullRequest> {
  const listed = listedPulls(useReviews.getState().inbox).find((p) => p.id === c.pull_id && p.account === c.account);
  if (listed) return listed;
  const read = (method: string, params: object) => rpc<{ pull: PullRequest }>(method, params).then((d) => normalizePull(d.pull));
  return read("pulls.cached", { id: c.pull_id, account: c.account }).catch(() => read("pulls.get", { repo: c.repo, number: c.number, account: c.account }));
}

/** Open the PR a change is about, and mark the change read. */
export async function openPullChange(change: Target) {
  void markChangesRead([change.id]);
  try {
    openPull(await findPull(change));
  } catch (e) {
    toast(`Could not open ${change.repo}#${change.number}: ${String(e)}`, "error");
  }
}

/** Toast a change the daemon just found, and notify while the window is in the background. */
export function announceChange(raw: PullChange) {
  const change = normalizePullChange(raw);
  // A review a watch or a session's follow-up already announced is not announced again.
  const events = shownEvents(change, usePrSettings.getState().pullChangesMuted).filter((e) => e.kind !== "review" || !e.review_id || !announcedReviews.has(e.review_id));
  change.events.forEach((e) => e.review_id && announcedReviews.add(e.review_id));
  if (!events.length) return;
  const message = `${change.repo}#${change.number}: ${describeEvents(events)}`;
  const urgent = events.some((e) => e.detail === "CHANGES_REQUESTED" || e.detail === "FAILURE" || e.detail === "ERROR" || e.detail === "conflicts");
  const target: Target = { id: change.id, account: change.account, pull_id: change.pull_id, repo: change.repo, number: change.number };
  tell(change.title || `${change.repo}#${change.number}`, message, urgent ? "warn" : "info", { kind: "pull-change", ...target });
}
