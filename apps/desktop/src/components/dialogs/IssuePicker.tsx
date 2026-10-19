import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { RepoIssue } from "../../gen";
import { useStore } from "../../state/store";
import { useGithubRepo } from "../../state/githubRepos";
import { parseSessionLink, type SessionLink } from "../../views/issueLinks";

/** Rows the issue list renders; the arrow keys stay within them. */
const MAX_ISSUE_ROWS = 50;
const SEARCH_DELAY_MS = 300;

export type PickedIssue = SessionLink & { title?: string };

type Scope = "sprint" | "all";
type Row = { link: SessionLink; title?: string; detail?: string };

function toLink(repo: string, issue: RepoIssue): SessionLink {
  return { url: issue.url, kind: "Issue", repo, number: String(issue.number) };
}

function detail(issue: RepoIssue): string {
  return [issue.sprint, issue.assignees.map((a) => `@${a}`).join(" ")].filter(Boolean).join(" · ");
}

/**
 * Optional issues to link to a new session. Lists open issues of the folder's
 * GitHub repository, starting with the current sprint; a pasted URL or an
 * issue number also works.
 */
export function IssuePicker({ cwd, value, onChange }: { cwd: string; value: PickedIssue[]; onChange: (issues: PickedIssue[]) => void }) {
  const client = useStore((s) => s.client);
  const repo = useGithubRepo(cwd || undefined);
  const [issues, setIssues] = useState<{ repo: string; list: RepoIssue[] } | null>(null);
  const [error, setError] = useState("");
  const [scope, setScope] = useState<Scope>("sprint");
  const [text, setText] = useState("");
  const [found, setFound] = useState<{ query: string; list: RepoIssue[] } | null>(null);
  // The cursor belongs to the rows it was moved on; new rows start it at the top. Resetting it in an effect instead
  // left a moment where an arrow key pressed as the rows changed was undone by the reset that ran after it.
  const [cursor, setCursor] = useState<{ rows: unknown; index: number }>({ rows: null, index: 0 });
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIssues(null);
    setError("");
    if (!client || !repo) return;
    let cancelled = false;
    client.githubIssues(repo)
      .then((list) => !cancelled && setIssues({ repo, list }))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => { cancelled = true; };
  }, [client, repo]);

  // Beyond the loaded issues, search GitHub for what the user types.
  const query = text.trim();
  const searchable = scope === "all" && query.length >= 2 && !/^#?\d+$/.test(query) && !/^https?:/i.test(query);
  useEffect(() => {
    if (!client || !repo || !searchable) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      client.githubIssues(repo, query)
        .then((list) => !cancelled && setFound({ query, list }))
        .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    }, SEARCH_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, repo, query, searchable]);

  const loaded = issues && issues.repo === repo ? issues.list : null;
  const sprints = useMemo(() => [...new Set((loaded ?? []).flatMap((i) => i.sprint ? [i.sprint] : []))], [loaded]);

  const rows = useMemo<Row[]>(() => {
    if (!repo && !query) return [];
    const pasted = parseSessionLink(query, "Issue");
    if (pasted) return [{ link: pasted, title: loaded?.find((i) => i.url.toLowerCase() === pasted.url.toLowerCase())?.title }];
    const number = query.match(/^#?([1-9]\d*)$/)?.[1];
    if (repo && number) {
      const known = loaded?.find((i) => String(i.number) === number);
      return [known ? { link: toLink(repo, known), title: known.title, detail: detail(known) } : { link: { url: `https://github.com/${repo}/issues/${number}`, kind: "Issue", repo, number } }];
    }
    if (!repo || !loaded) return [];
    const needle = query.toLowerCase();
    const local = loaded.filter((i) => (scope === "all" || i.sprint) && (!needle || i.title.toLowerCase().includes(needle)));
    const remote = searchable && found?.query === query ? found.list : [];
    const seen = new Set<number>();
    const picked = new Set(value.map((issue) => issue.url.toLowerCase()));
    return [...local, ...remote]
      .filter((i) => !seen.has(i.number) && !!seen.add(i.number) && !picked.has(i.url.toLowerCase()))
      .slice(0, MAX_ISSUE_ROWS)
      .map((i) => ({ link: toLink(repo, i), title: i.title, detail: detail(i) }));
  }, [repo, query, loaded, scope, searchable, found, value]);

  const index = cursor.rows === rows ? cursor.index : 0;
  const setIndex = (next: number | ((i: number) => number)) => setCursor((c) => {
    const from = c.rows === rows ? c.index : 0;
    return { rows, index: typeof next === "function" ? next(from) : next };
  });
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(".list-item.active")?.scrollIntoView({ block: "nearest" });
  }, [index, rows]);

  const pick = (row: Row) => {
    if (!value.some((issue) => issue.url.toLowerCase() === row.link.url.toLowerCase())) onChange([...value, { ...row.link, title: row.title }]);
    setText("");
  };

  const loading = !!repo && !loaded && !error;
  return (
    <div className="field">
      <div className="issue-head">
        <label htmlFor="new-session-issue">Issues (optional)</label>
        {repo && (
          <div className="radio-row" role="radiogroup" aria-label="Issues to list">
            {(["sprint", "all"] as Scope[]).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={scope === s} className={clsx("btn small", scope === s && "primary")} data-command="new-session.issue-scope" onClick={() => setScope(s)}>
                {s === "sprint" ? `Current sprint${sprints.length === 1 ? ` · ${sprints[0]}` : ""}` : "All open"}
              </button>
            ))}
          </div>
        )}
      </div>
      {value.map((issue) => (
        <div key={issue.url} className="issue-picked">
          <span className="grow" title={issue.url}>{issue.repo} #{issue.number}{issue.title ? ` — ${issue.title}` : ""}</span>
          <button type="button" className="btn small" data-command="new-session.issue-clear" aria-label={`Remove ${issue.repo} #${issue.number}`}
            onClick={() => onChange(value.filter((other) => other.url !== issue.url))}>Remove</button>
        </div>
      ))}
      <input
        id="new-session-issue"
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={value.length ? "Add another issue" : repo ? `Search ${repo}, #number or paste a URL` : "Paste a GitHub issue URL"}
        spellCheck={false}
        autoComplete="off"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(rows.length - 1, i + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
          else if (e.key === "Enter" && !(e.metaKey || e.ctrlKey) && rows[index]) { e.preventDefault(); pick(rows[index]); }
        }}
      />
      {(repo || query) && (
        <div className="dir-browser issue-list" ref={list}>
          {rows.map((row, i) => (
            <button key={row.link.url} type="button" className={clsx("list-item", i === index && "active")} data-hint data-command="new-session.issue" tabIndex={-1} onMouseEnter={() => setIndex(i)} onClick={() => pick(row)}>
              <span className="dim">#{row.link.number}</span>
              <span className="grow">{row.title ?? (row.link.repo === repo ? "Link this issue" : row.link.repo)}</span>
              {row.detail && <span className="dim">{row.detail}</span>}
            </button>
          ))}
          {rows.length === 0 && (
            <div className="dim issue-empty">
              {error ? <span role="alert">Could not load issues: {error}</span>
                : loading ? "Loading issues…"
                : !repo ? "Not a GitHub issue URL"
                : scope === "sprint" && !query ? <>No open issues in the current sprint. <button type="button" className="btn small" data-command="new-session.issue-scope" onClick={() => setScope("all")}>Show all open</button></>
                : "No matching open issues"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
