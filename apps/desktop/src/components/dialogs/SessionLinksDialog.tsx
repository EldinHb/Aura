import { useMemo, useState } from "react";
import { Modal } from "../Modal";
import { useStore } from "../../state/store";
import { useGithubRepo } from "../../state/githubRepos";
import { loadLinkPreferences, saveLinkPreferences, useSessionLinkPreferences } from "../../state/sessionLinkPreferences";
import { mentionedSessionLinks, parseSessionLink, sessionLinks, type LinkPreferences, type SessionLink } from "../../views/issueLinks";

const PASTE = "paste";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The issues or PRs of one kind: automatic (null) follows the conversation;
 * otherwise a list the user adds to and removes from.
 */
function LinkList({ kind, chosen, onChange, candidates, automatic, disabled, onError }: {
  kind: SessionLink["kind"]; chosen: string[] | null; onChange: (chosen: string[] | null) => void;
  candidates: SessionLink[]; automatic: SessionLink[]; disabled: boolean; onError: (error: string) => void;
}) {
  const [pasting, setPasting] = useState(false);
  const [url, setUrl] = useState("");
  const noun = kind === "PR" ? "pull request" : "issue";
  const plural = kind === "PR" ? "Pull requests" : "Issues";
  const id = kind === "Issue" ? "session-issues" : "session-prs";
  const add = (value: string) => {
    const link = parseSessionLink(value, kind);
    if (!link) { onError(`Enter a valid GitHub ${noun} URL.`); return false; }
    onError("");
    if (!(chosen ?? []).some((other) => same(other, link.url))) onChange([...(chosen ?? []), link.url]);
    return true;
  };
  const addable = candidates.filter((link) => !(chosen ?? []).some((other) => same(other, link.url)));
  const label = (url: string) => {
    const link = parseSessionLink(url, kind);
    return link ? `${link.repo} #${link.number}` : url;
  };
  return (
    <fieldset className="link-list" aria-labelledby={`${id}-label`}>
      <div className="link-list-head">
        <span id={`${id}-label`} className="label">{plural}</span>
        <label className="check-row">
          <input type="checkbox" checked={chosen === null} disabled={disabled}
            onChange={(event) => onChange(event.target.checked ? null : automatic.map((link) => link.url))} />
          Automatic
        </label>
      </div>
      {chosen === null ? (
        <p className="dim">{automatic.length ? automatic.map((link) => `${link.repo} #${link.number}`).join(", ") : "None detected"} — follows the conversation</p>
      ) : (
        <>
          {chosen.length === 0 && <p className="dim">No {kind === "PR" ? "pull requests" : "issues"}</p>}
          {chosen.map((url) => (
            <div key={url} className="link-list-row">
              <span className="grow" title={url}>{label(url)}</span>
              <button type="button" className="btn small" data-hint aria-label={`Remove ${label(url)}`} disabled={disabled}
                onClick={() => onChange(chosen.filter((other) => other !== url))}>Remove</button>
            </div>
          ))}
          <select id={id} aria-label={`Add ${noun}`} value="" disabled={disabled} onChange={(event) => {
            const next = event.target.value;
            if (next === PASTE) setPasting(true);
            else if (next) add(next);
          }}>
            <option value="">Add {kind === "PR" ? "a pull request" : "an issue"}…</option>
            {addable.map((link) => <option key={link.url} value={link.url}>{link.repo} #{link.number}</option>)}
            <option value={PASTE}>Paste a GitHub URL…</option>
          </select>
          {pasting && (
            <div className="link-list-row">
              <input aria-label={`${kind} URL`} type="url" className="grow" autoFocus disabled={disabled}
                placeholder={`https://github.com/owner/repo/${kind === "PR" ? "pull" : "issues"}/123`}
                value={url} onChange={(event) => setUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (add(url)) { setUrl(""); setPasting(false); }
                }} />
              <button type="button" className="btn small" data-hint disabled={disabled} onClick={() => { if (add(url)) { setUrl(""); setPasting(false); } }}>Add</button>
            </div>
          )}
        </>
      )}
    </fieldset>
  );
}

function Editor({ sessionId, preferences }: { sessionId: string; preferences: LinkPreferences }) {
  const session = useStore((state) => state.sessions[sessionId]);
  const transcript = useStore((state) => state.transcripts[sessionId]);
  const client = useStore((state) => state.client);
  const repo = useGithubRepo(session?.cwd);
  const close = useStore((state) => state.closeDialog);
  const [issues, setIssues] = useState<string[] | null>(preferences.issues ?? null);
  const [prs, setPrs] = useState<string[] | null>(preferences.prs ?? null);
  const [reviews, setReviews] = useState(preferences.reviews !== false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const candidates = useMemo(() => {
    const all = mentionedSessionLinks(transcript?.items ?? {}, session?.title, repo);
    for (const [kind, urls] of [["Issue", preferences.issues], ["PR", preferences.prs]] as const) {
      for (const url of urls ?? []) {
        const link = parseSessionLink(url, kind);
        if (link && !all.some((other) => same(other.url, link.url))) all.push(link);
      }
    }
    return all;
  }, [transcript?.items, session?.title, repo, preferences]);
  const automatic = useMemo(() => sessionLinks(transcript?.items ?? {}, session?.title, repo), [transcript?.items, session?.title, repo]);
  const save = async () => {
    if (!client || saving) return;
    const next: LinkPreferences = {};
    if (issues) next.issues = issues;
    if (prs) next.prs = prs;
    if (!reviews) next.reviews = false;
    setError("");
    setSaving(true);
    try {
      await saveLinkPreferences(client, sessionId, next);
      close();
    } catch (cause) {
      setError(`Could not save: ${String(cause)}`);
      setSaving(false);
    }
  };
  return (
    <Modal title="Edit issues & PRs" width={600} onClose={saving ? () => {} : close} footer={<>
      <button type="button" className="btn" data-command="dialog.cancel" disabled={saving} onClick={close}>Cancel</button>
      <button type="button" className="btn primary" data-command="dialog.confirm" disabled={saving || !client} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
    </>}>
      <p className="dim">Add links mentioned in this session, or paste URLs. Your lists stay fixed until you change them. Automatic follows the conversation.</p>
      <LinkList kind="Issue" chosen={issues} onChange={setIssues} candidates={candidates.filter((link) => link.kind === "Issue")}
        automatic={automatic.filter((link) => link.kind === "Issue")} disabled={saving} onError={setError} />
      <LinkList kind="PR" chosen={prs} onChange={setPrs} candidates={candidates.filter((link) => link.kind === "PR")}
        automatic={automatic.filter((link) => link.kind === "PR")} disabled={saving} onError={setError} />
      <label className="check-row">
        <input type="checkbox" checked={reviews} disabled={saving} onChange={(event) => setReviews(event.target.checked)} />
        Hand new reviews and comments on these PRs to this session
      </label>
      <p className="dim">For open PRs you authored, Aura checks GitHub every minute. The agent fixes what needs fixing and pushes; you are notified when activity arrives and when the agent is done.</p>
      {transcript?.loading && <p className="dim">Loading links from session history…</p>}
      {error && <p role="alert" className="err-text">{error}</p>}
    </Modal>
  );
}

export function SessionLinksDialog({ sessionId }: { sessionId: string }) {
  const entry = useSessionLinkPreferences(sessionId);
  const client = useStore((state) => state.client);
  if (!entry || entry.error) return (
    <Modal title="Edit issues & PRs" width={600}>
      <p role={entry?.error ? "alert" : "status"}>{entry?.error ? `Could not load saved links: ${entry.error}` : client ? "Loading saved links…" : "Connect to the daemon to edit links."}</p>
      {entry?.error && client && <button className="btn" data-hint onClick={() => void loadLinkPreferences(client, sessionId)}>Retry</button>}
    </Modal>
  );
  return <Editor sessionId={sessionId} preferences={entry.preferences} />;
}
