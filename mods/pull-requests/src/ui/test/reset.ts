// Put every store of the mod back to its first state, between tests.
import { useNav } from "../nav";
import { useReviewDrafts, useReviews } from "../reviews/state";
import { usePullSessionIds } from "../reviews/sessions";
import { defaultPrSettings, usePrSettings } from "../settings";
import { announcedReviews, useWatches } from "../watches/state";

export function resetStores() {
  useReviews.setState({ inbox: null, error: null, busy: false, collapsed: false, mineCollapsed: false, hidden: false, showHidden: false, groupsCollapsed: {} });
  useReviewDrafts.setState({ drafts: {} });
  useNav.setState({ pull: null, history: false, reviewId: null });
  usePrSettings.setState({ ...defaultPrSettings });
  useWatches.setState({ watches: [], error: null });
  usePullSessionIds.setState({ ids: {}, read: {} });
  announcedReviews.clear();
}
