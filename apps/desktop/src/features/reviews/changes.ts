/**
 * Pull request changes the daemon found on its refresh (aura-review `changes.rs`): the
 * inbox lists the unread ones, each new one is announced, and opening one opens its PR.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { PullChange, PullEvent, PullRequest } from "../../gen";
import { desktopNotify, onNotificationClick } from "../../lib/notify";
import { normalizePull, normalizePullChanges } from "../../lib/pulls";
import { useStore } from "../../state/store";
import { announcedReviews } from "../watches/state";
import { openPull, rpc, useReviews } from "./state";

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

type ChangesState = { changes: PullChange[]; refresh: () => Promise<void> };
export const usePullChanges = create<ChangesState>((set) => ({
  changes: [],
  refresh: async () => {
    // An older daemon does not know the method; it has no changes to show.
    try { set({ changes: normalizePullChanges(await rpc<unknown>("pulls.changes")) }); } catch { /* keep what is shown */ }
  },
}));

/** The events the user wants to hear about. */
export const shownEvents = (change: PullChange, muted: string[]) => change.events.filter((e) => !muted.includes(e.kind));

/** `alice approved · checks failed`, leaving out muted kinds. */
export const describeEvents = (events: PullEvent[]) => events.map((e) => e.text || e.kind.replaceAll("_", " ")).join(" · ");

/** Unread entries with something the user wants to hear about, the latest first. */
export function unreadChanges(changes: PullChange[], muted: string[]) {
  return changes.filter((c) => !c.read && shownEvents(c, muted).length);
}

export async function markChangesRead(ids: string[] | null) {
  usePullChanges.setState((s) => ({ changes: s.changes.map((c) => (!ids || ids.includes(c.id) ? { ...c, read: true } : c)) }));
  try { await rpc("pulls.changes.read", ids ? { ids } : {}); } catch { /* the next refresh shows the daemon's state */ }
}

type Target = Pick<PullChange, "id" | "account" | "pull_id" | "repo" | "number">;

/** The PR as the sidebar lists it, else as last opened, else read from GitHub. */
async function findPull(c: Target): Promise<PullRequest> {
  const inbox = useReviews.getState().inbox;
  const listed = [...(inbox?.pulls ?? []), ...(inbox?.reviewed ?? []), ...(inbox?.mine ?? [])].find((p) => p.id === c.pull_id && p.account === c.account);
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
    useStore.getState().toast(`Could not open ${change.repo}#${change.number}: ${String(e)}`, "error");
  }
}

function announceChange(change: PullChange) {
  const app = useStore.getState();
  // A review a watch or a session's follow-up already announced is not announced again.
  const events = shownEvents(change, app.settings.pullChangesMuted).filter((e) => e.kind !== "review" || !e.review_id || !announcedReviews.has(e.review_id));
  change.events.forEach((e) => e.review_id && announcedReviews.add(e.review_id));
  if (!events.length) return;
  const message = `${change.repo}#${change.number}: ${describeEvents(events)}`;
  const urgent = events.some((e) => e.detail === "CHANGES_REQUESTED" || e.detail === "FAILURE" || e.detail === "ERROR" || e.detail === "conflicts");
  app.toast(message, urgent ? "warn" : "info");
  if (app.settings.notifications && !document.hasFocus()) {
    const target: Target = { id: change.id, account: change.account, pull_id: change.pull_id, repo: change.repo, number: change.number };
    void desktopNotify(change.title || `${change.repo}#${change.number}`, message, { kind: "pull-change", ...target });
  }
}

/**
 * Keep the changes current, for the inbox and its count, in every window. With
 * `announce` (the main window only, or each would say it) also announce new ones
 * and open the PR of a clicked notification.
 */
export function usePullChangeSync(announce: boolean) {
  const client = useStore((s) => s.client);
  useEffect(() => {
    if (!announce) return;
    return onNotificationClick((target) => {
      if (target.kind !== "pull-change") return;
      useStore.getState().closeDialog();
      void openPullChange(target as unknown as Target);
    });
  }, [announce]);
  useEffect(() => {
    if (!client) return;
    const refresh = () => void usePullChanges.getState().refresh();
    refresh();
    const off = client.onNotification((method, params) => {
      if (method === "pulls.activity" && announce) normalizePullChanges((params as { changes?: unknown })?.changes).forEach(announceChange);
      else if (method === "pulls.changes.changed") refresh();
    });
    const offState = client.onState((s) => { if (s === "open") refresh(); });
    return () => { off(); offState(); };
  }, [client, announce]);
}
