// "Pull requests" in the Inspector: one compact card per open PR of the selected session and its
// workers (state, merge readiness, checks, reviewers), and the merged and closed ones folded away.
// Every class is `prs-` prefixed: mods' stylesheets share one page, and pull-requests owns `pr-`.
import { Fragment, useId, useState } from "react";
import clsx from "clsx";
import type { InspectorSectionProps } from "@aura/mod-sdk/ui";
import { ExternalLink, useStore } from "@aura/host";
import type { PrEntry, PrSource, PrState, PrStatus, Reviewer } from "../shared/types";
import { getCtx } from "./ctx";
import { ago, BLOCKER_LABEL, CHECKS_LABEL, checkCounts, checksTone, readinessTone, REVIEW_LABEL, reviewTone, STATE_LABEL } from "./labels";
import { splitPulls, updatedAt } from "./order";
import { LinkForm, unlink } from "./LinkPr";
import { SquashMerge } from "./SquashMerge";
import { openPrPage } from "./page/PrPageView";
import { useNow, usePullStatus } from "./usePullStatus";

/** `ctx.storage` key: whether "Merged & closed" is unfolded. */
export const DONE_OPEN_KEY = "doneExpanded";

export function PrStatusSection({ session }: InspectorSectionProps) {
  const { view, error, refreshing, refresh } = usePullStatus(session.id);
  const now = useNow(5_000);
  const [linking, setLinking] = useState(false);
  // Hidden until the session tree has a PR: most sessions never open one.
  if (!view || view.pulls.length === 0) return null;
  const read = updatedAt(view.pulls);
  const { active, done } = splitPulls(view.pulls);
  return (
    <section className="inspector-section prs-section" aria-label="Pull request status">
      <div className="prs-head">
        <h4>Pull requests</h4>
        <div className="prs-head-meta">
          {read && <span className="prs-updated" title={new Date(read).toLocaleString()}>updated {ago(read, now)}</span>}
          <button className="btn small prs-refresh" data-command="pr-status.link" title="Link a pull request to this session" aria-expanded={linking}
            onClick={() => setLinking(!linking)}>Link PR…</button>
          <button className="btn small prs-refresh" data-command="pr-status.refresh" aria-label="Refresh pull request status" title="Refresh"
            disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "…" : "↻"}</button>
        </div>
      </div>
      {linking && <LinkForm sessionId={session.id} done={(linked) => {
        setLinking(false);
        if (linked) void refresh();
      }} />}
      {view.blocked && (
        <p className="notice prs-note" role="status"><span className="dot warn" aria-hidden /> <span>Not updating: {view.blocked}</span></p>
      )}
      {error && <p className="err-text prs-note" role="alert">Could not update: {error}</p>}
      {active.length > 0 && (
        <div className="prs-cards">
          {active.map((entry) => (
            <PrCard key={entry.ref.url} entry={entry} rootId={session.id} now={now} onMerged={() => void refresh()} explained={!!view.blocked || !!error}
              onUnlink={() => void unlink(entry.ref).then(refresh)} />
          ))}
        </div>
      )}
      {done.length > 0 && <DoneGroup pulls={done} />}
    </section>
  );
}

function StateChip({ state }: { state: PrState }) {
  return <span className={clsx("prs-chip", `prs-chip-${state}`)}>{STATE_LABEL[state]}</span>;
}

