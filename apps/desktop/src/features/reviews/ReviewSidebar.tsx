import { useEffect } from "react";
import type { PullRequest } from "../../gen";
import { useStore } from "../../state/store";
import { useLoadPullSessionSources } from "../../state/pullSessions";
import { PullSessionCount } from "./PullSessions";
import { hidePull, isPullHidden, isRerequested, isStale, mergeStatus, openHistory, openPull, pullFilter, pullStatus, report, reviewerEntries, reviewRound, useReviews, visiblePulls } from "./state";

export function ReviewSidebar() {
  const state = useReviews();
  const client = useStore((s) => s.client);
  const rules = useStore((s) => s.settings.pullFilters);
  useLoadPullSessionSources();
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
  const count = (pulls: PullRequest[] | undefined) => (pulls ?? []).filter((p) => !isPullHidden(p, rules)).length;
  return <section className="pr-sidebar" aria-label="Pull requests">
    <div className="pr-sidebar-heading">
      <span className="section-title">Pull requests</span>
      <button className="btn small" title="Refresh pull requests" data-command="reviews.refresh" disabled={state.busy} onClick={() => void state.refresh(true)}>↻</button>
      <button className="btn small" title="Hide section" data-command="reviews.toggle" onClick={() => state.setPreference("hidden", true)}>×</button>
    </div>
    <div className="pr-sidebar-actions"><button className="btn small" data-command="reviews.hidden" onClick={() => state.setPreference("showHidden", !state.showHidden)}>{state.showHidden ? "Hide hidden" : "Show hidden"}</button><button className="btn small" data-command="reviews.history" onClick={openHistory}>Review history</button></div>
    {state.inbox?.blocked && <p className="pr-warning pr-blocked" role="status"><Ticked text={state.inbox.blocked} /></p>}
    {!state.inbox?.blocked && (state.error || state.inbox?.error) && <p className="pr-error" role="status">{state.error || state.inbox?.error}</p>}
    <div className="pr-sidebar-list">
      <GroupToggle title="Needs your review" count={count(state.inbox?.pulls)} collapsed={state.collapsed} onToggle={() => state.setPreference("collapsed", !state.collapsed)} />
      {!state.collapsed && <PullRows pulls={shown.requested} kind="requested" empty={connected ? "Nothing waiting for your review." : "Connect with gh auth login, then refresh."} />}
      {shown.reviewed.length > 0 && <>
        <GroupToggle title="You reviewed" count={shown.reviewed.length} collapsed={!!state.groupsCollapsed["you-reviewed"]} onToggle={() => state.toggleGroup("you-reviewed")} />
        {!state.groupsCollapsed["you-reviewed"] && <PullRows pulls={shown.reviewed} kind="reviewed" />}
      </>}
      <GroupToggle title="Your pull requests" count={count(state.inbox?.mine)} collapsed={state.mineCollapsed} onToggle={() => state.setPreference("mineCollapsed", !state.mineCollapsed)} />
      {!state.mineCollapsed && shown.groups.map((g) => <div key={g.key} className="pr-subgroup">
        <GroupToggle title={g.title} count={g.pulls.length} collapsed={!!state.groupsCollapsed[g.key]} onToggle={() => state.toggleGroup(g.key)} sub />
        {!state.groupsCollapsed[g.key] && <PullRows pulls={g.pulls} kind="mine" />}
      </div>)}
      {!state.mineCollapsed && shown.groups.length === 0 && <p className="pr-muted pr-empty">{connected ? "You have no open pull requests." : "Connect with gh auth login, then refresh."}</p>}
    </div>
    <div className="pr-sync">{state.inbox?.account}{state.inbox?.last_synced && ` · synced ${new Date(state.inbox.last_synced).toLocaleTimeString()}`}</div>
  </section>;
}

/** Text with `quoted` commands set as code. */
function Ticked({ text }: { text: string }) {
  return <>{text.split("`").map((part, i) => i % 2 ? <code key={i}>{part}</code> : part)}</>;
}

