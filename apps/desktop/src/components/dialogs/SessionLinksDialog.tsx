import { useMemo, useState } from "react";
import { Modal } from "../Modal";
import { useStore } from "../../state/store";
import { useGithubRepo } from "../../state/githubRepos";
import { loadLinkPreferences, saveLinkPreferences, useSessionLinkPreferences } from "../../state/sessionLinkPreferences";
import { mentionedSessionLinks, parseSessionLink, sessionLinks, type LinkPreferences, type SessionLink } from "../../views/issueLinks";

const AUTO = "auto", NONE = "none", CUSTOM = "custom";

function LinkField({ kind, value, onChange, candidates, automatic, disabled }: {
  kind: SessionLink["kind"]; value: string; onChange: (value: string) => void;
  candidates: SessionLink[]; automatic?: SessionLink; disabled: boolean;
}) {
  const [custom, setCustom] = useState(value !== AUTO && value !== NONE && !candidates.some((link) => link.url === value));
  const id = kind === "Issue" ? "session-issue" : "session-pr";
  return (
    <div className="field">
      <label htmlFor={id}>{kind === "PR" ? "Pull request" : "Issue"}</label>
      <select id={id} value={custom ? CUSTOM : value} disabled={disabled} onChange={(event) => {
        const next = event.target.value;
        setCustom(next === CUSTOM);
        onChange(next === CUSTOM ? "" : next);
      }}>
        <option value={AUTO}>Automatic{automatic ? ` — ${automatic.repo} #${automatic.number}` : " — none detected"}</option>
        <option value={NONE}>None</option>
        {candidates.map((link) => <option key={link.url} value={link.url}>{link.repo} #{link.number}</option>)}
        <option value={CUSTOM}>Paste a GitHub URL…</option>
      </select>
      {custom && <input aria-label={`${kind} URL`} type="url" placeholder={`https://github.com/owner/repo/${kind === "PR" ? "pull" : "issues"}/123`}
        value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />}
    </div>
  );
}

function Editor({ sessionId, preferences }: { sessionId: string; preferences: LinkPreferences }) {
  const session = useStore((state) => state.sessions[sessionId]);
  const transcript = useStore((state) => state.transcripts[sessionId]);
  const client = useStore((state) => state.client);
  const repo = useGithubRepo(session?.cwd);
  const close = useStore((state) => state.closeDialog);
  const [issue, setIssue] = useState(preferences.issue === undefined ? AUTO : preferences.issue ?? NONE);
  const [pr, setPr] = useState(preferences.pr === undefined ? AUTO : preferences.pr ?? NONE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const candidates = useMemo(() => {
    const all = mentionedSessionLinks(transcript?.items ?? {}, session?.title, repo);
    for (const [kind, value] of [["Issue", preferences.issue], ["PR", preferences.pr]] as const) {
      const link = value ? parseSessionLink(value, kind) : undefined;
      if (link && !all.some((other) => other.url.toLowerCase() === link.url.toLowerCase())) all.push(link);
    }
    return all;
  }, [transcript?.items, session?.title, repo, preferences]);
  const automatic = useMemo(() => sessionLinks(transcript?.items ?? {}, session?.title, repo), [transcript?.items, session?.title, repo]);
  const save = async () => {
    if (!client || saving) return;
    const next: LinkPreferences = {};
    for (const [kind, value] of [["Issue", issue], ["PR", pr]] as const) {
      const key = kind === "Issue" ? "issue" : "pr";
      if (value === AUTO) continue;
      if (value === NONE) next[key] = null;
      else {
        const link = parseSessionLink(value, kind);
        if (!link) { setError(`Enter a valid GitHub ${kind === "PR" ? "pull request" : "issue"} URL, or choose None.`); return; }
        next[key] = link.url;
      }
    }
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
    <Modal title="Edit issue & PR" width={600} onClose={saving ? () => {} : close} footer={<>
      <button type="button" className="btn" data-command="dialog.cancel" disabled={saving} onClick={close}>Cancel</button>
      <button type="button" className="btn primary" data-command="dialog.confirm" disabled={saving || !client} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
    </>}>
      <p className="dim">Choose from links mentioned in this session, or paste a URL. Your selections stay fixed until you change them. Automatic follows the conversation.</p>
      <LinkField kind="Issue" value={issue} onChange={setIssue} candidates={candidates.filter((link) => link.kind === "Issue")} automatic={automatic.find((link) => link.kind === "Issue")} disabled={saving} />
      <LinkField kind="PR" value={pr} onChange={setPr} candidates={candidates.filter((link) => link.kind === "PR")} automatic={automatic.find((link) => link.kind === "PR")} disabled={saving} />
      {transcript?.loading && <p className="dim">Loading links from session history…</p>}
      {error && <p role="alert" className="err-text">{error}</p>}
    </Modal>
  );
}

export function SessionLinksDialog({ sessionId }: { sessionId: string }) {
  const entry = useSessionLinkPreferences(sessionId);
  const client = useStore((state) => state.client);
  if (!entry || entry.error) return (
    <Modal title="Edit issue & PR" width={600}>
      <p role={entry?.error ? "alert" : "status"}>{entry?.error ? `Could not load saved links: ${entry.error}` : client ? "Loading saved links…" : "Connect to the daemon to edit links."}</p>
      {entry?.error && client && <button className="btn" data-hint onClick={() => void loadLinkPreferences(client, sessionId)}>Retry</button>}
    </Modal>
  );
  return <Editor sessionId={sessionId} preferences={entry.preferences} />;
}
