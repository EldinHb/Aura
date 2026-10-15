import { useCallback, useEffect, useState } from "react";
import type { PreReview, ReviewComment, SubmissionPreview } from "../../gen";
import { ExternalLink } from "../../components/ExternalLink";
import { Modal } from "../../components/Modal";
import { normalizePreReview } from "../../lib/pulls";
import { useStore } from "../../state/store";
import { ReviewDiff } from "./ReviewDiff";
import { editDraft, ensureDraft, flushDraft, reloadDraft, rpc, startReview, useReviewDrafts, useReviews } from "./state";


/** Same wording as the signature Aura adds to the posted review. */
export function agentLabel(review: PreReview): string {
  const a = review.agent;
  if (!a) return `${review.config.provider} · ${review.config.model ?? "default model"}${review.config.effort ? ` · ${review.config.effort}` : ""}`;
  const chosen = a.model && a.model !== "default" ? a.model : null;
  const model = chosen && a.model_id && chosen !== a.model_id ? `${chosen} (${a.model_id})` : a.model_id ?? chosen ?? "default model";
  return `${a.provider} · model ${model} · effort ${a.effort ?? "default"}`;
}
export function ReviewEditor({ id }: { id: string }) {
  const [review, setReview] = useState<PreReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<{ id: string; seq: number } | null>(null);
  const draft = useReviewDrafts((s) => s.drafts[id]);
  const client = useStore((s) => s.client);
  const refresh = useCallback(async () => {
    try { const review = normalizePreReview(await rpc<PreReview>("reviews.get", { id })); setReview(review); if (review.status === "ready") ensureDraft(review); setError(null); }
    catch (e) { setError(String(e)); }
  }, [id]);
  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = client?.onNotification((method) => { if (method === "reviews.changed" && !timer) timer = setTimeout(() => { timer = undefined; void refresh(); }, 250); });
    const offState = client?.onState((state) => { if (state === "open") void refresh(); });
    return () => { off?.(); offState?.(); clearTimeout(timer); void flushDraft(id).catch(() => {}); };
  }, [client, id, refresh]);
  const action = async (method: string) => { setBusy(true); try { await rpc(method, { id }); await refresh(); await useReviews.getState().refresh(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const preview = async () => {
    setBusy(true);
    try { await flushDraft(id); const preview = await rpc<SubmissionPreview>("reviews.preview", { id }); useStore.getState().openDialog({ kind: "review-submit", preview }); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  if (!review) return <div className="pr-padding">{error ?? "Loading pre-review…"}</div>;
  const result = review.status === "ready" && draft ? draft.result : review.result;
  const editable = review.status === "ready" && !!draft;
  const comment = (id: string, patch: Partial<ReviewComment>) => editDraft(review.id, { ...result, comments: result.comments.map((c) => c.id === id ? { ...c, ...patch, edited: true } : c) });
  const focusComment = (id: string) => { setFocus((s) => ({ id, seq: (s?.seq ?? 0) + 1 })); document.getElementById(`review-comment-${id}`)?.scrollIntoView({ block: "nearest" }); };
  const active = review.status === "queued" || review.status === "running";
  return <div className="pr-review-editor" data-keynav>
    <header className="pr-toolbar"><button className="btn small" data-hint onClick={() => useReviews.setState({ reviewId: null })}>← Pull request</button><strong>Pre-review</strong><span className="chip">{review.status}</span><span className="pr-muted">{agentLabel(review)} · {new Date(review.created_at).toLocaleString()}</span>
      {!active && <button className="btn small" data-hint onClick={() => startReview(review.pull, review)}>Pre-review again…</button>}</header>
    {error && <div className="pr-error" role="alert">{error}</div>}
    {active ? <div className="pr-progress"><h2>{review.status === "queued" ? "Waiting for an agent slot" : "Review in progress"}</h2><ol>{[["preparing", "Preparing"], ["cloning", "Fetching the branch"], ["running", "Agent reviewing"], ["validating", "Checking findings"]].map(([phase, label]) => <li key={phase} className={review.phase === phase ? "active" : ""}>{label}{review.phase === phase ? " …" : ""}</li>)}</ol><Elapsed since={review.created_at} /><pre className="pr-log">{review.log_tail.join("\n")}</pre><button className="btn" data-hint disabled={busy} onClick={() => void action("reviews.cancel")}>Cancel pre-review</button></div>
      : ["failed", "cancelled", "discarded"].includes(review.status) ? <div className="pr-padding"><p className="pr-error">{review.error ?? `Review ${review.status}.`}</p><button className="btn" data-hint onClick={() => startReview(review.pull, review)}>Run again…</button></div>
      : <div className="pr-result-layout">
        <div className="pr-result-diff"><div className="pr-revision">Reviewed commit {review.reviewed_sha.slice(0, 10)} · {review.context_mode}</div><ReviewDiff diff={review.diff} comments={result.comments} focus={focus} onFocus={focusComment} onAdd={editable ? (path, line, side) => { const id = crypto.randomUUID(); editDraft(review.id, { ...result, comments: [...result.comments, { id, path, line, start_line: null, side, body: "", severity: "minor", rationale: null, valid: true, position_note: null, deleted: false, edited: false, user_authored: true }] }); focusComment(id); } : undefined} /></div>
        <aside className="pr-findings"><div className="pr-findings-scroll">
          {review.context_note && <p className="pr-warning">{review.context_note}</p>}
          {editable && <div className="pr-save-state" role="status">{draft?.error ? <><span className="pr-error">{draft.error} Your local edits are retained.</span><button className="btn small" data-hint onClick={() => void flushDraft(id).catch((e) => setError(String(e)))}>Retry save</button><button className="btn small" data-hint onClick={() => useStore.getState().openDialog({ kind: "confirm", title: "Reload saved review?", message: "Replace your local edits with the last saved version?", onConfirm: () => { reloadDraft(review); } })}>Reload saved version</button></> : draft?.saving ? "Saving…" : draft && draft.version !== draft.savedVersion ? "Unsaved changes" : "Saved"}</div>}
          <label className="pr-field">Summary<textarea aria-label="Summary" rows={7} disabled={!editable} value={result.summary} onChange={(e) => editDraft(id, { ...result, summary: e.target.value })} /></label>
          <div className="pr-form-row"><label>Verdict<select disabled={!editable} value={result.verdict} onChange={(e) => editDraft(id, { ...result, verdict: e.target.value })}><option value="approve">Approve</option><option value="comment">Comment</option><option value="request_changes">Request changes</option></select></label><label>Risk<select disabled={!editable} value={result.risk} onChange={(e) => editDraft(id, { ...result, risk: e.target.value })}>{["low", "medium", "high"].map((x) => <option key={x}>{x}</option>)}</select></label></div>
          {result.confidence !== null && <p className="pr-muted">Confidence: {Math.round(result.confidence * 100)}%</p>}
          <h3>Findings ({result.comments.filter((c) => !c.deleted).length})</h3>
          {result.comments.length === 0 && <p className="pr-muted">No findings. Add a comment from a diff line.</p>}
          {result.comments.map((c) => <article key={c.id} id={`review-comment-${c.id}`} className={`pr-finding ${focus?.id === c.id ? "selected" : ""} ${c.deleted ? "deleted" : ""}`}>
            <div className="pr-finding-head"><button className="pr-location" data-hint onClick={() => focusComment(c.id)}>{c.path}:{c.line}</button>{c.user_authored ? <span className="chip">yours</span> : c.edited ? <span className="chip">edited</span> : null}</div>
            {c.position_note && <p className={c.valid ? "pr-muted" : "pr-warning"}>{c.position_note}</p>}
            <div className="pr-form-row"><label>Severity<select disabled={!editable || c.deleted} value={c.severity} onChange={(e) => comment(c.id, { severity: e.target.value })}>{["blocker", "major", "minor", "nit", "praise"].map((s) => <option key={s}>{s}</option>)}</select></label><label>Line<input type="number" min={1} disabled={!editable || c.deleted} value={c.line} onChange={(e) => comment(c.id, { line: Number(e.target.value) })} /></label></div>
            <textarea aria-label={`Finding at ${c.path}:${c.line}`} rows={4} disabled={!editable || c.deleted} value={c.body} onChange={(e) => comment(c.id, { body: e.target.value })} />
            {c.rationale && <details><summary>Agent rationale · never posted</summary><p>{c.rationale}</p></details>}
            {editable && <button className="btn small" data-hint onClick={() => comment(c.id, { deleted: !c.deleted })}>{c.deleted ? "Restore" : "Delete"}</button>}
          </article>)}
        </div><footer className="pr-submit-bar">
          {editable ? <><button className="btn" data-hint disabled={busy} onClick={() => useStore.getState().openDialog({ kind: "confirm", title: "Discard pre-review?", message: "Nothing will be posted to GitHub.", onConfirm: () => { void action("reviews.discard"); } })}>Discard</button><button className="btn primary" data-hint disabled={busy || !!draft?.error} onClick={() => void preview()}>Submit to GitHub…</button></>
            : review.status === "submitted" ? <><span>✓ Submitted to GitHub</span>{review.submitted_url && <ExternalLink href={review.submitted_url}>View review</ExternalLink>}</>
              : <><p className="pr-warning">{review.error ?? "Submitting…"}</p>{review.status === "uncertain" && <button className="btn" data-hint disabled={busy} onClick={() => void action("reviews.reconcile")}>Reconcile with GitHub</button>}</>}
        </footer></aside>
      </div>}
  </div>;
}
function Elapsed({ since }: { since: string }) { const [now, setNow] = useState(Date.now()); useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []); return <p className="pr-muted">{Math.max(0, Math.round((now - Date.parse(since)) / 1000))} seconds elapsed · You can leave this page and come back.</p>; }

export function ReviewSubmit({ preview }: { preview: SubmissionPreview }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useStore((s) => s.closeDialog);
  const label = preview.event === "APPROVE" ? "approval" : preview.event === "REQUEST_CHANGES" ? "changes requested" : "comment";
  return <Modal className="pr-modal" title="Post this review to GitHub?" width={760} onClose={() => { if (!busy) close(); }} footer={<><button className="btn" data-hint disabled={busy} onClick={close}>Cancel</button><button className="btn primary" data-hint disabled={busy || !!error} onClick={() => { setBusy(true); rpc("reviews.submit", { id: preview.review_id, token: preview.token }).then(() => { close(); void useReviews.getState().refresh(); }).catch((e) => setError(String(e))).finally(() => setBusy(false)); }}>{busy ? "Posting…" : `Post ${label}`}</button></>}>
    <div className="pr-form">
      {error && <p className="pr-error" role="alert">{error} Close this dialog to return to the saved review.</p>}
      <p>Post as <strong>{preview.account}</strong> · <strong>{label}</strong></p>
      {preview.stale && <p className="pr-warning">This PR changed after it was reviewed ({preview.reviewed_sha.slice(0, 8)} → {preview.head_sha.slice(0, 8)}). Comments will attach to the reviewed commit. Consider running a new pre-review.</p>}
      <h3>Review body</h3><pre className="pr-prompt">{preview.body}</pre>
      <h3>{preview.comments.length} inline comments</h3>{preview.comments.map((c) => <article className="pr-finding" key={c.id}><strong>{c.path}:{c.start_line ? `${c.start_line}–` : ""}{c.line} ({c.side})</strong><pre className="pr-prompt">{c.body}</pre></article>)}
      <p className="pr-muted">Deleted findings and private rationale are excluded. The hidden review marker in the body lets Aura reconcile a connection failure without duplicating your review.</p>
    </div>
  </Modal>;
}
