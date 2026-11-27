// The PR page in a main-area tab (`pr` view), laid out like GitHub's: title and state, then the
// Conversation / Commits / Checks / Files changed tabs, with the reviewers, assignees, labels,
// milestone and Aura sessions in a column on the right. Read-only, apart from the merge box,
// which is the cards' own "Squash and merge".
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import type { ViewProps } from "@aura/mod-sdk/ui";
import { diff, ExternalLink, exactTime, Markdown, timeAgo, useStore } from "@aura/host";
import type { Label, PageCheck, PageFile, PrPage, TimelineItem } from "../../shared/page";
import type { PrState, PrStatus, Reviewer } from "../../shared/types";
import { getCtx } from "../ctx";
import { ago, reviewSummary, BLOCKER_LABEL, CHECKS_LABEL, checkCounts, checksTone, readinessTone, REVIEW_LABEL, reviewTone, STATE_LABEL } from "../labels";
import { SquashMerge } from "../SquashMerge";
import { useNow } from "../usePullStatus";
import { githubMarkdown } from "./githubMarkdown";
import { filesKey, usePrFiles, usePrPage, useWindowVisible } from "./usePrPage";

export const PAGE_VIEW = "pr";

/** What a `pr` tab is opened with; `key` (the URL) makes the same PR focus its own tab. */
export interface PageProps {
  key: string;
  title: string;
  repo: string;
  number: number;
  url: string;
}

/** Open the PR's page in a main-area tab of its own (not the preview tab), or show the one already open. */
export function openPrPage(pr: { repo: string; number: number; url: string; title: string }): void {
  const props: PageProps = { key: pr.url, title: `#${pr.number} ${pr.title}`, repo: pr.repo, number: pr.number, url: pr.url };
  // A host before the option (Aura 0.4.0) ignores it and shows the page in the preview tab.
  getCtx()?.openView(PAGE_VIEW, props, { preview: false });
}

/** Changed files with more lines than this start folded, behind "Load diff". */
export const LARGE_DIFF = 400;
/** Diff lines shown at once on the Files tab; further files wait behind "Load diff". */
export const DIFF_BUDGET = 3_000;

type Tab = "conversation" | "commits" | "checks" | "files";
const TABS: Tab[] = ["conversation", "commits", "checks", "files"];
const TAB_LABEL: Record<Tab, string> = { conversation: "Conversation", commits: "Commits", checks: "Checks", files: "Files changed" };

