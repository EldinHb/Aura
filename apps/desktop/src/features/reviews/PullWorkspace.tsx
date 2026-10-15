import { useCallback, useEffect, useState } from "react";
import type { PullRequest } from "../../gen";
import { useStore } from "../../state/store";
import { ExternalLink } from "../../components/ExternalLink";
import { normalizeDetail, type ProjectField, type ProjectItem, type PullDetail } from "../../lib/pulls";
import { Markdown } from "../../views/transcript/MarkdownView";
import { ReviewDiff } from "./ReviewDiff";
import { ReviewEditor } from "./ReviewEditor";
import { PullSessions } from "./PullSessions";
import { Avatar, Timeline } from "./Timeline";
import { commitCount } from "./conversation";
import { isRerequested, openPull, pullStatus, rpc, startReview, useReviews } from "./state";

type Options = { labels: { name: string }[]; assignees: { login: string }[]; milestones: { number: number; title: string }[] };

export function PullWorkspace() {
  const selected = useStore((s) => s.prSelection);
  const history = useStore((s) => s.reviewHistoryOpen);
  const reviewId = useReviews((s) => s.reviewId);
  const inbox = useReviews((s) => s.inbox);
  if (history) return <div className="pr-workspace" data-keynav><header className="pr-toolbar"><h2>Review history</h2></header><div className="pr-history">{inbox?.reviews.map((r) => <button key={r.id} className="pr-history-row" data-hint onClick={() => openPull(r.pull, r.id)}><strong>{r.pull.title}</strong><span>{r.pull.repo}#{r.pull.number} · {r.status} · {r.config.provider} · {new Date(r.created_at).toLocaleString()}</span></button>)}{!inbox?.reviews.length && <p className="pr-muted">No pre-reviews yet.</p>}</div></div>;
  if (!selected) return null;
  if (reviewId) return <ReviewEditor key={reviewId} id={reviewId} />;
  return <PullDetailView key={`${selected.account}:${selected.id}`} pull={selected} />;
}
function PullDetailView({ pull: initial }: { pull: PullRequest }) {
  const [detail, setDetail] = useState<PullDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("overview");
  const [diffVersion, setDiffVersion] = useState(0);
  const [diff, setDiff] = useState<{ diff: string; sha: string } | null>(null);
  const [comment, setComment] = useState("");
  const [options, setOptions] = useState<Options | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [merged, setMerged] = useState<MergeResult | null>(null);
  const inbox = useReviews((s) => s.inbox);
  const reviews = inbox?.reviews.filter((r) => r.pull.id === initial.id && r.pull.account === initial.account && r.status !== "discarded");
  const pull = detail?.pull ?? initial;
  const identity = { repo: initial.repo, number: initial.number, account: initial.account };
  const load = useCallback(async () => {
    setBusy(true);
    try { const data = await rpc<PullDetail>("pulls.get", { repo: initial.repo, number: initial.number, account: initial.account }); setDetail(normalizeDetail(data)); setError(null); setDiff(null); setDiffVersion((v) => v + 1); }
    catch (e) { setError(String(e)); try { const cached = await rpc<PullDetail>("pulls.cached", { id: initial.id, account: initial.account }); setDetail(normalizeDetail(cached)); } catch { /* retain the inbox snapshot */ } }
    finally { setBusy(false); }
  }, [initial.account, initial.id, initial.number, initial.repo]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let active = true;
    if (tab === "files" && !diff) rpc<{ diff: string; sha: string }>("pulls.diff", { repo: initial.repo, number: initial.number, account: initial.account }).then((value) => { if (active) setDiff(value); }).catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [tab, diff, diffVersion, initial.repo, initial.number, initial.account]);
  const mutate = async (method: string, params: object) => {
    setBusy(true); setError(null);
    try { await rpc(method, { ...identity, ...params }); await load(); return true; }
    catch (e) { setError(String(e)); return false; }
    finally { setBusy(false); }
  };
  const edit = () => { setTitle(pull.title); setBody(pull.body); setEditing(true); rpc<Options>("pulls.options", identity).then(setOptions).catch((e) => setError(String(e))); };
  const latest = reviews?.[0];
  return <div className="pr-workspace" data-keynav>
    <header className="pr-detail-header"><div className="pr-toolbar"><span className="pr-muted">{pull.repo}</span><span className="spacer" /><button className="btn small" data-hint disabled={busy} onClick={() => void load()}>Refresh</button><ExternalLink href={pull.url}>Open on GitHub ↗</ExternalLink></div>
      <h2>{pull.title} <span className="pr-number">#{pull.number}</span></h2>
      <PullSummary pull={pull} detail={detail} />
      <div className="pr-toolbar"><button className={`btn ${tab === "overview" ? "active" : ""}`} data-hint onClick={() => setTab("overview")}>Conversation</button><button className={`btn ${tab === "files" ? "active" : ""}`} data-hint onClick={() => setTab("files")}>Files changed <span className="pr-muted">{pull.changed_files}</span></button><span className="pr-add">+{pull.additions}</span><span className="pr-del">−{pull.deletions}</span><span className="spacer" />
        {latest && <button className="btn" data-hint onClick={() => useReviews.setState({ reviewId: latest.id })}>Open pre-review · {latest.status}</button>}
        <button className="btn primary" data-command="reviews.start" disabled={busy || !!error || pull.state !== "open" || latest?.status === "running" || latest?.status === "queued"} onClick={() => startReview(pull, latest)}>{latest ? "Pre-review again…" : "Pre-review…"}</button></div>
    </header>
    <PullSessions pull={pull} />
    {isRerequested(pull) && <div className="pr-rerequested" role="status"><strong>Your review was requested again</strong> on {new Date(pull.review_requested_at!).toLocaleString()}. You last reviewed on {new Date(pull.my_review!.submitted_at).toLocaleString()}{pull.my_review!.commit_sha && ` at ${pull.my_review!.commit_sha.slice(0, 7)}`}{pull.my_review!.commit_sha && pull.my_review!.commit_sha !== pull.head_sha ? "; the PR has changed since." : "."}</div>}
    {error && <div className="pr-error" role="alert">{error}{detail && " · Showing cached data."}</div>}
    {tab === "files" ? <div className="pr-detail-scroll">{diff ? <><div className="pr-revision">Current PR diff · {diff.sha.slice(0, 10)}</div><ReviewDiff diff={diff.diff} /></> : <p className="pr-padding">Loading diff…</p>}</div>
      : <div className="pr-detail-scroll pr-overview"><main>
        <Timeline pull={pull} detail={detail}
          descriptionActions={pull.can_edit && <button className="btn small" data-hint onClick={() => editing ? setEditing(false) : edit()}>{editing ? "Cancel edit" : "Edit"}</button>}
          description={editing ? <div className="pr-form"><label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label><label>Description<textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} /></label><button className="btn" data-hint disabled={busy || !title.trim()} onClick={() => void mutate("pulls.update", { patch: { title, body } }).then((ok) => { if (ok) setEditing(false); })}>Save description</button></div> : <Markdown text={pull.body || "No description provided."} />} />
        <div className="pr-tl-end">
          {merged && <div className="pr-card pr-merged" role="status"><strong>Merged.</strong> {merged.branch_deleted ? `Deleted ${pull.head_ref} on GitHub.` : ""}{merged.branch_error && <span className="err-text"> {merged.branch_error}</span>} <button className="btn small" data-hint data-command="git.cleanup" onClick={() => useStore.getState().openDialog({ kind: "git-cleanup", repo: pull.repo })}>Clean up local branches…</button></div>}
          {!merged && <StatusBox pull={pull} />}
          {!merged && pull.state === "open" && pull.can_merge && <MergeCard pull={pull} busy={busy} onMerged={(result) => { setMerged(result); void load(); void useReviews.getState().refresh(); }} />}
          <div className="pr-card pr-form pr-composer"><label>Add a comment<textarea rows={4} value={comment} placeholder="Leave a comment (Markdown)" onChange={(e) => setComment(e.target.value)} /></label><div className="pr-toolbar"><span className="spacer" /><button className="btn primary" data-hint disabled={busy || !comment.trim()} onClick={() => void mutate("pulls.addComment", { body: comment }).then((ok) => { if (ok) setComment(""); })}>Comment</button></div></div>
        </div>
      </main><aside className="pr-metadata">
        <Reviewers pull={pull} />
        <h3>Details</h3>{pull.can_edit && !options && <button className="btn small" data-hint onClick={() => rpc<Options>("pulls.options", identity).then(setOptions).catch((e) => setError(String(e)))}>Edit metadata</button>}
        <MetadataList label="Assignees" values={pull.assignees} options={options?.assignees.map((x) => x.login)} busy={busy} onChange={(assignees) => void mutate("pulls.update", { patch: { assignees } })} />
        <MetadataList label="Labels" values={pull.labels} options={options?.labels.map((x) => x.name)} busy={busy} onChange={(labels) => void mutate("pulls.update", { patch: { labels } })} />
        <label className="pr-field">Milestone{options ? <select value={pull.milestone ?? ""} disabled={busy} onChange={(e) => void mutate("pulls.update", { patch: { milestone: e.target.value ? Number(e.target.value) : null } })}><option value="">None</option>{pull.milestone && !options.milestones.some((m) => m.number === pull.milestone) && <option value={pull.milestone}>#{pull.milestone}</option>}{options.milestones.map((m) => <option key={m.number} value={m.number}>{m.title}</option>)}</select> : <span>{pull.milestone ? `#${pull.milestone}` : "None"}</span>}</label>
        {detail?.project_error && <p className="pr-muted">{detail.project_error}</p>}
        {detail?.projects.map((item) => <section key={item.id}><h3>{item.project.title}</h3>{item.fieldValues.filter((v) => v.field).map((value) => <ProjectFieldControl key={value.field!.id} value={value} disabled={busy || !item.project.viewerCanUpdate} item={item} mutate={mutate} />)}</section>)}
        {!!reviews?.length && <><h3>Previous pre-reviews</h3>{reviews.map((r) => <button key={r.id} className="pr-history-row" data-hint onClick={() => useReviews.setState({ reviewId: r.id })}>{r.status} · {new Date(r.created_at).toLocaleString()}</button>)}</>}
      </aside></div>}
  </div>;
}
const STATE: Record<string, { label: string; tone: string }> = { open: { label: "Open", tone: "ok" }, merged: { label: "Merged", tone: "merged" }, closed: { label: "Closed", tone: "err" } };
/** State badge and "author wants to merge N commits into base from head", as GitHub heads a PR. */
export function PullSummary({ pull, detail }: { pull: PullRequest; detail: PullDetail | null }) {
  const state = pull.draft && pull.state === "open" ? { label: "Draft", tone: "draft" } : STATE[pull.state] ?? { label: pull.state, tone: "" };
  const count = commitCount(detail);
  const commits = count === null ? "" : ` ${count} ${count === 1 ? "commit" : "commits"}`;
  const merger = detail?.timeline?.items.filter((i) => i.kind === "merged").pop()?.actor;
  return <div className="pr-toolbar pr-summary"><span className={`pr-state ${state.tone}`}>{state.label}</span>
    <span><strong>{pull.state === "merged" ? merger || pull.author : pull.author}</strong> {pull.state === "merged" ? "merged" : "wants to merge"}{commits} into <code>{pull.base_ref}</code> from <code>{pull.head_ref}</code></span></div>;
}
/** Checks, reviews and what blocks a merge, above the merge controls as on GitHub. */
function StatusBox({ pull }: { pull: PullRequest }) {
  if (pull.state !== "open") return null;
  const [checks, ...rest] = pullStatus({ ...pull, draft: false });
  const review = rest[0] ?? { label: "no reviews" };
  return <section className="pr-card pr-status-box" aria-label="Status">
    <div className="pr-status-row"><span className={`pr-tl-icon ${checks.tone ?? ""}`} aria-hidden>{checks.tone === "ok" ? "✓" : checks.tone === "err" ? "✕" : "◦"}</span>{checks.label[0].toUpperCase() + checks.label.slice(1)}</div>
    <div className="pr-status-row"><span className={`pr-tl-icon ${review.tone ?? ""}`} aria-hidden>{review.tone === "ok" ? "✓" : review.tone === "err" ? "±" : "◦"}</span>{review.label[0].toUpperCase() + review.label.slice(1)}</div>
    {pull.draft && <div className="pr-status-row"><span className="pr-tl-icon" aria-hidden>◌</span>This pull request is still a draft</div>}
    {!pull.can_merge && pull.merge_blocked_by && <div className="pr-status-row"><span className="pr-tl-icon" aria-hidden>◦</span>{pull.merge_blocked_by}</div>}
  </section>;
}
const VERDICT: Record<string, { mark: string; tone?: string; label: string }> = { APPROVED: { mark: "✓", tone: "ok", label: "approved" }, CHANGES_REQUESTED: { mark: "±", tone: "err", label: "requested changes" }, COMMENTED: { mark: "◦", label: "commented" }, DISMISSED: { mark: "◦", label: "review dismissed" } };
/** Who reviewed and who is asked to, as GitHub's sidebar lists them. */
function Reviewers({ pull }: { pull: PullRequest }) {
  const reviewed = [...(pull.my_review ? [pull.my_review] : []), ...pull.reviews];
  const pending = pull.requested.filter((r) => !reviewed.some((x) => x.reviewer === r.name));
  return <section className="pr-reviewer-list"><h3>Reviewers</h3>
    {!reviewed.length && !pending.length && <p className="pr-muted">No reviews</p>}
    <ul>
      {pending.map((r) => <li key={`requested:${r.name}`}><Avatar login={r.name} /><span className="name">{r.name}</span><span className="pr-muted" title="Review requested">…</span></li>)}
      {reviewed.map((r) => { const v = VERDICT[r.state] ?? { mark: "◦", label: r.state.toLowerCase() }; return <li key={r.reviewer || "you"} className={r.bot ? "bot" : undefined}><Avatar login={r.reviewer || "you"} /><span className="name">{r.reviewer || "you"}</span><span className={`mark ${v.tone ?? ""}`} title={v.label} aria-label={v.label}>{v.mark}</span></li>; })}
    </ul>
  </section>;
}
type MergeResult = { branch_deleted: boolean; branch_error: string | null };
const MERGE_LABELS: Record<string, string> = { merge: "Create a merge commit", squash: "Squash and merge", rebase: "Rebase and merge" };
/** Merge controls, enabled once GitHub reports the PR ready and no check failed. Method and branch choice persist. */
export function MergeCard({ pull, busy, onMerged }: { pull: PullRequest; busy: boolean; onMerged: (result: MergeResult) => void }) {
  const saved = useStore((s) => s.settings.mergeMethod);
  const deleteBranch = useStore((s) => s.settings.deleteBranchAfterMerge);
  const setSettings = useStore((s) => s.setSettings);
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const method = [saved, pull.default_merge_method].find((m) => pull.merge_methods.includes(m)) ?? pull.merge_methods[0];
  const deletes = pull.auto_delete_branch || (pull.can_delete_branch && deleteBranch);
  const blocked = pull.merge_blocked_by;
  const merge = async () => {
    setMerging(true); setError(null);
    try { onMerged(await rpc<MergeResult>("pulls.merge", { repo: pull.repo, number: pull.number, account: pull.account, method, sha: pull.head_sha, delete_branch: deletes })); }
    catch (e) { setError(String(e)); setConfirming(false); }
    finally { setMerging(false); }
  };
  return <section className="pr-card pr-merge" aria-label="Merge">
    <header className="pr-toolbar"><strong>Merge</strong><span className={`chip ${blocked ? "" : "ok"}`}>{blocked ?? "Ready to merge"}</span></header>
    <div className="pr-toolbar">
      <select aria-label="Merge method" value={method} disabled={merging || confirming} onChange={(e) => setSettings({ mergeMethod: e.target.value })}>{pull.merge_methods.map((m) => <option key={m} value={m}>{MERGE_LABELS[m] ?? m}</option>)}</select>
      <label className="pr-check" title={pull.auto_delete_branch ? "The repository deletes merged branches itself" : pull.can_delete_branch ? undefined : "The branch is in another repository"}><input type="checkbox" checked={deletes} disabled={merging || confirming || pull.auto_delete_branch || !pull.can_delete_branch} onChange={(e) => setSettings({ deleteBranchAfterMerge: e.target.checked })} />Delete branch <code>{pull.head_ref}</code></label>
      <span className="spacer" />
      {confirming ? <><button className="btn" data-hint disabled={merging} onClick={() => setConfirming(false)}>Cancel</button><button className="btn primary" data-hint data-command="pulls.merge.confirm" disabled={merging} onClick={() => void merge()}>{merging ? "Merging…" : `Confirm ${(MERGE_LABELS[method] ?? method).toLowerCase()}`}</button></>
        : <button className="btn primary" data-hint data-command="pulls.merge" disabled={busy || !!blocked || !method} onClick={() => setConfirming(true)}>{MERGE_LABELS[method] ?? "Merge"}</button>}
    </div>
    {confirming && <p className="pr-muted">Merges {pull.head_sha.slice(0, 7)} into <code>{pull.base_ref}</code>{deletes ? ` and deletes ${pull.head_ref}` : ""}. GitHub refuses if new commits were pushed since.</p>}
    {error && <p className="err-text" role="alert">{error}</p>}
  </section>;
}
function ProjectFieldControl({ value, disabled, item, mutate }: { value: ProjectField; disabled: boolean; item: ProjectItem; mutate: (method: string, params: object) => Promise<boolean> }) {
  const field = value.field!;
  const initial = value.text ?? value.number ?? value.date ?? value.optionId ?? value.iterationId ?? "";
  const [text, setText] = useState(String(initial));
  useEffect(() => setText(String(initial)), [initial]);
  const key = field.dataType === "TEXT" ? "text" : field.dataType === "NUMBER" ? "number" : field.dataType === "DATE" ? "date" : field.dataType === "SINGLE_SELECT" ? "singleSelectOptionId" : field.dataType === "ITERATION" ? "iterationId" : null;
  if (!key) return <div className="pr-field">{field.name}<span>{value.name ?? value.title ?? text}</span></div>;
  const save = (text: string) => { setText(text); void mutate("pulls.setField", { item_id: item.id, project_id: item.project.id, field_id: field.id, value: text === "" ? null : { [key]: key === "number" ? Number(text) : text } }); };
  const options = field.options ?? [...(field.configuration?.iterations ?? []), ...(field.configuration?.completedIterations ?? [])].map((x) => ({ id: x.id, name: x.title }));
  return <label className="pr-field">{field.name}{["singleSelectOptionId", "iterationId"].includes(key) ? <select value={text} disabled={disabled} onChange={(e) => save(e.target.value)}><option value="">None</option>{options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select> : <input value={text} type={key === "number" ? "number" : key === "date" ? "date" : "text"} disabled={disabled} onChange={(e) => setText(e.target.value)} onBlur={() => { if (text !== String(initial)) save(text); }} />}</label>;
}
function MetadataList({ label, values, options, busy, onChange }: { label: string; values: string[]; options?: string[]; busy: boolean; onChange: (values: string[]) => void }) {
  return <div className="pr-field"><span>{label}</span><div className="pr-chips">{values.length ? values.map((v) => <span className="chip" key={v}>{v}{options && <button data-hint disabled={busy} aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>×</button>}</span>) : "None"}</div>{options && <select aria-label={`Add ${label.toLowerCase()}`} value="" disabled={busy} onChange={(e) => { if (e.target.value) onChange([...values, e.target.value]); }}><option value="">+ Add…</option>{options.filter((x) => !values.includes(x)).map((v) => <option key={v}>{v}</option>)}</select>}</div>;
}
