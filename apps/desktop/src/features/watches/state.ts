/**
 * Review watches live in the daemon, which polls GitHub once a minute. The UI
 * mirrors the list and announces each review the daemon reports. It also
 * announces review activity the daemon hands to a session, and the outcome.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { PrWatch, WatchedReview } from "../../gen";
import { registerCommands } from "../../lib/commands";
import { desktopNotify } from "../../lib/notify";
import { selectSelected, useStore } from "../../state/store";
import { useLinkPreferencesStore } from "../../state/sessionLinkPreferences";
import { useGithubRepos } from "../../state/githubRepos";
import { selectedSessionLinks, sessionLinks } from "../../views/issueLinks";
import { rpc } from "../reviews/state";

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

function tell(title: string, message: string, level: "info" | "warn" | "error" = "info") {
  const app = useStore.getState();
  app.toast(message, level);
  if (app.settings.notifications && !document.hasFocus()) void desktopNotify(title, message);
}

/** GitHub review ids already announced: a watched PR can also be followed by a session, and its changes reach the inbox. */
export const announcedReviews = new Set<number>();

function announce(watch: PrWatch, review: WatchedReview) {
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
export const isHandlingReview = (sessionId: string) => handlingReviews.has(sessionId);

function announceActivity({ pr, items, session }: FollowActivity) {
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

function announceHandled({ session, prs, status, reply }: FollowHandled) {
  // The turn's own event may arrive after this one; keep it quiet a moment longer.
  setTimeout(() => handlingReviews.delete(session.id), 5000);
  const which = prs.map((pr) => `${pr.repo}#${pr.number}`).join(", ");
  const outcome = status === "completed" ? "handled the review on" : status === "interrupted" ? "was interrupted handling the review on"
    : status === "stopped" ? "stopped before handling the review on" : "could not handle the review on";
  const summary = reply ? excerpt(reply, 200) : "";
  tell(session.title, `“${session.title}” ${outcome} ${which}${summary ? `: ${summary}` : ""}`, status === "completed" ? "info" : "error");
}

/** Keep the watch list current and announce reviews. Mount once, in the main window. */
export function useWatchSync(enabled: boolean) {
  const client = useStore((s) => s.client);
  useEffect(() => {
    if (!client || !enabled) return;
    const refresh = () => void useWatches.getState().refresh();
    refresh();
    const off = client.onNotification((method, params) => {
      if (method === "watches.changed") refresh();
      else if (method === "watches.review") {
        const { watch, review } = params as { watch: PrWatch; review: WatchedReview };
        announce(watch, review);
      } else if (method === "follows.activity") announceActivity(params as FollowActivity);
      // The session took it over: its turn's end is announced by follows.handled.
      else if (method === "follows.started") handlingReviews.add((params as { session: { id: string } }).session.id);
      else if (method === "follows.handled") announceHandled(params as FollowHandled);
    });
    const offState = client.onState((s) => { if (s === "open") refresh(); });
    return () => { off(); offState(); };
  }, [client, enabled]);
}

/** The PR a watch command acts on: the open pull request, else the selected session's PR. */
export function currentWatchTarget(): WatchTarget | null {
  const app = useStore.getState();
  if (app.prSelection) return { repo: app.prSelection.repo, number: app.prSelection.number };
  const session = selectSelected(app);
  if (!session) return null;
  const items = app.transcripts[session.id]?.items ?? {};
  const preferences = useLinkPreferencesStore.getState().entries[session.id]?.preferences;
  const pr = selectedSessionLinks(sessionLinks(items, session.title, useGithubRepos.getState().repos[session.cwd] ?? undefined), preferences).find((l) => l.kind === "PR");
  return pr ? { repo: pr.repo, number: Number(pr.number) } : null;
}

function requireTarget() {
  const target = currentWatchTarget();
  if (!target) throw new Error("No pull request here. Link one with “Edit issues & PRs…” first.");
  return target;
}

export function openWatchDialog(target: WatchTarget) {
  useStore.getState().openDialog({ kind: "pr-watch", ...target });
}

export async function stopWatch(target: WatchTarget) {
  await rpc("watches.remove", { id: watchId(target) });
  await useWatches.getState().refresh();
}

export function registerWatchCommands() {
  return registerCommands([
    { id: "pr.watch", title: "Watch PR for reviews…", group: "Pull requests", keywords: ["request reviewer", "review", "approval", "GitHub"], run: () => openWatchDialog(requireTarget()) },
    { id: "pr.watch-stop", title: "Stop watching PR for reviews", group: "Pull requests", keywords: ["dismiss", "review watch"], run: async () => {
      const target = requireTarget();
      if (!useWatches.getState().watches.some((w) => w.id === watchId(target))) throw new Error("This PR is not being watched");
      await stopWatch(target);
      useStore.getState().toast(`Stopped watching ${target.repo}#${target.number}`);
    } },
    { id: "pr.watch-check", title: "Check watched PRs for reviews now", group: "Pull requests", run: async () => {
      useWatches.setState({ watches: await rpc<PrWatch[]>("watches.check") });
    } },
  ]);
}
