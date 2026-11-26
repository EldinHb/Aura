/**
 * Which pull request page is open. Formerly core's `prSelection` / `reviewHistoryOpen`;
 * now the mod's views ("pull", "history"), which keep this store current while they show,
 * so the sidebar can mark the open PR and commands can act on it.
 */
import { create } from "zustand";
import type { PullRequest } from "@aura/github-client";
import { ctx } from "./ctx";
import { setFocus } from "./host";

export const VIEW_PULL = "pull";
export const VIEW_HISTORY = "history";
export const DIALOG_REVIEW_SETTINGS = "review-settings";
export const DIALOG_REVIEW_SUBMIT = "review-submit";
export const DIALOG_WATCH = "pr-watch";

type NavState = {
  /** The PR whose page is open. */
  pull: PullRequest | null;
  /** The review history page is open. */
  history: boolean;
  /** The pre-review shown on the PR page instead of the PR, if any. */
  reviewId: string | null;
};
export const useNav = create<NavState>(() => ({ pull: null, history: false, reviewId: null }));

export function openPull(pull: PullRequest, reviewId: string | null = null) {
  useNav.setState({ pull, history: false, reviewId });
  ctx().openView(VIEW_PULL, { pull });
  setFocus("main");
}

export function openHistory() {
  useNav.setState({ pull: null, history: true });
  ctx().openView(VIEW_HISTORY, {});
  setFocus("main");
}

/** The open PR page or review history closes, e.g. when the GitHub account changed. */
export function closePullPage() {
  const { pull, history } = useNav.getState();
  if (!pull && !history) return;
  useNav.setState({ pull: null, history: false });
  try { ctx().closeView(); } catch { /* not active */ }
}

/** Dialogs of this mod that are open, so a change of account can close them. */
const openDialogs = new Set<() => void>();
export function trackDialog(close: () => void) {
  openDialogs.add(close);
  return () => { openDialogs.delete(close); };
}
export function closeReviewDialogs() {
  for (const close of [...openDialogs]) close();
}
