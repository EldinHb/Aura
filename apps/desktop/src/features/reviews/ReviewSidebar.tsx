import { useEffect } from "react";
import type { PullRequest } from "../../gen";
import { useStore } from "../../state/store";
import { hidePull, isPullHidden, isRerequested, openHistory, openPull, pullFilter, pullStatus, report, reviewRound, useReviews, visiblePulls } from "./state";

export function ReviewSidebar() {
  const state = useReviews();
  const client = useStore((s) => s.client);
  const rules = useStore((s) => s.settings.pullFilters);
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
  const shown = visiblePulls(state, rules);
  const connected = !!state.inbox?.account;
  return <section className="pr-sidebar" aria-label="Pull requests">
    <div className="pr-sidebar-heading">
      <span className="section-title">Pull requests</span>
      <button className="btn small" title="Refresh pull requests" data-command="reviews.refresh" disabled={state.busy} onClick={() => void state.refresh(true)}>↻</button>
      <button className="btn small" title="Hide section" data-command="reviews.toggle" onClick={() => state.setPreference("hidden", true)}>×</button>
    </div>
    <div className="pr-sidebar-actions"><button className="btn small" data-command="reviews.hidden" onClick={() => state.setPreference("showHidden", !state.showHidden)}>{state.showHidden ? "Hide hidden" : "Show hidden"}</button><button className="btn small" data-command="reviews.history" onClick={openHistory}>Review history</button></div>
    {(state.error || state.inbox?.error) && <p className="pr-error" role="status">{state.error || state.inbox?.error}</p>}
    <div className="pr-sidebar-list">
      <PullGroup title="Needs your review" all={state.inbox?.pulls ?? []} shown={shown.review} collapsed={state.collapsed} onToggle={() => state.setPreference("collapsed", !state.collapsed)} empty={connected ? "Nothing waiting for your review." : "Connect with gh auth login, then refresh."} />
      <PullGroup title="Your pull requests" all={state.inbox?.mine ?? []} shown={shown.mine} collapsed={state.mineCollapsed} onToggle={() => state.setPreference("mineCollapsed", !state.mineCollapsed)} empty={connected ? "You have no open pull requests." : "Connect with gh auth login, then refresh."} mine />
    </div>
    <div className="pr-sync">{state.inbox?.account}{state.inbox?.last_synced && ` · synced ${new Date(state.inbox.last_synced).toLocaleTimeString()}`}</div>
  </section>;
}

function PullGroup({ title, all, shown, collapsed, onToggle, empty, mine = false }: { title: string; all: PullRequest[]; shown: PullRequest[]; collapsed: boolean; onToggle: () => void; empty: string; mine?: boolean }) {
  const selected = useStore((s) => s.prSelection);
  const reviews = useReviews((s) => s.inbox?.reviews);
  const rules = useStore((s) => s.settings.pullFilters);
  return <>
    <button className="btn small pr-group-toggle" data-hint aria-expanded={!collapsed} onClick={onToggle}>{collapsed ? "▸" : "▾"} {title} <span className="badge">{all.filter((p) => !isPullHidden(p, rules)).length}</span></button>
    {!collapsed && shown.map((pull) => {
      const review = reviews?.find((r) => r.pull.id === pull.id && r.status !== "discarded");
      const rule = pullFilter(pull, rules);
      const again = !mine && isRerequested(pull);
      // A pre-review from before the new request covers the previous round, not this one.
      const earlier = again && review && Date.parse(review.created_at) < Date.parse(pull.review_requested_at!);
      return <div key={pull.id} className={`pr-sidebar-row ${selected?.id === pull.id ? "selected" : ""} ${isPullHidden(pull, rules) ? "muted" : ""} ${again ? "rerequested" : ""}`}>
        <button className="pr-row-main" data-hint onClick={() => openPull(pull)} title={pull.title}>
          <span className="title">{pull.draft ? "◌" : "⑂"} {pull.title}</span>
          <span className="sub">{pull.repo}#{pull.number}{!mine && ` · ${pull.author}`}{rule && ` · hidden by ${rule}`}</span>
          <span className="pr-status">{[...(mine ? [] : reviewRound(pull)), ...pullStatus(pull)].map((s) => <span key={s.label} className={`chip ${s.tone ?? ""}`}>{s.label}</span>)}</span>
          {review && <span className={`chip ${review.status === "failed" ? "err" : ""}`}>{review.status}{earlier ? " · earlier round" : review.reviewed_sha && review.reviewed_sha !== pull.head_sha ? " · PR changed" : ""}</span>}
        </button>
        <button className="btn small" data-hint title={pull.hidden ? "Restore PR" : "Hide PR"} onClick={() => void hidePull(pull, !pull.hidden).catch(report)}>{pull.hidden ? "↶" : "×"}</button>
      </div>;
    })}
    {!collapsed && shown.length === 0 && <p className="pr-muted pr-empty">{empty}</p>}
  </>;
}
