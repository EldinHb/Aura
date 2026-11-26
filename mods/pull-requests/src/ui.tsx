/**
 * The pull-requests mod's UI half: the PR section of the sidebar, the PR page and review
 * history, pre-review dialogs, review watches in the inspector, PR changes in the inbox, and
 * the mod's settings. It talks to its daemon half with the former core method names.
 */
import { defineUi, type DialogProps } from "@aura/mod-sdk/ui";
import type { PullRequest, ReviewConfig, SubmissionPreview } from "@aura/github-client";
import "./ui.css";
import { registerReviewCommands, registerWatchCommands } from "./ui/commands";
import { setCtx } from "./ui/ctx";
import { openInboxItem, PullChangeItem } from "./ui/inbox";
import { DIALOG_REVIEW_SETTINGS, DIALOG_REVIEW_SUBMIT, DIALOG_WATCH, useNav, VIEW_HISTORY, VIEW_PULL } from "./ui/nav";
import { handleNotificationTarget } from "./ui/notify";
import { HistoryPage, PullPage } from "./ui/reviews/PullWorkspace";
import { ReviewSubmit } from "./ui/reviews/ReviewEditor";
import { ReviewSettings } from "./ui/reviews/ReviewSettings";
import { ReviewSidebar } from "./ui/reviews/ReviewSidebar";
import { useReviews } from "./ui/reviews/state";
import { usePrSettings } from "./ui/settings";
import { PullSettingsTab } from "./ui/SettingsTab";
import { startSync } from "./ui/sync";
import { WatchDialog } from "./ui/watches/WatchDialog";
import { isHandlingReview } from "./ui/watches/state";
import { SessionWatches } from "./ui/watches/WatchSection";

export default defineUi((ctx) => {
  setCtx(ctx);
  usePrSettings.getState().load();
  useReviews.getState().loadPreferences();

  const offs = [
    ctx.ui.sidebarSection({ id: "pulls", order: 100, component: ReviewSidebar }),
    ctx.ui.view({ id: VIEW_PULL, title: "Pull request", component: PullPage }),
    ctx.ui.view({ id: VIEW_HISTORY, title: "Review history", component: HistoryPage }),
    ctx.ui.dialog({ id: DIALOG_REVIEW_SETTINGS, component: ({ props, close }: DialogProps<{ pull: PullRequest; config?: ReviewConfig }>) => <ReviewSettings pull={props.pull} config={props.config} close={close} /> }),
    ctx.ui.dialog({ id: DIALOG_REVIEW_SUBMIT, component: ({ props, close }: DialogProps<{ preview: SubmissionPreview }>) => <ReviewSubmit preview={props.preview} close={close} /> }),
    ctx.ui.dialog({ id: DIALOG_WATCH, component: ({ props, close }: DialogProps<{ repo: string; number: number }>) => <WatchDialog key={`${props.repo}#${props.number}`} target={{ repo: props.repo, number: props.number }} close={close} /> }),
    ctx.ui.inspectorSection({ id: "watches", order: 10, component: SessionWatches }),
    ctx.ui.inboxRenderer({ component: PullChangeItem, open: openInboxItem }),
    ctx.ui.settingsTab({ id: "pull-requests", title: "Pull requests", component: PullSettingsTab }),
    registerReviewCommands(ctx),
    registerWatchCommands(ctx),
    // A turn on review activity Aura handed over gets its own notification (follows.handled).
    ctx.suppressTurnToast((session) => isHandlingReview(session.id)),
    ctx.onNotificationClick(handleNotificationTarget),
    startSync(ctx),
  ];

  // `when` keys: "mod.pull-requests.prSelected" while a PR's page is open.
  const context = () => { const { pull } = useNav.getState(); ctx.context.set("prSelected", !!pull); ctx.context.set("prId", pull ? pull.id : null); };
  context();
  offs.push(useNav.subscribe(context));

  return () => {
    offs.forEach((off) => off());
    setCtx(null);
  };
});
