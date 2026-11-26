/**
 * Review watches live in the daemon, which polls GitHub once a minute. The UI
 * mirrors the list and announces each review the daemon reports. It also
 * announces review activity the daemon hands to a session, and the outcome.
 */
import { create } from "zustand";
import type { PrWatch, WatchedReview } from "@aura/github-client";
import { ctx, rpc } from "../ctx";
import { useStore } from "../host";
import { DIALOG_WATCH, useNav } from "../nav";
import { tell } from "../notify";
import { pullRef } from "../pulls";

export type WatchTarget = { repo: string; number: number };
export type Candidates = {
  title: string; url: string; author: string; state: string;
  requested: string[]; teams: string[];
  reviewed: { login: string; state: string }[];
  candidates: string[]; candidate_error: string | null;
  watch: PrWatch | null;
};

export const watchId = (t: WatchTarget) => `${t.repo.toLowerCase()}#${t.number}`;

type WatchState = { watches: PrWatch[]; error: string | null; refresh: () => Promise<void> };
export const useWatches = create<WatchState>((set) => ({
  watches: [], error: null,
  refresh: async () => {
    try { set({ watches: await rpc<PrWatch[]>("watches.list"), error: null }); }
    catch (e) { set({ error: String(e) }); }
  },
}));

export function useWatch(target: WatchTarget | null) {
  return useWatches((s) => target ? s.watches.find((w) => w.id === watchId(target)) : undefined);
}

export function reviewVerb(state: string) {
  return state === "APPROVED" ? "approved" : state === "CHANGES_REQUESTED" ? "requested changes" : state === "COMMENTED" ? "commented" : state.toLowerCase().replaceAll("_", " ");
}

const excerpt = (text: string, length = 120) => {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
};

/** GitHub review ids already announced: a watched PR can also be followed by a session, and its changes reach the inbox. */
export const announcedReviews = new Set<number>();

export function announceReview(watch: PrWatch, review: WatchedReview) {
  if (announcedReviews.has(review.id)) return;
  announcedReviews.add(review.id);
  const body = excerpt(review.body);
  tell(watch.title || `${watch.repo}#${watch.number}`, `${review.reviewer} ${reviewVerb(review.state)} on ${watch.repo}#${watch.number}${body ? `: ${body}` : ""}`,
    review.state === "CHANGES_REQUESTED" ? "warn" : "info");
}

type FollowedPr = { repo: string; number: number; title: string; url: string };
export type FollowActivity = {
  pr: FollowedPr;
  items: { kind: "review" | "comment" | "conversation"; id: number; author: string; state: string; body: string; url: string; path: string | null; line: number | null }[];
  session: { id: string; title: string } | null;
};
export type FollowHandled = {
  session: { id: string; title: string }; prs: FollowedPr[];
  status: "completed" | "failed" | "interrupted" | "stopped"; reply: string | null;
};

/** Sessions working on review activity Aura handed them; their turn's end is announced by `follows.handled`. */
const handlingReviews = new Set<string>();
/** Aura keeps its own "turn finished" notification quiet for these (see `ctx.suppressTurnToast`). */
export const isHandlingReview = (sessionId: string) => handlingReviews.has(sessionId);
export const startHandlingReview = (sessionId: string) => { handlingReviews.add(sessionId); };

export function announceActivity({ pr, items, session }: FollowActivity) {
  const fresh = items.filter((item) => item.kind !== "review" || !announcedReviews.has(item.id));
  items.forEach((item) => item.kind === "review" && announcedReviews.add(item.id));
  if (!fresh.length && !session) return;
  const who = [...new Set(fresh.map((item) => item.author))];
  const what = fresh.length === 1
    ? `${fresh[0].author} ${fresh[0].kind === "review" ? reviewVerb(fresh[0].state) : "commented"}`
    : fresh.length ? `${fresh.length} new reviews and comments by ${who.join(", ")}` : "Review activity";
  const body = fresh.length === 1 ? excerpt(fresh[0].body) : "";
  const handoff = session ? ` — for “${session.title}”` : "";
  tell(pr.title || `${pr.repo}#${pr.number}`, `${what} on ${pr.repo}#${pr.number}${body ? `: ${body}` : ""}${handoff}`,
    fresh.some((item) => item.state === "CHANGES_REQUESTED") ? "warn" : "info");
}

export function announceHandled({ session, prs, status, reply }: FollowHandled) {
  // The turn's own event may arrive after this one; keep it quiet a moment longer.
  setTimeout(() => handlingReviews.delete(session.id), 5000);
  const which = prs.map((pr) => `${pr.repo}#${pr.number}`).join(", ");
  const outcome = status === "completed" ? "handled the review on" : status === "interrupted" ? "was interrupted handling the review on"
    : status === "stopped" ? "stopped before handling the review on" : "could not handle the review on";
  const summary = reply ? excerpt(reply, 200) : "";
  tell(session.title, `“${session.title}” ${outcome} ${which}${summary ? `: ${summary}` : ""}`, status === "completed" ? "info" : "error");
}

/** The pull requests of a session, as the github mod links them (its links, else the ones it detected). */
export async function sessionPulls(sessionId: string): Promise<WatchTarget[]> {
  const refs = await ctx().call<unknown>("github", "session.prs", { sessionId });
  const seen = new Set<string>();
  return (Array.isArray(refs) ? refs : []).flatMap((ref) => {
    const target = typeof ref === "string" ? pullRef(ref) : null;
    if (!target || seen.has(watchId(target))) return [];
    seen.add(watchId(target));
    return [target];
  });
}

/** The PR a watch command acts on: the open pull request, else the selected session's PR. */
export async function currentWatchTarget(): Promise<WatchTarget | null> {
  const open = useNav.getState().pull;
  if (open) return { repo: open.repo, number: open.number };
  const app = useStore.getState();
  const session = app.selectedId ? app.sessions[app.selectedId] : null;
  if (!session) return null;
  return (await sessionPulls(session.id).catch(() => []))[0] ?? null;
}

export async function requireTarget() {
  const target = await currentWatchTarget();
  if (!target) throw new Error("No pull request here. Link one with “Edit issues & PRs…” first.");
  return target;
}

export function openWatchDialog(target: WatchTarget) {
  ctx().openDialog(DIALOG_WATCH, target);
}

export async function stopWatch(target: WatchTarget) {
  await rpc("watches.remove", { id: watchId(target) });
  await useWatches.getState().refresh();
}

export async function checkWatches() {
  useWatches.setState({ watches: await rpc<PrWatch[]>("watches.check") });
}