export function PrPageView({ props, active = true }: ViewProps<PageProps>) {
  const { page, error, loading, reload } = usePrPage(props.repo, props.number, active);
  const [tab, setTab] = useState<Tab>("conversation");
  // Refresh and Retry read the files again; a new base or head is another comparison.
  const [filesVersion, setFilesVersion] = useState(0);
  const visible = useWindowVisible();
  const key = page ? filesKey(page.repo, page.number, page.baseSha, page.headSha, filesVersion) : null;
  const { files, error: filesError } = usePrFiles(props.repo, props.number, key, tab === "files" && active && visible);
  const refresh = async () => {
    setFilesVersion((v) => v + 1);
    await reload();
  };
  const now = useNow(5_000);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ conversation: null, commits: null, checks: null, files: null });

  if (!page) {
    return (
      <div className="prs-page">
        <p className={error ? "err-text" : "prs-muted"} role={error ? "alert" : "status"}>
          {error ? `Could not read ${props.repo}#${props.number}: ${error}` : `Loading ${props.repo}#${props.number}…`}
        </p>
        {error && <button className="btn small" onClick={() => void reload()}>Try again</button>}
      </div>
    );
  }

  const counts: Record<Tab, number> = { conversation: page.commentCount, commits: page.commitCount, checks: page.checks.length, files: page.changedFiles };
  const moveTab = (e: KeyboardEvent, from: Tab) => {
    const i = TABS.indexOf(from);
    const to = e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length] : e.key === "ArrowLeft" ? TABS[(i + TABS.length - 1) % TABS.length]
      : e.key === "Home" ? TABS[0] : e.key === "End" ? TABS[TABS.length - 1] : null;
    if (!to) return;
    e.preventDefault();
    setTab(to);
    tabRefs.current[to]?.focus();
  };

  return (
    <div className="prs-page">
      <Header page={page} now={now} loading={loading} reload={refresh} />
      {error && <p className="err-text prs-wrap" role="alert">Could not update: {error}</p>}
      <div className="prs-page-tabs" role="tablist" aria-label="Pull request">
        {TABS.map((t) => (
          <button key={t} ref={(el) => void (tabRefs.current[t] = el)} role="tab" id={`prs-tab-${t}`} aria-selected={tab === t} aria-controls={`prs-panel-${t}`}
            tabIndex={tab === t ? 0 : -1} className={clsx("prs-page-tab", tab === t && "prs-active")} onClick={() => setTab(t)} onKeyDown={(e) => moveTab(e, t)}>
            {TAB_LABEL[t]} <span className="prs-count">{counts[t]}</span>
          </button>
        ))}
      </div>
      <div className="prs-page-body" role="tabpanel" id={`prs-panel-${tab}`} aria-labelledby={`prs-tab-${tab}`}>
        {tab === "conversation" && (
          <>
            <div className="prs-page-main">
              <Conversation page={page} reload={reload} />
            </div>
            <Sidebar page={page} />
          </>
        )}
        {tab === "commits" && <div className="prs-page-main"><Commits page={page} /></div>}
        {tab === "checks" && <div className="prs-page-main"><Checks checks={page.checks} /></div>}
        {tab === "files" && (
          <div className="prs-page-main">
            <Files page={page} files={files} error={filesError} comparison={key!} retry={() => setFilesVersion((v) => v + 1)} />
          </div>
        )}
      </div>
    </div>
  );
}

function StatePill({ state }: { state: PrState }) {
  return <span className={clsx("prs-pill", `prs-pill-${state}`)}>{STATE_LABEL[state]}</span>;
}

function Header({ page, now, loading, reload }: { page: PrPage; now: number; loading: boolean; reload: () => Promise<void> }) {
  const merged = page.status.state === "merged";
  const head = page.headRepo !== page.repo ? `${page.headRepo.split("/")[0]}:${page.head}` : page.head;
  const copy = () => void navigator.clipboard.writeText(page.head).then(() => getCtx()?.toast(`Copied ${page.head}`));
  return (
    <header className="prs-page-head">
      <div className="prs-page-titlerow">
        <h1 className="prs-page-title">{page.title} <span className="prs-page-number">#{page.number}</span></h1>
        <div className="prs-page-actions">
          <span className="prs-updated" title={exactTime(page.readAt)}>updated {ago(page.readAt, now)}</span>
          <button className="btn small" aria-label="Refresh" title="Refresh" disabled={loading} onClick={() => void reload()}>{loading ? "…" : "↻"}</button>
          <ExternalLink href={page.url} className="btn small">Open on GitHub</ExternalLink>
        </div>
      </div>
      <div className="prs-page-sub">
        <StatePill state={page.status.state} />
        <span className="prs-wrap">
          <strong>{page.author}</strong> {merged ? "merged" : "wants to merge"} {page.commitCount} commit{page.commitCount === 1 ? "" : "s"} into{" "}
          <code className="prs-ref">{page.base}</code> from <code className="prs-ref">{head}</code>
          <button className="prs-copy" aria-label={`Copy branch name ${page.head}`} title="Copy branch name" onClick={copy}>⧉</button>
        </span>
      </div>
    </header>
  );
}

function Box({ author, at, verb = "commented", url, children, badge }: { author: string; at: string; verb?: string; url?: string; children: ReactNode; badge?: ReactNode }) {
  return (
    <article className="prs-box" aria-label={`${author} ${verb}`}>
      <header className="prs-box-head">
        <span className="prs-avatar" aria-hidden>{author.charAt(0).toUpperCase()}</span>
        <span className="prs-wrap"><strong>{author}</strong> {verb} {url ? <ExternalLink href={url} title={exactTime(at)} className="prs-time">{timeAgo(at)}</ExternalLink> : <span title={exactTime(at)}>{timeAgo(at)}</span>}</span>
        {badge}
      </header>
      <div className="prs-box-body">{children}</div>
    </article>
  );
}