function GroupToggle({ title, count, collapsed, onToggle, sub = false }: { title: string; count: number; collapsed: boolean; onToggle: () => void; sub?: boolean }) {
  return <button className={`btn small pr-group-toggle ${sub ? "sub" : ""}`} data-hint aria-expanded={!collapsed} onClick={onToggle}>{collapsed ? "▸" : "▾"} {title} <span className="badge">{count}</span></button>;
}

/** Who reviewed and who is asked to, on one line: three names at most, then "+N"; all of them in the tooltip. */
export function ReviewerLine({ pull }: { pull: PullRequest }) {
  const entries = reviewerEntries(pull);
  if (!entries.length) return null;
  const more = Math.max(0, entries.length - 3);
  return <span className="pr-reviewers" title={entries.map((e) => e.describe).join("\n")}>
    {entries.slice(0, 3).map((e) => <span key={`${e.bot}${e.name}`} className={`pr-reviewer ${e.bot ? "bot" : ""} ${e.pending ? "pending" : ""}`}>
      <span className="name">{e.name}</span> <span className={`mark ${e.tone ?? ""}`}>{e.mark}{e.stale && "↻"}</span>
    </span>)}
    {more > 0 && <span className="pr-reviewer more">+{more}</span>}
  </span>;
}

function PullRows({ pulls, kind, empty }: { pulls: PullRequest[]; kind: "requested" | "reviewed" | "mine"; empty?: string }) {
  const selected = useStore((s) => s.prSelection);
  const reviews = useReviews((s) => s.inbox?.reviews);
  const rules = useStore((s) => s.settings.pullFilters);
  const mine = kind === "mine";
  return <>
    {pulls.map((pull) => {
      const review = reviews?.find((r) => r.pull.id === pull.id && r.status !== "discarded");
      const rule = pullFilter(pull, rules);
      const again = kind === "requested" && isRerequested(pull);
      const changed = kind === "reviewed" && !!pull.my_review && isStale(pull.my_review, pull.head_sha);
      // A pre-review from before the new request covers the previous round, not this one.
      const earlier = again && review && Date.parse(review.created_at) < Date.parse(pull.review_requested_at!);
      return <div key={pull.id} className={`pr-sidebar-row ${selected?.id === pull.id ? "selected" : ""} ${isPullHidden(pull, rules) ? "muted" : ""} ${again ? "rerequested" : ""}`}>
        <button className="pr-row-main" data-hint onClick={() => openPull(pull)} title={pull.title}>
          <span className="title">{pull.draft ? "◌" : "⑂"} {pull.title}</span>
          <span className="sub">{pull.repo}#{pull.number}{!mine && ` · ${pull.author}`}{rule && ` · hidden by ${rule}`}</span>
          <ReviewerLine pull={pull} />
          <span className="pr-status">
            {changed && <span className="chip new" title="New commits since your review">↻ new commits</span>}
            <PullSessionCount pull={pull} />
            {mine && pull.unanswered_threads > 0 && <span className="chip err" title="Open review threads where someone else had the last word">{pull.unanswered_threads} unanswered</span>}
            {[...(mine ? [] : reviewRound(pull)), ...pullStatus(pull), ...mergeStatus(pull)].map((s) => <span key={s.label} className={`chip ${s.tone ?? ""}`}>{s.label}</span>)}
          </span>
          {review && <span className={`chip ${review.status === "failed" ? "err" : ""}`}>{review.status}{earlier ? " · earlier round" : review.reviewed_sha && review.reviewed_sha !== pull.head_sha ? " · PR changed" : ""}</span>}
        </button>
        <button className="btn small" data-hint title={pull.hidden ? "Restore PR" : "Hide PR"} onClick={() => void hidePull(pull, !pull.hidden).catch(report)}>{pull.hidden ? "↶" : "×"}</button>
      </div>;
    })}
    {empty && pulls.length === 0 && <p className="pr-muted pr-empty">{empty}</p>}
  </>;
}
