// "Pull requests" in the Inspector: one compact card per PR of the selected session and its
// workers, with state, merge readiness, checks and reviewers.
import { useId, useState } from "react";
import clsx from "clsx";
import type { InspectorSectionProps } from "@aura/mod-sdk/ui";
import { ExternalLink, useStore } from "@aura/host";
import type { PrEntry, PrSource, PrStatus, Reviewer } from "../shared/types";
import { ago, BLOCKER_LABEL, CHECKS_LABEL, checkCounts, checksTone, readinessTone, REVIEW_LABEL, reviewTone, STATE_LABEL } from "./labels";
import { useNow, usePullStatus } from "./usePullStatus";

export function PrStatusSection({ session }: InspectorSectionProps) {
  const { view, error, refreshing, refresh } = usePullStatus(session.id);
  const now = useNow(5_000);
  // Hidden until the session tree has a PR: most sessions never open one.
  if (!view || view.pulls.length === 0) return null;
  const read = view.pulls.flatMap((p) => (p.readAt ? [p.readAt] : [])).sort()[0];
  return (
    <section className="inspector-section pr-status" aria-label="Pull request status">
      <h4 className="section-head">
        Pull requests
        <span className="with-btn">
          {read && <span className="dim pr-updated" title={new Date(read).toLocaleString()}>updated {ago(read, now)}</span>}
          <button className="btn small" data-command="pr-status.refresh" aria-label="Refresh pull request status" title="Refresh"
            disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "…" : "↻"}</button>
        </span>
      </h4>
      {view.blocked && (
        <p className="notice pr-blocked" role="status"><span className="dot warn" aria-hidden /> Not updating: {view.blocked}</p>
      )}
      {error && <p className="err-text pr-error" role="alert">Could not update: {error}</p>}
      {view.pulls.map((entry) => <PrCard key={entry.ref.url} entry={entry} rootId={session.id} now={now} />)}
    </section>
  );
}

function PrCard({ entry, rootId, now }: { entry: PrEntry; rootId: string; now: number }) {
  const { ref, status } = entry;
  const title = status?.title || `${ref.repo}#${ref.number}`;
  return (
    <article className={clsx("pr-card", status?.state)} aria-label={`Pull request #${ref.number}: ${title}`}>
      <div className="pr-title">
        {status && <span className={clsx("pr-state", status.state)}>{STATE_LABEL[status.state]}</span>}
        <ExternalLink href={ref.url} title={`${ref.repo}#${ref.number}\n${title}`} className="pr-link">{title}</ExternalLink>
      </div>
      <div className="pr-meta dim">
        <span>{ref.repo} #{ref.number}</span>
        <Sources sources={ref.sources} rootId={rootId} />
      </div>
      {!status && !entry.error && <p className="dim pr-line">Loading…</p>}
      {entry.error && (
        <p className="err-text pr-line" title={entry.error}>
          Could not read{entry.readAt ? `; showing ${ago(entry.readAt, now)}` : ""}: {entry.error}
        </p>
      )}
      {status && <PrBody status={status} />}
    </article>
  );
}

function Sources({ sources, rootId }: { sources: PrSource[]; rootId: string }) {
  const select = (id: string) => useStore.getState().select(id);
  return (
    <span className="pr-sources">
      from{" "}
      {sources.map((s, i) => (
        <span key={s.sessionId}>
          {i > 0 && ", "}
          {s.sessionId === rootId ? "this session" : (
            <button className="linkish pr-source" title={`Select ${s.title}`} onClick={() => select(s.sessionId)}>
              {s.worker ? "worker " : ""}{s.title}
            </button>
          )}
        </span>
      ))}
    </span>
  );
}

function PrBody({ status }: { status: PrStatus }) {
  return (
    <>
      {status.readiness && (
        <p className="pr-line pr-ready">
          <span className={clsx("dot", readinessTone(status.readiness))} aria-hidden />
          {status.readiness.ready ? (
            <strong>Ready to merge</strong>
          ) : (
            <span><strong>Not ready:</strong> {status.readiness.reasons.map((r) => BLOCKER_LABEL[r]).join(" · ")}</span>
          )}
        </p>
      )}
      <ChecksLine status={status} />
      <ReviewerGroup title="Reviewed" people={status.reviewers.reviewed} />
      {/* GitHub keeps requests open after a merge or close; nobody is still to review then. */}
      {(status.state === "open" || status.state === "draft") && <ReviewerGroup title="Still to review" people={status.reviewers.pending} />}
      {!status.reviewers.complete && <p className="dim pr-line pr-incomplete">Too many reviewers to list them all here</p>}
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
      <span className={clsx("dot", checksTone(checks.state))} aria-hidden />
      <span className="grow">{CHECKS_LABEL[checks.state]}{counts && <span className="dim"> · {counts}</span>}</span>
    </>
  );
  if (checks.open.length === 0) return <p className="pr-line pr-checks">{summary}</p>;
  return (
    <>
      <button className="pr-line pr-checks pr-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        <span className={clsx("pr-chevron", open && "open")} aria-hidden />
        {summary}
      </button>
      {open && (
        <ul id={listId} className="pr-check-list" aria-label="Failing and pending checks">
          {checks.open.map((c, i) => (
            <li key={`${c.name}-${i}`}>
              <span className={clsx("pr-check-state", c.state === "failing" ? "err" : "warn")}>{c.state === "failing" ? "Failing" : "Pending"}</span>
              {c.url ? <ExternalLink href={c.url} title={c.name} className="pr-check-name">{c.name}</ExternalLink> : <span className="pr-check-name" title={c.name}>{c.name}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ReviewerGroup({ title, people }: { title: string; people: Reviewer[] }) {
  if (people.length === 0) return null;
  return (
    <div className="pr-reviewers" role="group" aria-label={title}>
      <div className="pr-group-title dim">{title}</div>
      {people.map((r) => {
        const rerequested = r.state === "PENDING" && r.previous !== null;
        const label = rerequested ? "Re-requested" : REVIEW_LABEL[r.state];
        return (
          <div key={`${r.kind}:${r.name}`} className="pr-reviewer" title={rerequested ? `${r.name}: re-requested, previously ${REVIEW_LABEL[r.previous!].toLowerCase()}` : `${r.name}: ${label}`}>
            <span className={clsx("pr-avatar", r.kind)} aria-hidden>{r.name.replace(/^.*\//, "").charAt(0).toUpperCase()}</span>
            <span className="grow pr-reviewer-name">{r.name}{r.kind !== "user" && <span className="dim"> ({r.kind})</span>}</span>
            <span className={clsx("pr-review-state", reviewTone(r.state))}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}
