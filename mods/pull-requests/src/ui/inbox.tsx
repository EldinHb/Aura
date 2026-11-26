/**
 * The rows of PR changes in Aura's inbox. The daemon half lists the unread changes there
 * (`aura.inbox.set`, each item's `data` the PullChange); Aura renders each with this and
 * calls `openInboxItem` when the user opens one. Formerly part of core's InboxDialog.
 */
import type { InboxItemProps } from "@aura/mod-sdk/ui";
import type { PullChange } from "@aura/github-client";
import { relTime } from "./host";
import { normalizePullChange } from "./pulls";
import { usePrSettings } from "./settings";
import { describeEvents, openPullChange, ROLES, shownEvents } from "./reviews/changes";

const changeOf = (item: InboxItemProps["item"]): PullChange | null =>
  item.data && typeof item.data === "object" && !Array.isArray(item.data) && "pull_id" in item.data ? normalizePullChange(item.data as unknown as PullChange) : null;

export function PullChangeItem({ item }: InboxItemProps) {
  const muted = usePrSettings((s) => s.pullChangesMuted);
  const c = changeOf(item);
  if (!c) return <span className="grow"><div className="inbox-title">{item.title}</div>{item.detail && <div className="dim inbox-sub">{item.detail}</div>}</span>;
  // SDK-GAP: the inbox counts every item the daemon set; muted kinds can only be left out of the text here.
  const events = shownEvents(c, muted);
  return <>
    <span className="chip">PR</span>
    <span className="inbox-kind chip">{ROLES[c.role] ?? "pull request"}</span>
    <span className="grow" title="Open the pull request">
      <div className="inbox-title">{c.title || `${c.repo}#${c.number}`}</div>
      <div className="dim mono inbox-sub">{c.repo}#{c.number}</div>
      <div className="dim inbox-sub">{describeEvents(events.length ? events : c.events)}</div>
    </span>
    <span className="dim">{relTime(c.created_at || item.at)}</span>
  </>;
}

/** Open the PR of an inbox item, and mark its change read. */
export function openInboxItem(item: InboxItemProps["item"]) {
  const c = changeOf(item);
  if (c) void openPullChange(c);
}