const REVIEW_VERB: Record<string, string> = { APPROVED: "approved these changes", CHANGES_REQUESTED: "requested changes", COMMENTED: "reviewed", DISMISSED: "reviewed (dismissed)" };

function Conversation({ page, reload }: { page: PrPage; reload: () => Promise<void> }) {
  return (
    <>
      <Box author={page.author} at={page.createdAt} url={page.url}>
        {page.body.trim() ? <Markdown text={githubMarkdown(page.body)} /> : <p className="prs-muted">No description provided.</p>}
      </Box>
      <ol className="prs-timeline" aria-label="Timeline">
        {page.timeline.map((item, i) => <li key={i}><Event item={item} /></li>)}
      </ol>
      {!page.complete && <p className="prs-muted">Some of the history is not shown here; see it on GitHub.</p>}
      {/* Merges are offered only for the head this page shows (readPage reads both as one snapshot). */}
      <MergeBox status={page.status} offer={page.headSha === page.status.merge.headSha} onMerged={() => void reload()} />
    </>
  );
}

function LabelChip({ label }: { label: Label }) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(label.color.slice(i, i + 2), 16) / 255);
  // Text black or white, whichever reads better on the label's own colour.
  const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
  return <span className="prs-label" style={{ background: `#${label.color}`, color: light ? "#1b1b21" : "#ffffff" }}>{label.name}</span>;
}

function Line({ children, at }: { children: ReactNode; at: string }) {
  return (
    <div className="prs-event">
      <span className="prs-event-dot" aria-hidden />
      <span className="prs-wrap">{children} <span className="prs-muted" title={exactTime(at)}>{timeAgo(at)}</span></span>
    </div>
  );
}

function Event({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case "comment":
      return <Box author={item.author} at={item.at} url={item.url}><Markdown text={githubMarkdown(item.body)} /></Box>;
    case "review": {
      const tone = item.state === "APPROVED" ? "prs-ok" : item.state === "CHANGES_REQUESTED" ? "prs-err" : "";
      const badge = <span className={clsx("prs-badge", tone)}>{REVIEW_LABEL[item.state as keyof typeof REVIEW_LABEL] ?? item.state}</span>;
      return (
        <Box author={item.author} at={item.at} url={item.url} verb={REVIEW_VERB[item.state] ?? "reviewed"} badge={badge}>
          {item.body.trim() && <Markdown text={githubMarkdown(item.body)} />}
          {item.moreComments > 0 && (
            <p className="prs-muted">{item.moreComments} more comment{item.moreComments === 1 ? "" : "s"} in this review: <ExternalLink href={item.url} className="prs-link-inline">see them on GitHub</ExternalLink></p>
          )}
          {item.comments.map((c, i) => (
            <div key={i} className="prs-thread">
              <div className="prs-thread-file mono">{c.path}{c.line !== null && <span className="prs-muted">:{c.line}</span>}</div>
              {c.snippet.length > 0 && (
                <pre className="prs-snippet mono">{c.snippet.map((l, j) => (
                  <div key={j} className={l.startsWith("+") ? "diff-add" : l.startsWith("-") ? "diff-del" : undefined}>{l || " "}</div>
                ))}</pre>
              )}
              <div className="prs-thread-comment"><strong>{c.author}</strong> <Markdown text={githubMarkdown(c.body)} /></div>
            </div>
          ))}
        </Box>
      );
    }
    case "commit":
      return <Line at={item.at}><strong>{item.author}</strong> added a commit: <ExternalLink href={item.url} className="prs-link-inline">{item.message}</ExternalLink> <code className="prs-sha">{item.sha}</code></Line>;
    case "force_push":
      return <Line at={item.at}><strong>{item.actor}</strong> force-pushed the branch from <code className="prs-sha">{item.before}</code> to <code className="prs-sha">{item.after}</code></Line>;
    case "review_requested":
      return <Line at={item.at}><strong>{item.actor}</strong> requested a review from <strong>{item.reviewer}</strong></Line>;
    case "labeled":
    case "unlabeled":
      return <Line at={item.at}><strong>{item.actor}</strong> {item.kind === "labeled" ? "added" : "removed"} the <LabelChip label={item.label} /> label</Line>;
    case "merged":
      return <Line at={item.at}><strong>{item.actor}</strong> merged commit <code className="prs-sha">{item.sha}</code> into <code className="prs-ref">{item.base}</code></Line>;
    case "closed":
      return <Line at={item.at}><strong>{item.actor}</strong> closed this</Line>;
    case "reopened":
      return <Line at={item.at}><strong>{item.actor}</strong> reopened this</Line>;
    case "ready_for_review":
      return <Line at={item.at}><strong>{item.actor}</strong> marked this pull request as ready for review</Line>;
    case "converted_to_draft":
      return <Line at={item.at}><strong>{item.actor}</strong> marked this pull request as draft</Line>;
  }
}

