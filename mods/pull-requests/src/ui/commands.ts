/**
 * The mod's commands. Aura prefixes each id with "pull-requests.", so the former core
 * command `reviews.refresh` is now `pull-requests.reviews.refresh`, and so on.
 */
import type { CommandDef, Disposer, UiApi } from "@aura/mod-sdk/ui";
import { toast } from "./ctx";
import { openHistory, useNav } from "./nav";
import { startReview, toggleOpenPullHidden, useReviews } from "./reviews/state";
import { checkWatches, openWatchDialog, requireTarget, stopWatch, useWatches, watchId } from "./watches/state";

const GROUP = "Pull requests";
/** `when` of the commands that act on the open PR (see the `prSelected` context key set in ../ui.tsx). */
const PR_SELECTED = "mod.pull-requests.prSelected";

const register = (ctx: UiApi, commands: Omit<CommandDef, "group">[]): Disposer => {
  const offs = commands.map((c) => ctx.commands.register({ group: GROUP, ...c }));
  return () => offs.forEach((off) => off());
};

export function registerReviewCommands(ctx: UiApi): Disposer {
  return register(ctx, [
    { id: "reviews.refresh", title: "Refresh pull requests", run: () => useReviews.getState().refresh(true) },
    { id: "reviews.toggle", title: "Show / hide pull requests section", run: () => { const s = useReviews.getState(); s.setPreference("hidden", !s.hidden); } },
    { id: "reviews.hidden", title: "Show / hide hidden pull requests", run: () => { const s = useReviews.getState(); s.setPreference("showHidden", !s.showHidden); s.setPreference("hidden", false); s.setPreference("collapsed", false); s.setPreference("mineCollapsed", false); } },
    { id: "reviews.history", title: "Open review history", run: openHistory },
    { id: "reviews.start", title: "Pre-review selected pull request…", when: PR_SELECTED, run: () => { const p = useNav.getState().pull; if (p) startReview(p); } },
    { id: "reviews.hide", title: "Hide / restore selected pull request", when: PR_SELECTED, run: toggleOpenPullHidden },
  ]);
}

export function registerWatchCommands(ctx: UiApi): Disposer {
  return register(ctx, [
    { id: "pr.watch", title: "Watch PR for reviews…", keywords: ["request reviewer", "review", "approval", "GitHub"], run: async () => openWatchDialog(await requireTarget()) },
    { id: "pr.watch-stop", title: "Stop watching PR for reviews", keywords: ["dismiss", "review watch"], run: async () => {
      const target = await requireTarget();
      if (!useWatches.getState().watches.some((w) => w.id === watchId(target))) throw new Error("This PR is not being watched");
      await stopWatch(target);
      toast(`Stopped watching ${target.repo}#${target.number}`);
    } },
    { id: "pr.watch-check", title: "Check watched PRs for reviews now", run: checkWatches },
  ]);
}
