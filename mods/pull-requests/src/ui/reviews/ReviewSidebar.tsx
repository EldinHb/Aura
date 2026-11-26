import { useRef, type KeyboardEvent } from "react";
import type { SidebarSectionProps } from "@aura/mod-sdk/ui";
import type { PullRequest } from "@aura/github-client";
import { report } from "../ctx";
import { setFocus } from "../host";
import { openHistory, openPull, useNav } from "../nav";
import { usePrSettings } from "../settings";
import { PullSessionCount } from "./PullSessions";
import { sourceLabel } from "./ReviewEditor";
import { hidePull, isPullHidden, isRerequested, isStale, mergeStatus, pullFilter, pullStatus, reviewerEntries, reviewRound, useReviews, visiblePulls } from "./state";

/**
 * The pull request section of Aura's sidebar. While its list has focus it owns the plain
 * keys (`data-keynav`): j/k or the arrows open the next or previous PR, Enter moves to its
 * page, x hides or restores it, r refreshes.
 */
export function ReviewSidebar(_: Partial<SidebarSectionProps> = {}) {
  const state = useReviews();
  const rules = usePrSettings((s) => s.pullFilters);
  const listRef = useRef<HTMLDivElement>(null);
  if (state.hidden) return <button className="btn small pr-restore-section" data-command="pull-requests.reviews.toggle" onClick={() => state.setPreference("hidden", false)}>Show pull requests</button>;
  const shown = visiblePulls(state, rules);
  const connected = !!state.inbox?.account;
  const count = (pulls: PullRequest[] | undefined) => (pulls ?? []).filter((p) => !isPullHidden(p, rules)).length;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select")) return;
    const pulls = [...shown.review, ...shown.mine];
    const open = useNav.getState().pull;
    const at = open ? pulls.findIndex((p) => p.id === open.id && p.account === open.account) : -1;
    const step = (delta: number) => {
      const next = pulls[Math.max(0, Math.min(pulls.length - 1, at < 0 ? (delta > 0 ? 0 : pulls.length - 1) : at + delta))];
      if (!next) return;
      openPull(next);
      // Stay in the list, as stepping through the sidebar did.
      setFocus("sidebar");
      listRef.current?.focus();
    };
    if (e.key === "j" || e.key === "ArrowDown") step(1);
    else if (e.key === "k" || e.key === "ArrowUp") step(-1);
    else if (e.key === "Home" || e.key === "g") step(-pulls.length);
    else if (e.key === "End" || e.key === "G") step(pulls.length);
    // On a row's own button Enter clicks it; on the list it moves to the open PR's page.
    else if (e.key === "Enter" && at >= 0 && e.target === e.currentTarget) setFocus("main");
    else if (e.key === "x" && at >= 0) void hidePull(pulls[at], !pulls[at].hidden).catch(report);
    else if (e.key === "r") void state.refresh(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return <section className="pr-sidebar" aria-label="Pull requests">
    <div className="pr-sidebar-heading">
      <span className="section-title">Pull requests</span>
      <button className="btn small" title="Refresh pull requests" data-command="pull-requests.reviews.refresh" disabled={state.busy} onClick={() => void state.refresh(true)}>↻</button>
      <button className="btn small" title="Hide section" data-command="pull-requests.reviews.toggle" onClick={() => state.setPreference("hidden", true)}>×</button>
    </div>
    <div className="pr-sidebar-actions"><button className="btn small" data-command="pull-requests.reviews.hidden" onClick={() => state.setPreference("showHidden", !state.showHidden)}>{state.showHidden ? "Hide hidden" : "Show hidden"}</button><button className="btn small" data-command="pull-requests.reviews.history" onClick={openHistory}>Review history</button></div>
    {state.inbox?.blocked && <p className="pr-warning pr-blocked" role="status"><Ticked text={state.inbox.blocked} /></p>}
    {!state.inbox?.blocked && (state.error || state.inbox?.error) && <p className="pr-error" role="status">{state.error || state.inbox?.error}</p>}
    <div className="pr-sidebar-list" ref={listRef} data-keynav tabIndex={0} onKeyDown={onKeyDown}>
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
  const selected = useNav((s) => s.pull);
  const reviews = useReviews((s) => s.inbox?.reviews);
  const rules = usePrSettings((s) => s.pullFilters);
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
          {review && <span className={`chip ${review.status === "failed" ? "err" : ""}`} title={sourceLabel(review) ?? undefined}>{review.status}{earlier ? " · earlier round" : review.reviewed_sha && review.reviewed_sha !== pull.head_sha ? " · PR changed" : ""}</span>}
        </button>
        <button className="btn small" data-hint title={pull.hidden ? "Restore PR" : "Hide PR"} onClick={() => void hidePull(pull, !pull.hidden).catch(report)}>{pull.hidden ? "↶" : "×"}</button>
      </div>;
    })}
    {empty && pulls.length === 0 && <p className="pr-muted pr-empty">{empty}</p>}
  </>;
}