/** GitHub's merge box: reviews, checks and readiness, and the cards' Squash and merge. */
function MergeBox({ status, offer, onMerged }: { status: PrStatus; offer: boolean; onMerged: () => void }) {
  if (status.state === "merged" || status.state === "closed") {
    return (
      <section className="prs-mergebox" aria-label="Merge">
        <p className="prs-mergebox-row"><span className={clsx("dot prs-dot", status.state === "merged" ? "ok" : "err")} aria-hidden />
          <strong>{status.state === "merged" ? "Pull request successfully merged and closed" : "This pull request is closed"}</strong></p>
      </section>
    );
  }
  const r = status.reviewers;
  const review = reviewSummary(status);
  const counts = checkCounts(status.checks);
  return (
    <section className="prs-mergebox" aria-label="Merge">
      <p className="prs-mergebox-row"><span className={clsx("dot prs-dot", review.tone)} aria-hidden /><span className="prs-wrap"><strong>{review.text}</strong>
        {r.pending.length > 0 && <span className="prs-muted"> · waiting on {r.pending.map((x) => x.name).join(", ")}</span>}</span></p>
      <p className="prs-mergebox-row"><span className={clsx("dot prs-dot", checksTone(status.checks.state))} aria-hidden /><span className="prs-wrap"><strong>{CHECKS_LABEL[status.checks.state]}</strong>
        {counts && <span className="prs-muted"> · {counts}</span>}</span></p>
      {status.readiness && (
        <p className="prs-mergebox-row"><span className={clsx("dot prs-dot", readinessTone(status.readiness))} aria-hidden />
          <span className="prs-wrap"><strong>{status.readiness.ready ? "Ready to merge" : "Not ready:"}</strong> {status.readiness.reasons.map((x) => BLOCKER_LABEL[x]).join(" · ")}</span></p>
      )}
      {offer ? <SquashMerge status={status} onMerged={onMerged} /> : <p className="prs-muted">New commits were pushed — refresh to review them</p>}
    </section>
  );
}

function Commits({ page }: { page: PrPage }) {
  return (
    <ul className="prs-rows" aria-label="Commits">
      {page.commits.map((c) => (
        <li key={c.sha} className="prs-row">
          <span className="prs-grow prs-wrap"><ExternalLink href={c.url} className="prs-link-inline">{c.message}</ExternalLink>
            <span className="prs-muted prs-row-sub"><strong>{c.author}</strong> committed <span title={exactTime(c.at)}>{timeAgo(c.at)}</span></span></span>
          <ExternalLink href={c.url} className="prs-sha mono" aria-label={`Commit ${c.short}`}>{c.short}</ExternalLink>
        </li>
      ))}
      {page.commits.length < page.commitCount && <li className="prs-row prs-muted">{page.commitCount - page.commits.length} more on GitHub</li>}
    </ul>
  );
}

