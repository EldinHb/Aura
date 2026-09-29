import clsx from "clsx";
import type { WatchedReview } from "../../gen";
import { ExternalLink } from "../../components/ExternalLink";
import { runCommand } from "../../lib/commands";
import { relTime } from "../../views/transcript/format";
import { reviewVerb, useWatch, useWatches, type WatchTarget } from "./state";

const dot = (r: WatchedReview) => r.state === "APPROVED" ? "ok" : r.state === "CHANGES_REQUESTED" ? "err" : "info";

/** Inspector section for the session's PR: start a watch, or follow one. */
export function WatchSection({ target }: { target: WatchTarget }) {
  const watch = useWatch(target);
  const error = useWatches((s) => s.error);
  const action = (cmd: string, label: string) => (
    <button className="btn small" data-command={cmd} onClick={() => void runCommand(cmd)}>{label}</button>
  );
  if (!watch) return (
    <div className="inspector-section pr-watch">
      <h4 className="section-head">Review watch {action("pr.watch", "Watch…")}</h4>
      <p className="dim">{error ? `Could not load watches: ${error}` : `Not watching #${target.number} for reviews.`}</p>
    </div>
  );
  const waiting = watch.reviewers.filter((login) => !watch.reviews.some((r) => r.reviewer.toLowerCase() === login.toLowerCase()));
  const status = watch.status === "watching"
    ? `Waiting for ${waiting.length ? waiting.join(", ") : "any reviewer"}`
    : watch.status === "done" ? "Every reviewer responded" : "PR is closed";
  return (
    <div className="inspector-section pr-watch">
      <h4 className="section-head">Review watch <span className="with-btn">
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
