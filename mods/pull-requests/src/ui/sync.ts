/**
 * Keeping the PR inbox and the watches current, and announcing what the daemon reports.
 * Formerly the ReviewSidebar's subscription and App's `usePullChangeSync` / `useWatchSync`.
 * Every window keeps its lists; only the main window announces, or each would say it.
 */
import type { Disposer, UiApi } from "@aura/mod-sdk/ui";
import type { PrWatch, WatchedReview } from "@aura/github-client";
import { isSessionWindow } from "./ctx";
import { useStore } from "./host";
import { normalizePullChanges } from "./pulls";
import { announceChange, openPullChange, type Target } from "./reviews/changes";
import { useReviews } from "./reviews/state";
import { setNotificationHandler } from "./notify";
import { announceActivity, announceHandled, announceReview, startHandlingReview, useWatches, type FollowActivity, type FollowHandled } from "./watches/state";

export function startSync(ctx: UiApi, announce = !isSessionWindow()): Disposer {
  const offs: Disposer[] = [];
  const refreshInbox = () => void useReviews.getState().refresh();
  const refreshWatches = () => void useWatches.getState().refresh();
  refreshInbox();
  refreshWatches();
  offs.push(ctx.onConnection((state) => { if (state === "open") { refreshInbox(); refreshWatches(); } }));

  let timer: ReturnType<typeof setTimeout> | undefined;
  offs.push(ctx.on("reviews.changed", () => {
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; refreshInbox(); }, 200);
  }));
  offs.push(() => clearTimeout(timer));
  offs.push(ctx.on("watches.changed", refreshWatches));

  if (announce) {
    offs.push(ctx.on("pulls.activity", (params: { changes?: unknown } | null) => normalizePullChanges(params?.changes).forEach(announceChange)));
    offs.push(ctx.on("watches.review", ({ watch, review }: { watch: PrWatch; review: WatchedReview }) => announceReview(watch, review)));
    offs.push(ctx.on("follows.activity", (params: FollowActivity) => announceActivity(params)));
    // The session took it over: its turn's end is announced by follows.handled.
    offs.push(ctx.on("follows.started", (params: { session: { id: string } }) => startHandlingReview(params.session.id)));
    offs.push(ctx.on("follows.handled", (params: FollowHandled) => announceHandled(params)));
    const open = (target: Record<string, unknown>) => {
      if (target.kind !== "pull-change") return;
      // Whatever Aura shows over the main area (the inbox, say) gives way to the PR.
      useStore.getState().closeDialog();
      void openPullChange(target as unknown as Target);
    };
    setNotificationHandler(open);
    offs.push(() => setNotificationHandler(null));
  }
  return () => offs.forEach((off) => off());
}