/** `explained`: the section already says why it is not updating, so a card does not repeat it. */
function PrCard({ entry, rootId, now, onMerged, explained, onUnlink }: {
  entry: PrEntry; rootId: string; now: number; onMerged: () => void; explained: boolean; onUnlink: () => void;
}) {
  const { ref, status } = entry;
  const title = status?.title || `${ref.repo}#${ref.number}`;
  return (
    <article className="prs-card" aria-label={`Pull request #${ref.number}: ${title}`}>
      <div className="prs-title">
        {status && <StateChip state={status.state} />}
        <button className="prs-link" title={`Open #${ref.number} in a tab\n${title}`}
          onClick={() => openPrPage({ repo: ref.repo, number: ref.number, url: ref.url, title })}>{title}</button>
        <ExternalLink href={ref.url} className="prs-github" aria-label={`Open #${ref.number} on GitHub`} title="Open on GitHub">↗</ExternalLink>
      </div>
      {/* Without data the title already is "repo#n". */}
      <div className="prs-meta-row">
        {status && <span className="prs-meta" title={`${ref.repo} #${ref.number}`}>{ref.repo} #{ref.number}</span>}
        <button className="prs-unlink" aria-label={`Unlink #${ref.number}`} title="Unlink: stop showing this pull request here" onClick={onUnlink}>Unlink</button>
      </div>
      <Sources sources={ref.sources} rootId={rootId} />
      {!status && !entry.error && <p className="prs-line prs-muted">Loading…</p>}
      {entry.error && !(explained && !status) && (
        <p className="err-text prs-line prs-wrap" title={entry.error}>
          Could not read{entry.readAt ? `; showing ${ago(entry.readAt, now)}` : ""}: {entry.error}
        </p>
      )}
      {status && <PrBody status={status} onMerged={onMerged} />}
    </article>
  );
}

const sourceName = (s: PrSource, rootId: string) => (s.sessionId === rootId ? "this session" : `${s.worker ? "worker " : ""}${s.title}`);

/**
 * Where the PR came from, on one line. Up to two sessions are named (a worker selects on click);
 * more are summed up ("this session + 3 workers") and listed when unfolded.
 */
function Sources({ sources, rootId }: { sources: PrSource[]; rootId: string }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const select = (id: string) => useStore.getState().select(id);
  const all = `from ${sources.map((s) => sourceName(s, rootId)).join(", ")}`;
  const pick = (s: PrSource) =>
    s.sessionId === rootId ? "this session" : (
      <button className="prs-source" title={`Select ${s.title}`} onClick={() => select(s.sessionId)}>{sourceName(s, rootId)}</button>
    );
  if (sources.length <= 2) {
    // A row, so a long worker name shrinks to an ellipsis instead of leaving the line.
    return (
      <div className="prs-sources prs-sources-row" title={all}>
        <span>from</span>
        {sources.map((s, i) => (
          <Fragment key={s.sessionId}>
            {pick(s)}
            {i < sources.length - 1 && <span className="prs-comma">,</span>}
          </Fragment>
        ))}
      </div>
    );
  }
  const own = sources.some((s) => s.sessionId === rootId);
  const workers = sources.length - (own ? 1 : 0);
  const summary = `${own ? "this session + " : ""}${workers} worker${workers === 1 ? "" : "s"}`;
  return (
    <>
      <div className="prs-sources prs-sources-row" title={all}>
        <span>from</span>
        <button className="prs-source" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>{summary}</button>
      </div>
      {open && (
        <ul id={listId} className="prs-source-list" aria-label="Sessions working on this pull request">
          {sources.map((s) => <li key={s.sessionId}>{pick(s)}</li>)}
        </ul>
      )}
    </>
  );
}

function PrBody({ status, onMerged }: { status: PrStatus; onMerged: () => void }) {
  return (
    <>
      {status.readiness && (
        <p className="prs-line">
          <span className={clsx("dot prs-dot", readinessTone(status.readiness))} aria-hidden />
          {status.readiness.ready ? (
            <strong className="prs-word prs-ok">Ready to merge</strong>
          ) : (
            <span className="prs-wrap">
              <strong className={clsx("prs-word", `prs-${readinessTone(status.readiness)}`)}>Not ready:</strong>{" "}
              {status.readiness.reasons.map((r) => BLOCKER_LABEL[r]).join(" · ")}
            </span>
          )}
        </p>
      )}
      <SquashMerge status={status} onMerged={onMerged} />
      <ChecksLine status={status} />
      <ReviewerGroup title="Reviewed" people={status.reviewers.reviewed} />
      {/* GitHub keeps requests open after a merge or close; nobody is still to review then. */}
      {(status.state === "open" || status.state === "draft") && <ReviewerGroup title="Still to review" people={status.reviewers.pending} />}
      {!status.reviewers.complete && <p className="prs-line prs-muted">Too many reviewers to list them all here</p>}
    </>
  );
}

function ChecksLine({ status }: { status: PrStatus }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { checks } = status;
  const counts = checkCounts(checks);
  const summary = (
    <>
      <span className={clsx("dot prs-dot", checksTone(checks.state))} aria-hidden />
      <span className="prs-grow prs-wrap">{CHECKS_LABEL[checks.state]}{counts && <span className="prs-muted"> · {counts}</span>}</span>
    </>
  );
  if (checks.open.length === 0) return <p className="prs-line">{summary}</p>;
  return (
    <>
      <button className="prs-line prs-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        <span className={clsx("prs-chevron", open && "prs-open")} aria-hidden />
        {summary}
      </button>
      {open && (
        <ul id={listId} className="prs-check-list" aria-label="Failing and pending checks">
          {checks.open.map((c, i) => (
            <li key={`${c.name}-${i}`}>
              <span className={clsx("prs-word", c.state === "failing" ? "prs-err" : "prs-warn")}>{c.state === "failing" ? "Failing" : "Pending"}</span>
              {c.url ? <ExternalLink href={c.url} title={c.name} className="prs-check-name">{c.name}</ExternalLink> : <span className="prs-check-name" title={c.name}>{c.name}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Reviewers as chips that wrap: avatar, login and state stay together. */
function ReviewerGroup({ title, people }: { title: string; people: Reviewer[] }) {
  if (people.length === 0) return null;
  return (
    <div className="prs-people" role="group" aria-label={title}>
      <div className="prs-group-title">{title}</div>
      <div className="prs-chips">
        {people.map((r) => {
          const rerequested = r.state === "PENDING" && r.previous !== null;
          const label = rerequested ? "Re-requested" : REVIEW_LABEL[r.state];
          return (
            <span key={`${r.kind}:${r.name}`} className="prs-person"
              title={rerequested ? `${r.name}: re-requested, previously ${REVIEW_LABEL[r.previous!].toLowerCase()}` : `${r.name}: ${label}`}>
              <span className={clsx("prs-avatar", r.kind === "team" && "prs-avatar-team")} aria-hidden>{r.name.replace(/^.*\//, "").charAt(0).toUpperCase()}</span>
              <span className="prs-login">{r.name}{r.kind !== "user" && <span className="prs-muted"> ({r.kind})</span>}</span>
              <span className={clsx("prs-word", reviewTone(r.state) && `prs-${reviewTone(r.state)}`)}>{label}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Merged and closed PRs: folded by default (remembered), one line each, linking to GitHub. */
function DoneGroup({ pulls }: { pulls: PrEntry[] }) {
  const [open, setOpen] = useState(() => getCtx()?.storage.get<boolean>(DONE_OPEN_KEY) === true);
  const listId = useId();
  const toggle = () => {
    setOpen(!open);
    getCtx()?.storage.set(DONE_OPEN_KEY, !open);
  };
  return (
    <div className="prs-done">
      <button className="prs-toggle prs-done-toggle" aria-expanded={open} aria-controls={listId} onClick={toggle}>
        <span className={clsx("prs-chevron", open && "prs-open")} aria-hidden />
        <span className="prs-grow">Merged &amp; closed ({pulls.length})</span>
      </button>
      {open && (
        <ul id={listId} className="prs-done-list" aria-label="Merged and closed pull requests">
          {pulls.map((e) => {
            const title = e.status?.title || `${e.ref.repo}#${e.ref.number}`;
            return (
              <li key={e.ref.url}>
                <ExternalLink href={e.ref.url} className="prs-done-row" title={`${e.ref.repo}#${e.ref.number}\n${title}`}>
                  {e.status && <StateChip state={e.status.state} />}
                  <span className="prs-done-title">{title}</span>
                  <span className="prs-muted prs-number">#{e.ref.number}</span>
                </ExternalLink>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
