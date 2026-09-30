/**
 * Review watches live in the daemon, which polls GitHub once a minute. The UI
 * mirrors the list and announces each review the daemon reports.
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

function announce(watch: PrWatch, review: WatchedReview) {
  const excerpt = review.body.trim().replace(/\s+/g, " ");
  const message = `${review.reviewer} ${reviewVerb(review.state)} on ${watch.repo}#${watch.number}${excerpt ? `: ${excerpt.slice(0, 120)}` : ""}`;
  const app = useStore.getState();
  app.toast(message, review.state === "CHANGES_REQUESTED" ? "warn" : "info");
  if (app.settings.notifications && !document.hasFocus()) void desktopNotify(watch.title || `${watch.repo}#${watch.number}`, message);
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
      }
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
  if (!target) throw new Error("No pull request here. Link one with “Edit issue & PR…” first.");
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
