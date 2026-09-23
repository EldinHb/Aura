import { useEffect } from "react";
import { useStore } from "../../state/store";
import { hidePull, openHistory, openPull, report, useReviews } from "./state";

export function ReviewSidebar() {
  const state = useReviews();
  const client = useStore((s) => s.client);
  const selected = useStore((s) => s.prSelection);
  useEffect(() => {
    if (!client) return;
    void useReviews.getState().refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = client.onNotification((method) => {
      if (method !== "reviews.changed" || timer) return;
      timer = setTimeout(() => { timer = undefined; void useReviews.getState().refresh(); }, 200);
    });
    const offState = client.onState((s) => { if (s === "open") void useReviews.getState().refresh(); });
    return () => { off(); offState(); clearTimeout(timer); };
  }, [client]);
  if (state.hidden) return <button className="btn small pr-restore-section" data-command="reviews.toggle" onClick={() => state.setPreference("hidden", false)}>Show pull requests</button>;
  const pulls = state.inbox?.pulls ?? [];
  const shown = pulls.filter((p) => state.showHidden || !p.hidden);
  return <section className="pr-sidebar" aria-label="Pull requests">
    <div className="pr-sidebar-heading">
      <button className="btn small" data-hint aria-expanded={!state.collapsed} onClick={() => state.setPreference("collapsed", !state.collapsed)}>{state.collapsed ? "▸" : "▾"} Needs your review <span className="badge">{pulls.filter((p) => !p.hidden).length}</span></button>
      <button className="btn small" title="Refresh pull requests" data-command="reviews.refresh" disabled={state.busy} onClick={() => void state.refresh(true)}>↻</button>
      <button className="btn small" title="Hide section" data-command="reviews.toggle" onClick={() => state.setPreference("hidden", true)}>×</button>
    </div>
    {!state.collapsed && <>
      <div className="pr-sidebar-actions"><button className="btn small" data-command="reviews.hidden" onClick={() => state.setPreference("showHidden", !state.showHidden)}>{state.showHidden ? "Hide hidden" : "Show hidden"}</button><button className="btn small" data-command="reviews.history" onClick={openHistory}>Review history</button></div>
      {(state.error || state.inbox?.error) && <p className="pr-error" role="status">{state.error || state.inbox?.error}</p>}
      <div className="pr-sidebar-list">
        {shown.map((pull) => {
          const review = state.inbox?.reviews.find((r) => r.pull.id === pull.id && r.status !== "discarded");
          return <div key={pull.id} className={`pr-sidebar-row ${selected?.id === pull.id ? "selected" : ""} ${pull.hidden ? "muted" : ""}`}>
            <button className="pr-row-main" data-hint onClick={() => openPull(pull)} title={pull.title}>
              <span className="title">{pull.draft ? "◌" : "⑂"} {pull.title}</span>
              <span className="sub">{pull.repo}#{pull.number} · {pull.author}</span>
              <span className="sub">{pull.checks.replaceAll("_", " ")} · {pull.review_decision.replaceAll("_", " ")}</span>
              {review && <span className={`chip ${review.status === "failed" ? "err" : ""}`}>{review.status}{review.reviewed_sha && review.reviewed_sha !== pull.head_sha ? " · PR changed" : ""}</span>}
            </button>
            <button className="btn small" data-hint title={pull.hidden ? "Restore PR" : "Hide PR"} onClick={() => void hidePull(pull, !pull.hidden).catch(report)}>{pull.hidden ? "↶" : "×"}</button>
          </div>;
        })}
        {shown.length === 0 && <p className="pr-muted pr-empty">{state.inbox?.account ? "Nothing waiting for your review." : "Connect with gh auth login, then refresh."}</p>}
      </div>
      <div className="pr-sync">{state.inbox?.account}{state.inbox?.last_synced && ` · synced ${new Date(state.inbox.last_synced).toLocaleTimeString()}`}</div>
    </>}
  </section>;
}