const duration = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
const CHECK_TONE: Record<PageCheck["state"], string> = { passing: "prs-ok", failing: "prs-err", pending: "prs-warn", skipped: "" };

function Checks({ checks }: { checks: PageCheck[] }) {
  if (checks.length === 0) return <p className="prs-muted">No checks on the head commit.</p>;
  return (
    <ul className="prs-rows" aria-label="Checks">
      {checks.map((c, i) => (
        <li key={`${c.workflow}/${c.name}/${i}`} className="prs-row">
          <span className={clsx("prs-word prs-check-label", CHECK_TONE[c.state])}>{c.label}</span>
          <span className="prs-grow prs-wrap">{c.workflow && <span className="prs-muted">{c.workflow} / </span>}{c.name}</span>
          {c.seconds !== null && <span className="prs-muted">{duration(c.seconds)}</span>}
          {c.url && <ExternalLink href={c.url} className="prs-link-inline" aria-label={`Details of ${c.name}`}>Details</ExternalLink>}
        </li>
      ))}
    </ul>
  );
}

function Files({ page, files, error, comparison, retry }: { page: PrPage; files: PageFile[] | null; error: string | null; comparison: string; retry: () => void }) {
  if (error) {
    return (
      <p className="prs-file-note">
        <span className="err-text" role="alert">Could not read the files: {error}</span> <button className="btn small" onClick={retry}>Retry</button>
      </p>
    );
  }
  if (!files) return <p className="prs-muted" role="status">Loading files…</p>;
  // Shown at once: files up to LARGE_DIFF lines each, while the total stays within DIFF_BUDGET.
  let budget = DIFF_BUDGET;
  const shown = files.map((f) => {
    const lines = f.additions + f.deletions;
    const now = lines <= LARGE_DIFF && lines <= budget;
    if (now) budget -= lines;
    return now;
  });
  return (
    <>
      {files.length < page.changedFiles && (
        <p className="prs-files-note" role="note">
          Showing {files.length} of {page.changedFiles} changed files; GitHub lists no more here.{" "}
          <ExternalLink href={`${page.url}/files`} className="prs-link-inline">See all files on GitHub</ExternalLink>
        </p>
      )}
      <p className="prs-files-summary">
        {files.length} file{files.length === 1 ? "" : "s"} changed <span className="prs-ok">+{page.additions}</span> <span className="prs-err">−{page.deletions}</span>
      </p>
      <ul className="prs-file-list" aria-label="Changed files">
        {files.map((f) => (
          <li key={f.path}><a href={`#prs-file-${encodeURIComponent(f.path)}`} className="prs-link-inline mono">{f.path}</a>
            <span className="prs-ok"> +{f.additions}</span><span className="prs-err"> −{f.deletions}</span></li>
        ))}
      </ul>
      {/* Keyed by the comparison: a new base or head (a refresh) starts each file folded or open anew. */}
      {files.map((f, i) => <FileDiff key={`${comparison}\n${f.path}`} file={f} show={shown[i]} filesUrl={`${page.url}/files`} />)}
    </>
  );
}

function FileDiff({ file, show, filesUrl }: { file: PageFile; show: boolean; filesUrl: string }) {
  const large = file.additions + file.deletions > LARGE_DIFF;
  const [open, setOpen] = useState(!large);
  const [load, setLoad] = useState(show);
  return (
    <section className="prs-file" id={`prs-file-${encodeURIComponent(file.path)}`} aria-label={file.path}>
      <button className="prs-file-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={clsx("prs-chevron", open && "prs-open")} aria-hidden />
        <span className="prs-grow prs-wrap mono">{file.previous ? `${file.previous} → ${file.path}` : file.path}</span>
        {file.status !== "modified" && <span className="prs-badge">{file.status}</span>}
        <span className="prs-ok">+{file.additions}</span><span className="prs-err">−{file.deletions}</span>
      </button>
      {open && (
        file.patch === null ? <p className="prs-muted prs-file-note">GitHub shows no diff for this file (binary or too large). <ExternalLink href={filesUrl} className="prs-link-inline">See it on GitHub</ExternalLink></p>
        : !load ? <p className="prs-file-note"><button className="btn small" onClick={() => setLoad(true)}>Load diff</button> <span className="prs-muted">{file.additions + file.deletions} changed lines</span></p>
        : <Patch path={file.path} patch={file.patch} />
      )}
    </section>
  );
}

