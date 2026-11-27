// "Squash and merge" on an approved PR's card: the button (or why it can't be used), and an
// inline confirmation with the commit title and message, run by the daemon half's `merge`.
import { useEffect, useId, useRef, useState } from "react";
import type { MergeDefaults, MergeResult, PrStatus } from "../shared/types";
import { getCtx } from "./ctx";
import { squashState } from "../shared/squash";

/** `ctx.storage` key: the "Delete branch after merge" choice. */
export const DELETE_BRANCH_KEY = "deleteBranchAfterMerge";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the confirmation was opened for: the head commit and the account it showed. Polling does not change these. */
interface Opened {
  sha: string;
  account: string;
}

export function SquashMerge({ status, onMerged }: { status: PrStatus; onMerged: () => void }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const reasonId = useId();
  const state = squashState(status);
  if (opened) {
    // New commits make what was confirmed stale: it has to be opened again, on the new head.
    if (status.merge.headSha !== opened.sha) {
      return (
        <div className="prs-confirm">
          <p className="prs-wrap prs-stale" role="alert">New commits were pushed — review again</p>
          <div className="prs-confirm-actions">
            <button type="button" className="btn small" onClick={() => setOpened(null)}>Close</button>
          </div>
        </div>
      );
    }
    // Eligibility is checked on every render: a PR that got blocked meanwhile cannot be merged from here.
    const blocked = !state ? ["It is no longer open and approved"] : state.kind === "disabled" ? state.reasons : state.kind === "unavailable" ? [state.reason] : null;
    return <ConfirmSquash status={status} opened={opened} blocked={blocked} close={() => setOpened(null)} onMerged={onMerged} />;
  }
  if (!state) return null;
  if (state.kind === "unavailable") return <p className="prs-line prs-muted prs-wrap">{state.reason}</p>;
  const disabled = state.kind === "disabled";
  return (
    <div className="prs-merge">
      <button className="btn small tonal" disabled={disabled} aria-describedby={disabled ? reasonId : undefined}
        onClick={() => setOpened({ sha: status.merge.headSha, account: status.merge.account })}>
        Squash and merge
      </button>
      {disabled && <span id={reasonId} className="prs-muted prs-wrap prs-merge-reason">{state.reasons.join(" · ")}</span>}
    </div>
  );
}

function ConfirmSquash({ status, opened, blocked, close, onMerged }: {
  status: PrStatus; opened: Opened; blocked: string[] | null; close: () => void; onMerged: () => void;
}) {
  const ctx = getCtx();
  const [title, setTitle] = useState(`${status.title} (#${status.number})`);
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [deleteBranch, setDeleteBranch] = useState(() => ctx?.storage.get<boolean>(DELETE_BRANCH_KEY) === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const edited = useRef(false);
  const ids = { title: useId(), body: useId(), error: useId(), blocked: useId() };
  const login = opened.account.split(":")[1] ?? "";
  // The merge is made as the account whose permissions were shown; without one, it is not made.
  const reasons = blocked ?? (login ? null : ["The GitHub account is not known; refresh"]);

  useEffect(() => {
    cancel.current?.focus();
    let active = true;
    ctx?.rpc<MergeDefaults>("merge.defaults", { repo: status.repo, number: status.number })
      .then((d) => {
        if (!active || edited.current) return;
        setTitle(d.title);
        setBody(d.message);
      })
      // Without GitHub's suggestion the message stays empty; the merge itself still works.
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [ctx, status.repo, status.number]);

  const merge = async () => {
    if (busy || reasons || !ctx) return;
    setBusy(true);
    setError(null);
    try {
      const result = await ctx.rpc<MergeResult>("merge", {
        repo: status.repo, number: status.number, sha: opened.sha, account: opened.account, title, message: body,
        deleteBranch: deleteBranch && status.merge.sameRepo,
      });
      ctx.toast(`Merged #${status.number}`);
      if (deleteBranch && !result.branchDeleted && result.branchError) ctx.toast(`Branch not deleted: ${result.branchError}`, "warn");
      close();
      onMerged();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  return (
    <form className="prs-confirm" aria-label={`Squash and merge #${status.number}`}
      onSubmit={(e) => {
        e.preventDefault();
        void merge();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) {
          e.stopPropagation();
          close();
        }
      }}>
      <label htmlFor={ids.title}>Commit title</label>
      <input id={ids.title} value={title} disabled={busy} onChange={(e) => {
        edited.current = true;
        setTitle(e.target.value);
      }} />
      <label htmlFor={ids.body}>Commit message</label>
      <textarea id={ids.body} rows={4} value={body} disabled={busy || loading} placeholder={loading ? "Loading GitHub's suggestion…" : undefined}
        onChange={(e) => {
          edited.current = true;
          setBody(e.target.value);
        }} />
      {status.merge.sameRepo ? (
        <label className="check-row prs-check">
          <input type="checkbox" checked={deleteBranch} disabled={busy} onChange={(e) => {
            setDeleteBranch(e.target.checked);
            ctx?.storage.set(DELETE_BRANCH_KEY, e.target.checked);
          }} />
          Delete branch after merge
        </label>
      ) : (
        <p className="prs-muted prs-wrap">The branch is in a fork and stays.</p>
      )}
      {login && <p className="prs-muted prs-wrap">Merges as {login}</p>}
      {reasons && <p id={ids.blocked} className="err-text prs-wrap" role="status">Can't merge now: {reasons.join(" · ")}</p>}
      {error && <p id={ids.error} className="err-text prs-wrap" role="alert">{error}</p>}
      <div className="prs-confirm-actions">
        <button type="button" ref={cancel} className="btn small" disabled={busy} onClick={close}>Cancel</button>
        <button type="submit" className="btn small primary" disabled={busy || !!reasons || !title.trim()}
          aria-describedby={reasons ? ids.blocked : error ? ids.error : undefined}>
          {busy ? "Merging…" : "Merge"}
        </button>
      </div>
    </form>
  );
}
