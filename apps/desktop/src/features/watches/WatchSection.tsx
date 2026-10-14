import clsx from "clsx";
import type { PrWatch, WatchedReview } from "../../gen";
import { ExternalLink } from "../../components/ExternalLink";
import { relTime } from "../../views/transcript/format";
import { useStore } from "../../state/store";
import { rpc } from "../reviews/state";
import { openWatchDialog, reviewVerb, stopWatch, useWatch, useWatches, type WatchTarget } from "./state";

const dot = (r: WatchedReview) => r.state === "APPROVED" ? "ok" : r.state === "CHANGES_REQUESTED" ? "err" : "info";

/** Act on this section's PR, which need not be the session's first. */
const actions: Record<string, (target: WatchTarget) => Promise<void> | void> = {
  "pr.watch": openWatchDialog,
  "pr.watch-stop": stopWatch,
  "pr.watch-check": async () => { useWatches.setState({ watches: await rpc<PrWatch[]>("watches.check") }); },
};

/** Inspector section for one of the session's PRs: start a watch, or follow one. */
export function WatchSection({ target, showTarget }: { target: WatchTarget; showTarget?: boolean }) {
  const watch = useWatch(target);
  const error = useWatches((s) => s.error);
  const action = (cmd: string, label: string) => (
    <button className="btn small" data-command={cmd} onClick={() => {
      void Promise.resolve().then(() => actions[cmd](target)).catch((e) => useStore.getState().toast(String(e), "error"));
    }}>{label}</button>
  );
  const heading = showTarget ? `Review watch · #${target.number}` : "Review watch";
  if (!watch) return (
    <div className="inspector-section pr-watch">
      <h4 className="section-head">{heading} {action("pr.watch", "Watch…")}</h4>
      <p className="dim">{error ? `Could not load watches: ${error}` : `Not watching #${target.number} for reviews.`}</p>
    </div>
  );
  const waiting = watch.reviewers.filter((login) => !watch.reviews.some((r) => r.reviewer.toLowerCase() === login.toLowerCase()));
  const status = watch.status === "watching"
    ? `Waiting for ${waiting.length ? waiting.join(", ") : "any reviewer"}`
    : watch.status === "done" ? "Every reviewer responded" : "PR is closed";
  return (
    <div className="inspector-section pr-watch">
      <h4 className="section-head">{heading} <span className="with-btn">
        {watch.status === "watching" && action("pr.watch-check", "Check")}
        {action("pr.watch", watch.status === "watching" ? "Edit…" : "Watch again…")}
        {action("pr.watch-stop", watch.status === "watching" ? "Stop" : "Dismiss")}
      </span></h4>
      <div className="notice">
        <span className={clsx("dot", watch.status === "watching" ? "warn pulse" : watch.status === "done" ? "ok" : "")} /> {status}
      </div>
      {watch.last_checked && <p className="dim">checked {relTime(watch.last_checked)}</p>}
      {watch.error && <p className="err-text" title={watch.error}>{watch.error}</p>}
      {watch.reviews.slice().reverse().map((r) => (
        <ExternalLink key={r.id} href={r.url} title={r.body || r.url} className="watch-review">
          <span className={clsx("dot", dot(r))} />
          <span className="grow">{r.reviewer} {reviewVerb(r.state)}</span>
          <span className="dim">{relTime(r.submitted_at)}</span>
        </ExternalLink>
      ))}
    </div>
  );
}