/** A file's patch as a unified diff table, with Aura's diff colours. */
function Patch({ path, patch }: { path: string; patch: string }) {
  const hunks = useMemo(() => diff.parseUnifiedDiff(`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patch}`)[0]?.hunks ?? [], [path, patch]);
  return (
    <div className="diff-view mono prs-patch">
      <table className="diff-table">
        <tbody>
          {hunks.map((h, hi) => (
            <Fragment key={hi}>
              {h.lines.map((l, i) => (
                <tr key={i} className={l.kind === "add" ? "diff-add" : l.kind === "del" ? "diff-del" : l.kind === "hunk" ? "diff-hunk" : undefined}>
                  <td className="ln">{l.oldNo ?? ""}</td>
                  <td className="ln">{l.newNo ?? ""}</td>
                  <td className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</td>
                  <td className="code">{l.text}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sidebar({ page }: { page: PrPage }) {
  const people: Reviewer[] = [...page.status.reviewers.reviewed, ...page.status.reviewers.pending];
  return (
    <aside className="prs-page-side" aria-label="Details">
      <SideBlock title="Reviewers">
        {people.length === 0 ? <p className="prs-muted">No reviews</p> : people.map((r) => {
          const label = r.state === "PENDING" && r.previous ? "Re-requested" : REVIEW_LABEL[r.state];
          const tone = reviewTone(r.state);
          return (
            <div key={`${r.kind}:${r.name}`} className="prs-person prs-side-row">
              <span className={clsx("prs-avatar", r.kind === "team" && "prs-avatar-team")} aria-hidden>{r.name.replace(/^.*\//, "").charAt(0).toUpperCase()}</span>
              <span className="prs-login">{r.name}</span>
              <span className={clsx("prs-word", tone && `prs-${tone}`)}>{label}</span>
            </div>
          );
        })}
      </SideBlock>
      <SideBlock title="Assignees">
        {page.assignees.length === 0 ? <p className="prs-muted">No one assigned</p> : page.assignees.map((a) => <div key={a} className="prs-side-row">{a}</div>)}
      </SideBlock>
      <SideBlock title="Labels">
        {page.labels.length === 0 ? <p className="prs-muted">None yet</p> : <div className="prs-labels">{page.labels.map((l) => <LabelChip key={l.name} label={l} />)}</div>}
      </SideBlock>
      <SideBlock title="Milestone">
        {page.milestone ? <ExternalLink href={page.milestone.url} className="prs-link-inline">{page.milestone.title}</ExternalLink> : <p className="prs-muted">No milestone</p>}
      </SideBlock>
      <LinkedSessions url={page.url} />
    </aside>
  );
}

function SideBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="prs-side-block" aria-label={title}>
      <h2 className="prs-side-title">{title}</h2>
      {children}
    </section>
  );
}

/** The Aura sessions that worked on the PR (linking, mentioning or on its branch); a click selects one. */
function LinkedSessions({ url }: { url: string }) {
  const [ids, setIds] = useState<string[] | null>(null);
  const sessions = useStore((st) => st.sessions);
  useEffect(() => {
    let current = true;
    getCtx()?.rpc<string[]>("pulls.sessions", { url }).then((x) => current && setIds(x), () => current && setIds([]));
    return () => {
      current = false;
    };
  }, [url]);
  const known = (ids ?? []).filter((id) => sessions[id]);
  return (
    <SideBlock title="Linked sessions">
      {ids === null ? <p className="prs-muted">Loading…</p> : known.length === 0 ? <p className="prs-muted">None in Aura</p> : known.map((id) => (
        <button key={id} className="prs-source prs-side-row" onClick={() => useStore.getState().select(id)}>{sessions[id].title}</button>
      ))}
    </SideBlock>
  );
}
